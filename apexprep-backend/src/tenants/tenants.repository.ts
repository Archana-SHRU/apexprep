import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { afterCursor, cursorTimestamp, type CursorPosition } from '../common/pagination/cursor';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { tenants, type TenantRow } from '../database/schema';

export type TenantPatch = Partial<
  Pick<TenantRow, 'name' | 'status' | 'selfRegistrationEnabled' | 'benchmarkingEnabled' | 'focusTrackingEnabled'>
>;

@Injectable()
export class TenantsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findBySlug(slug: string): Promise<TenantRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(and(eq(tenants.slug, slug), isNull(tenants.deletedAt)))
      .limit(1);
    return row;
  }

  async findById(id: string, tx: Executor = this.db): Promise<TenantRow | undefined> {
    const [row] = await tx
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, id), isNull(tenants.deletedAt)))
      .limit(1);
    return row;
  }

  async insert(values: typeof tenants.$inferInsert, tx: Executor = this.db): Promise<TenantRow> {
    const [row] = await tx.insert(tenants).values(values).returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async update(id: string, patch: TenantPatch, tx: Executor = this.db): Promise<TenantRow | undefined> {
    const [row] = await tx
      .update(tenants)
      .set(patch)
      .where(and(eq(tenants.id, id), isNull(tenants.deletedAt)))
      .returning();
    return row;
  }

  async list(limit: number, cursor?: CursorPosition): Promise<Array<TenantRow & { cursorTs: string }>> {
    const conditions: SQL[] = [isNull(tenants.deletedAt)];
    if (cursor) conditions.push(afterCursor(tenants.createdAt, tenants.id, cursor));
    const rows = await this.db
      .select({ tenant: tenants, cursorTs: cursorTimestamp(tenants.createdAt) })
      .from(tenants)
      .where(and(...conditions))
      .orderBy(desc(tenants.createdAt), desc(tenants.id))
      .limit(limit + 1);
    return rows.map((r) => ({ ...r.tenant, cursorTs: r.cursorTs }));
  }
}
