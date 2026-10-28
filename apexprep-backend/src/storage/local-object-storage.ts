import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertSafeKey, StorageKeyError, type ObjectMetadata, type ObjectStorage, type PutObjectInput, type StoredObject } from './object-storage';

/**
 * Objects on the local filesystem, under `UPLOAD_DIR`.
 *
 * This is the development and single-node driver, and it is a real implementation rather than a
 * stand-in: uploads work, the pipeline reads the bytes back, and retention deletes them. In a
 * deployment with more than one API instance it must be swapped for a shared object store,
 * because a file written by one instance is not visible to another.
 *
 * Two layers of defence against a key escaping the root. `assertSafeKey` rejects anything that
 * is not a plain relative key, and then the resolved absolute path is checked to still be inside
 * the root — belt and braces, because a path check is cheap and a traversal is not recoverable.
 * The content type is not stored: a filesystem has nowhere to put it. `head` reports the type the
 * key's own extension implies, which is accurate for every key `buildAssetKey` produces, and the
 * database's `content_assets.mime_type` remains the authority either way.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    // No `flag: 'wx'`: a key is a fresh UUID, and a retried write of the same bytes must not fail.
    await writeFile(path, input.body);
    return { key: input.key, byteSize: input.body.byteLength, contentType: input.contentType };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() ? { byteSize: info.size, contentType: contentTypeOf(key) } : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /** The absolute path for a key, proven to be inside the root. */
  private pathFor(key: string): string {
    assertSafeKey(key);
    const path = resolve(join(this.root, key));
    const rel = relative(this.root, path);
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(this.root, rel) !== path) {
      throw new StorageKeyError(`object key ${JSON.stringify(key)} resolves outside the storage root`);
    }
    return path;
  }
}

/** The media type a key's extension implies. Only the types this system stores are listed. */
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function contentTypeOf(key: string): string {
  const dot = key.lastIndexOf('.');
  const ext = dot === -1 ? '' : key.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
