import { S3ObjectStorage } from '../../src/storage/s3-object-storage';
import { StorageKeyError } from '../../src/storage/object-storage';

describe('S3ObjectStorage', () => {
  const options = {
    bucket: 'test-bucket',
    region: 'ap-south-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('initializes with required parameters', () => {
    const storage = new S3ObjectStorage(options);
    expect(storage.driver).toBe('s3');
  });

  it('refuses initialization with missing bucket or credentials', () => {
    expect(() => new S3ObjectStorage({ ...options, bucket: '' })).toThrow(/requires a bucket/);
    expect(() => new S3ObjectStorage({ ...options, accessKeyId: '' })).toThrow(/requires accessKeyId/);
  });

  it('refuses unsafe object keys', async () => {
    const storage = new S3ObjectStorage(options);
    await expect(
      storage.put({
        key: '../escape/test.pdf',
        body: Buffer.from('hello'),
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow(StorageKeyError);
  });

  it('correctly executes put, get, head, delete via mocked fetch', async () => {
    const originalFetch = globalThis.fetch;
    const storage = new S3ObjectStorage({
      ...options,
      endpoint: 'https://storage.example.com',
      forcePathStyle: true,
    });

    const mockPut = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"abcd1234"' }),
    });
    globalThis.fetch = mockPut;

    const key = 'tenants/11111111-1111-4111-8111-111111111111/source_pdf/2026/10/file.pdf';
    const putRes = await storage.put({
      key,
      body: Buffer.from('PDF content here'),
      contentType: 'application/pdf',
      metadata: { source: 'unit-test' },
    });

    expect(putRes.key).toBe(key);
    expect(putRes.byteSize).toBe(16);
    expect(putRes.etag).toBe('abcd1234');
    expect(mockPut).toHaveBeenCalledTimes(1);

    const [callUrl, callOpts] = mockPut.mock.calls[0];
    expect(callUrl).toContain('/test-bucket/tenants/');
    expect(callOpts.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/);
    expect(callOpts.headers['x-amz-meta-source']).toBe('unit-test');

    // HEAD
    const mockHead = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': '16',
        'content-type': 'application/pdf',
      }),
    });
    globalThis.fetch = mockHead;

    const headRes = await storage.head(key);
    expect(headRes).toEqual({
      byteSize: 16,
      contentType: 'application/pdf',
    });

    // HEAD not found
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    const head404 = await storage.head(key);
    expect(head404).toBeNull();

    // GET
    const sample = Buffer.from('PDF content here');
    const mockGet = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength),
    });
    globalThis.fetch = mockGet;

    const getRes = await storage.get(key);
    expect(getRes.toString()).toBe('PDF content here');

    // DELETE
    const mockDelete = jest.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });
    globalThis.fetch = mockDelete;

    await expect(storage.delete(key)).resolves.not.toThrow();

    globalThis.fetch = originalFetch;
  });
});
