import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

/**
 * The storage boundary.
 *
 * Deliberately shaped like an S3 object store — a flat key space, bytes plus a content type
 * and a little metadata, no directories and no rename — because that is the shape every
 * provider agrees on. Nothing above this file knows whether the bytes are on a local disk, in
 * S3, in R2 or in GCS: the ingestion pipeline stores a key and reads it back.
 *
 * What is NOT here, on purpose: no signed URLs, no ACLs, no bucket lifecycle. Those differ per
 * provider, and inventing a lowest common denominator for them would leak provider concepts
 * upward. When a signed URL is genuinely needed, it belongs on the adapter that can issue one.
 */

export interface StoredObject {
  key: string;
  byteSize: number;
  contentType: string;
  /** Provider-assigned version or entity tag, when the provider has one. */
  etag?: string;
}

export interface ObjectMetadata {
  byteSize: number;
  contentType: string;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  /** Small, non-secret annotations the provider stores alongside the object. */
  metadata?: Record<string, string>;
}

export interface ObjectStorage {
  /** The driver's name, for reporting and for the health endpoint. */
  readonly driver: string;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<ObjectMetadata | null>;
  /** Deleting is allowed where retention rules permit it; a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** DI token, so a test can bind the in-memory adapter without touching the modules above. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

/**
 * A key is accepted only if it is exactly what this module would have built.
 *
 * Every adapter validates with this before touching anything, which is what stops a key from
 * escaping its prefix. A local adapter joins the key onto a directory, so `../` in a key would
 * be a path traversal; an S3 adapter would happily create `../` as a literal object name and
 * quietly split the tenant's data across two prefixes. Neither is acceptable, so the rule is
 * the same everywhere: lowercase hex, digits, dashes, underscores, dots and slashes; no
 * segment may be empty, `.` or `..`; no leading slash; no backslash; no control characters or
 * whitespace; and a bounded length, because some providers cap keys.
 */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const STORAGE_KEY_MAX = 512;

export function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > STORAGE_KEY_MAX) {
    throw new StorageKeyError(`object key must be 1-${STORAGE_KEY_MAX} characters`);
  }
  if (key !== key.normalize('NFC')) throw new StorageKeyError('object key must be NFC-normalised');
  // Checked by code point rather than by a regular expression holding literal control characters:
  // `KEY_SEGMENT` below would reject these anyway, and this exists to say which rule was broken.
  for (const ch of key) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || ch === '\\') {
      throw new StorageKeyError('object key contains a control character or a backslash');
    }
  }
  if (key.startsWith('/') || key.endsWith('/')) throw new StorageKeyError('object key must not start or end with a slash');
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || !KEY_SEGMENT.test(segment)) {
      throw new StorageKeyError(`object key segment ${JSON.stringify(segment)} is not allowed`);
    }
  }
}

/**
 * The key an uploaded asset gets: `tenants/<tenant>/<kind>/<yyyy>/<mm>/<uuid><ext>`.
 *
 * The tenant prefix is first so a bucket policy or an IAM condition can be written per tenant,
 * and so a listing is naturally scoped. The name is a fresh UUID rather than the uploaded
 * filename: a filename is attacker-controlled, may collide, and may carry characters that mean
 * something to a filesystem. The original name is kept in the database
 * (`content_assets.original_filename`) where it is only ever data.
 */
export function buildAssetKey(input: { tenantId: string; kind: string; filename?: string | null; now?: Date }): string {
  const now = input.now ?? new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key = `tenants/${input.tenantId}/${input.kind}/${year}/${month}/${randomUUID()}${safeExtension(input.filename)}`;
  assertSafeKey(key);
  return key;
}

/** The uploaded name's extension, when it is a plain short one; otherwise none. */
function safeExtension(filename?: string | null): string {
  if (!filename) return '';
  const ext = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/** Lowercase hex SHA-256 of the bytes, which is what `content_assets.sha256` stores. */
export function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}
