import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LocalObjectStorage } from './local-object-storage';
import { MemoryObjectStorage } from './memory-object-storage';
import { OBJECT_STORAGE, type ObjectStorage } from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';

/**
 * Binds one storage driver from configuration. Everything downstream injects `OBJECT_STORAGE`
 * and never a concrete class, so adding S3 is a new adapter plus a case here.
 */
const storage: Provider = {
  provide: OBJECT_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): ObjectStorage => {
    const driver = config.get('STORAGE_DRIVER', { infer: true });
    if (driver === 'memory') return new MemoryObjectStorage();
    if (driver === 'local') return new LocalObjectStorage(config.get('UPLOAD_DIR', { infer: true }));
    if (driver === 's3') {
      return new S3ObjectStorage({
        bucket: config.get('S3_BUCKET', { infer: true })!,
        region: config.get('S3_REGION', { infer: true }),
        endpoint: config.get('S3_ENDPOINT', { infer: true }),
        accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true })!,
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true })!,
        forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      });
    }
    throw new Error(`Unsupported storage driver: ${driver}`);
  },
};

@Module({ providers: [storage], exports: [OBJECT_STORAGE] })
export class StorageModule {}
