import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalObjectStorage } from '../../src/storage/local-object-storage';
import { MemoryObjectStorage } from '../../src/storage/memory-object-storage';
import { assertSafeKey, buildAssetKey, sha256Hex, StorageKeyError, STORAGE_KEY_MAX, type ObjectStorage } from '../../src/storage/object-storage';

/**
 * Scenarios AJ and AK (section 20): object keys that cannot escape their prefix, and two adapters
 * that behave identically behind one interface.
 *
 * The same suite runs against both adapters. That is the point of the boundary: if an S3 adapter is
 * added, it joins this table and the pipeline above it does not change.
 */

describe('AK. a key is accepted only if it is exactly what this module would have built', () => {
  it.each([
    ['a parent-directory segment', 'tenants/t/source_pdf/../../etc/passwd'],
    ['a bare traversal', '../secret'],
    ['a current-directory segment', 'tenants/t/./x.pdf'],
    ['an absolute path', '/etc/passwd'],
    ['a trailing slash', 'tenants/t/'],
    ['a backslash', 'tenants\\t\\x.pdf'],
    ['an empty segment', 'tenants//x.pdf'],
    ['a space', 'tenants/t/my file.pdf'],
    ['an empty key', ''],
    ['a segment starting with a dot', 'tenants/t/.hidden'],
    ['a segment starting with a dash', 'tenants/t/-x.pdf'],
  ])('refuses %s', (_why, key) => {
    expect(() => assertSafeKey(key)).toThrow(StorageKeyError);
  });

  it('refuses a control character, whose error names the rule rather than the byte', () => {
    expect(() => assertSafeKey(`tenants/t/x${String.fromCharCode(1)}.pdf`)).toThrow(/control character/);
  });

  it('refuses a key that is not NFC-normalised, so two spellings cannot mean two objects', () => {
    const decomposed = 'tenants/t/café.pdf';
    expect(() => assertSafeKey(decomposed)).toThrow(/NFC/);
  });

  it('refuses a key longer than the cap some providers impose', () => {
    expect(() => assertSafeKey(`tenants/${'a'.repeat(STORAGE_KEY_MAX)}/x.pdf`)).toThrow(/characters/);
  });

  it('accepts the shape the pipeline actually builds', () => {
    expect(() => assertSafeKey('tenants/11111111-1111-4111-8111-111111111111/source_pdf/2026/09/abc-1_2.pdf')).not.toThrow();
  });
});

describe('AK. the object key is built, never taken from the upload', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';

  it('puts the tenant first, so a bucket policy can be written per organisation', () => {
    const key = buildAssetKey({ tenantId, kind: 'source_pdf', filename: 'chapter-3.pdf', now: new Date('2026-09-26T00:00:00Z') });
    expect(key).toMatch(new RegExp(`^tenants/${tenantId}/source_pdf/2026/09/[0-9a-f-]{36}\\.pdf$`));
  });

  it('never uses the uploaded filename as the object name', () => {
    const key = buildAssetKey({ tenantId, kind: 'source_pdf', filename: 'secrets.pdf' });
    expect(key).not.toContain('secrets');
  });

  it('gives two uploads of the same name two different keys', () => {
    const a = buildAssetKey({ tenantId, kind: 'source_pdf', filename: 'same.pdf' });
    const b = buildAssetKey({ tenantId, kind: 'source_pdf', filename: 'same.pdf' });
    expect(a).not.toBe(b);
  });

  it.each([
    ['a traversal in the name', '../../../etc/passwd'],
    ['a null byte', 'x\u0000.pdf'],
    ['a long fake extension', 'x.pdfpdfpdfpdfpdf'],
    ['no extension at all', 'plainname'],
  ])('produces a safe key from %s', (_why, filename) => {
    const key = buildAssetKey({ tenantId, kind: 'source_pdf', filename });
    expect(() => assertSafeKey(key)).not.toThrow();
    expect(key.split('/')).toHaveLength(6);
  });

  it('hashes the bytes, which is the duplicate key', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex(Buffer.from('abc')));
    expect(sha256Hex(Buffer.from('abd'))).not.toBe(sha256Hex(Buffer.from('abc')));
  });
});

describe('AJ. the adapters behave the same behind one interface', () => {
  let directory: string;
  const adapters: [string, () => ObjectStorage][] = [
    ['memory', () => new MemoryObjectStorage()],
    ['local', () => new LocalObjectStorage(directory)],
  ];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'apexprep-storage-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  describe.each(adapters)('%s', (_name, make) => {
    const key = 'tenants/11111111-1111-4111-8111-111111111111/source_pdf/2026/09/abcdef.pdf';

    it('stores and reads back the exact bytes', async () => {
      const storage = make();
      const body = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
      const stored = await storage.put({ key, body, contentType: 'application/pdf' });
      expect(stored.byteSize).toBe(body.byteLength);
      expect(await storage.get(key)).toEqual(body);
    });

    it('reports what it holds, and nothing for a key it does not', async () => {
      const storage = make();
      await storage.put({ key, body: Buffer.from('x'), contentType: 'application/pdf' });
      expect(await storage.head(key)).toEqual({ byteSize: 1, contentType: 'application/pdf' });
      expect(await storage.head('tenants/t/source_pdf/2026/09/missing.pdf')).toBeNull();
    });

    it('deletes, and treats deleting a missing key as already done', async () => {
      const storage = make();
      await storage.put({ key, body: Buffer.from('x'), contentType: 'application/pdf' });
      await storage.delete(key);
      expect(await storage.head(key)).toBeNull();
      await expect(storage.delete(key)).resolves.toBeUndefined();
    });

    it('fails on reading a key it does not hold, rather than returning empty bytes', async () => {
      await expect(make().get(key)).rejects.toThrow();
    });

    it('refuses an unsafe key on every operation, not only on write', async () => {
      const storage = make();
      const unsafe = '../escape.pdf';
      await expect(storage.put({ key: unsafe, body: Buffer.from('x'), contentType: 'application/pdf' })).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.get(unsafe)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.head(unsafe)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.delete(unsafe)).rejects.toBeInstanceOf(StorageKeyError);
    });

    it('names its driver, so the health endpoint can report which one is bound', () => {
      expect(make().driver).toMatch(/\S/);
    });
  });
});
