import { createHash, createHmac } from 'node:crypto';
import { assertSafeKey, StorageKeyError, type ObjectMetadata, type ObjectStorage, type PutObjectInput, type StoredObject } from './object-storage';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * Production-ready S3-compatible object storage adapter.
 *
 * Implements Amazon S3 REST API with native AWS Signature Version 4 (SigV4)
 * using Node's standard crypto and fetch APIs — no external AWS SDK dependencies needed.
 * Compatible with AWS S3, Cloudflare R2, MinIO, Wasabi, and Google Cloud Storage S3 API.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3';

  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly forcePathStyle: boolean;

  constructor(options: S3StorageOptions) {
    if (!options.bucket) throw new Error('S3ObjectStorage requires a bucket');
    if (!options.accessKeyId || !options.secretAccessKey) {
      throw new Error('S3ObjectStorage requires accessKeyId and secretAccessKey');
    }
    this.bucket = options.bucket;
    this.region = options.region || 'us-east-1';
    this.endpoint = (options.endpoint ?? `https://s3.${this.region}.amazonaws.com`).replace(/\/+$/, '');
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.forcePathStyle = options.forcePathStyle ?? (options.endpoint !== undefined);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    assertSafeKey(input.key);
    const body = input.body;
    const contentType = input.contentType || 'application/octet-stream';
    const payloadHash = sha256Hex(body);

    const extraHeaders: Record<string, string> = {
      'content-type': contentType,
      'x-amz-content-sha256': payloadHash,
    };

    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        extraHeaders[`x-amz-meta-${k.toLowerCase()}`] = encodeURIComponent(v);
      }
    }

    const { url, headers } = this.signRequest('PUT', input.key, extraHeaders, payloadHash);

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`S3 PUT failed with status ${res.status}: ${errText}`);
    }

    const etag = res.headers.get('etag')?.replace(/"/g, '') || undefined;
    return {
      key: input.key,
      byteSize: body.byteLength,
      contentType,
      etag,
    };
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const payloadHash = sha256Hex(Buffer.alloc(0));
    const extraHeaders: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
    };

    const { url, headers } = this.signRequest('GET', key, extraHeaders, payloadHash);
    const res = await fetch(url, { method: 'GET', headers });

    if (res.status === 404) {
      throw Object.assign(new Error(`no such object: ${key}`), { code: 'ENOENT' });
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`S3 GET failed with status ${res.status}: ${errText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    assertSafeKey(key);
    const payloadHash = sha256Hex(Buffer.alloc(0));
    const extraHeaders: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
    };

    const { url, headers } = this.signRequest('HEAD', key, extraHeaders, payloadHash);
    const res = await fetch(url, { method: 'HEAD', headers });

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 HEAD failed with status ${res.status}`);
    }

    const contentLength = Number(res.headers.get('content-length') ?? 0);
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return {
      byteSize: contentLength,
      contentType,
    };
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const payloadHash = sha256Hex(Buffer.alloc(0));
    const extraHeaders: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
    };

    const { url, headers } = this.signRequest('DELETE', key, extraHeaders, payloadHash);
    const res = await fetch(url, { method: 'DELETE', headers });

    // S3 DELETE is idempotent; 204 or 404 are both success
    if (!res.ok && res.status !== 404) {
      const errText = await res.text().catch(() => '');
      throw new Error(`S3 DELETE failed with status ${res.status}: ${errText}`);
    }
  }

  /**
   * Builds the target URL and computes AWS Signature Version 4 headers.
   */
  private signRequest(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    extraHeaders: Record<string, string>,
    payloadHash: string,
  ): { url: string; headers: Record<string, string> } {
    const encodedKey = key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');

    let host: string;
    let path: string;
    let url: string;

    const endpointUrl = new URL(this.endpoint);

    if (this.forcePathStyle) {
      host = endpointUrl.host;
      path = `/${this.bucket}/${encodedKey}`;
      url = `${this.endpoint}${path}`;
    } else {
      host = `${this.bucket}.${endpointUrl.host}`;
      path = `/${encodedKey}`;
      url = `${endpointUrl.protocol}//${host}${path}`;
    }

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const headersToSign: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };

    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    const canonicalHeaders = sortedHeaderKeys.map((k) => `${k.toLowerCase()}:${(headersToSign[k] ?? '').trim()}\n`).join('');
    const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalRequest = [
      method,
      path,
      '', // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const canonicalRequestHash = sha256Hex(Buffer.from(canonicalRequest, 'utf8'));

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      canonicalRequestHash,
    ].join('\n');

    const signingKey = getSignatureKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = hmacHex(signingKey, stringToSign);

    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      url,
      headers: {
        ...headersToSign,
        authorization: authorizationHeader,
      },
    };
  }
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacHex(key: Buffer, stringToSign: string): string {
  return createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
}

function getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${key}`).update(dateStamp, 'utf8').digest();
  const kRegion = createHmac('sha256', kDate).update(regionName, 'utf8').digest();
  const kService = createHmac('sha256', kRegion).update(serviceName, 'utf8').digest();
  return createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
}
