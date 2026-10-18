import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Env } from '../config/env.schema';
import * as schema from './schema';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction — repository methods accept either. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Pool({
          // TLS comes from `sslmode` in the URL, which `pg` parses: `verify-full` encrypts and
          // verifies the certificate, `disable` does neither, and **no sslmode at all means
          // cleartext**. Production must therefore say which it wants — env.schema.ts refuses to
          // boot without it — so the choice is never made by omission.
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
          application_name: 'apexprep-api',
          // Guard rails: a runaway query or an abandoned transaction cannot hold a connection forever.
          statement_timeout: 15_000,
          idle_in_transaction_session_timeout: 30_000,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle({ client: pool, schema }),
    },
  ],
  exports: [PG_POOL, DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
