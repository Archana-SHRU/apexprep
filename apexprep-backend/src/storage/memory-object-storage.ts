import { assertSafeKey, type ObjectMetadata, type ObjectStorage, type PutObjectInput, type StoredObject } from './object-storage';

/**
 * Objects in a Map. Deterministic, with no filesystem and no credentials, so the whole test
 * suite runs without AWS and without touching a disk.
 *
 * It enforces exactly the same key rules as every other adapter — that is the point of it being
 * here rather than being a jest mock: a test that stores something under a traversal key fails
 * in the same way it would against a real provider.
 */
export class MemoryObjectStorage implements ObjectStorage {
  readonly driver = 'memory';
  private readonly objects = new Map<string, { body: Buffer; contentType: string; metadata: Record<string, string> }>();

  put(input: PutObjectInput): Promise<StoredObject> {
    return this.guard(input.key, () => {
      // Copied, so a caller reusing its buffer cannot mutate what is "stored".
      this.objects.set(input.key, {
        body: Buffer.from(input.body),
        contentType: input.contentType,
        metadata: { ...(input.metadata ?? {}) },
      });
      return { key: input.key, byteSize: input.body.byteLength, contentType: input.contentType };
    });
  }

  get(key: string): Promise<Buffer> {
    return this.guard(key, () => {
      const found = this.objects.get(key);
      if (!found) throw Object.assign(new Error(`no such object: ${key}`), { code: 'ENOENT' });
      return Buffer.from(found.body);
    });
  }

  head(key: string): Promise<ObjectMetadata | null> {
    return this.guard(key, () => {
      const found = this.objects.get(key);
      return found ? { byteSize: found.body.byteLength, contentType: found.contentType } : null;
    });
  }

  delete(key: string): Promise<void> {
    return this.guard(key, () => {
      this.objects.delete(key);
    });
  }

  /**
   * Checks the key and runs the operation, returning a rejected promise on either failure.
   *
   * A rejection and not a synchronous throw, because the filesystem adapter can only reject and a
   * caller that handles one must not have to handle the other. Two adapters behind one interface
   * have to fail the same way, or the interface is not one.
   */
  private guard<T>(key: string, run: () => T): Promise<T> {
    try {
      assertSafeKey(key);
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ------------------------------------------------------------ test helpers

  get size(): number {
    return this.objects.size;
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  metadataOf(key: string): Record<string, string> | undefined {
    return this.objects.get(key)?.metadata;
  }

  clear(): void {
    this.objects.clear();
  }
}
