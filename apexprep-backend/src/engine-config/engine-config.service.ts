import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { and, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseEngineParams, type EngineParams, type ParamIssue } from '../adaptive/engine-params';
import type { AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors/app-exception';
import { DRIZZLE, type Database, type Executor } from '../database/database.module';
import { engineConfig, type EngineConfigRow } from '../database/schema';
import { isUniqueViolation } from '../database/pg-error';
import { toEngineConfigDto, type CreateEngineConfigDto, type EngineConfigDto, type EngineConfigListDto } from './dto/engine-config.dto';

/**
 * Versioned engine configuration.
 *
 * A version is immutable once written (the database enforces it, AP001) and exactly one is
 * active per organisation. Creating, activating and deactivating all write audit rows from
 * inside the database, so a parameter change cannot bypass the audit trail.
 *
 * Reads that feed the engine validate the parameters in full and fail loudly
 * (`ENGINE_CONFIG_INVALID`, naming the keys) rather than substituting defaults.
 */

/** Just enough of the schema to start a new question off at the right difficulty. */
const initialBSchema = z.object({
  initial_b_by_level: z.object({
    '1': z.number().finite(),
    '2': z.number().finite(),
    '3': z.number().finite(),
    '4': z.number().finite(),
    '5': z.number().finite(),
  }),
});

export interface ActiveEngineConfig {
  id: string;
  version: number;
  params: EngineParams;
}

@Injectable()
export class EngineConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * `engine_config.created_by` and friends are tenant-scoped foreign keys, so a platform
   * administrator acting on someone else's organisation cannot be named in the row itself.
   * The column stays NULL (the database records the event as SYSTEM) and the service
   * writes an audit row that names the real actor, with a distinct action so the two are
   * never confused.
   */
  private actorFor(auth: AuthContext, tenantId: string): string | null {
    return auth.tenantId === tenantId ? auth.userId : null;
  }

  private async recordPlatformAction(auth: AuthContext, tenantId: string, action: string, entityId: string, after: Record<string, unknown>, tx: Executor): Promise<void> {
    if (auth.tenantId === tenantId) return;
    await this.audit.record({ tenantId, action, entityType: 'engine_config', entityId, after: { ...after, actingTenantId: auth.tenantId } }, tx);
  }

  // ---------------------------------------------------------------- reads

  async findActiveRow(tenantId: string, tx: Executor = this.db): Promise<EngineConfigRow | undefined> {
    const [row] = await tx
      .select()
      .from(engineConfig)
      .where(and(eq(engineConfig.tenantId, tenantId), eq(engineConfig.isActive, true)))
      .limit(1);
    return row;
  }

  private async requireActiveRow(tenantId: string, tx: Executor = this.db): Promise<EngineConfigRow> {
    const row = await this.findActiveRow(tenantId, tx);
    if (!row) {
      throw AppException.conflict(
        'This organisation has no active adaptive-engine configuration yet; a platform administrator must create one',
        'ENGINE_CONFIG_MISSING',
      );
    }
    return row;
  }

  /**
   * The validated parameters the engine runs on. Anything missing or malformed is an
   * error naming the key — never a substituted default.
   */
  async requireActive(tenantId: string, tx: Executor = this.db): Promise<ActiveEngineConfig> {
    const row = await this.requireActiveRow(tenantId, tx);
    const parsed = parseEngineParams(row.params);
    if (!parsed.ok) {
      throw AppException.unprocessable(
        `Active engine configuration v${row.version} is incomplete; the adaptive engine cannot run on it`,
        'ENGINE_CONFIG_INVALID',
        parsed.issues.map((i) => ({ field: i.field, message: i.message })),
      );
    }
    return { id: row.id, version: row.version, params: parsed.value };
  }

  /**
   * The active version's parameters exactly as stored, unvalidated.
   *
   * For features that validate their own slice of `params` rather than the whole adaptive
   * schema — the explanation system does, so that adding explanation settings cannot
   * invalidate a configuration the adaptive engine is happily running on. The caller is
   * responsible for parsing what it needs and failing loudly if it is missing.
   */
  async rawActiveParams(
    tenantId: string,
    tx: Executor = this.db,
  ): Promise<{ id: string; version: number; params: unknown; activatedAt: Date | null }> {
    const row = await this.requireActiveRow(tenantId, tx);
    // `activatedAt` comes back with the rest of the row because callers that need to know whether a
    // cached artefact predates the active configuration would otherwise ask for it in a second query
    // against the row they have just read.
    return { id: row.id, version: row.version, params: row.params, activatedAt: row.activatedAt ?? null };
  }

  /**
   * The validated parameters of one specific version, active or not. A replay of past
   * attempts has to run under the rules of the day, and each attempt records the version
   * it was graded under.
   */
  async paramsForVersion(tenantId: string, id: string, tx: Executor = this.db): Promise<EngineParams> {
    const [row] = await tx
      .select()
      .from(engineConfig)
      .where(and(eq(engineConfig.tenantId, tenantId), eq(engineConfig.id, id)))
      .limit(1);
    if (!row) throw AppException.notFound('Engine configuration version not found');
    const parsed = parseEngineParams(row.params);
    if (!parsed.ok) {
      throw AppException.unprocessable(
        `Engine configuration v${row.version} is incomplete, so attempts graded under it cannot be replayed`,
        'ENGINE_CONFIG_INVALID',
        parsed.issues.map((i) => ({ field: i.field, message: i.message })),
      );
    }
    return parsed.value;
  }

  /**
   * Starting `difficulty_b` for a new question. Only `initial_b_by_level` has to be valid
   * here, so authoring keeps working while other tunables are still being settled.
   */
  async initialDifficultyB(tenantId: string, label: number, tx: Executor = this.db): Promise<number> {
    const row = await this.requireActiveRow(tenantId, tx);
    const parsed = initialBSchema.safeParse(row.params);
    if (!parsed.success) {
      throw AppException.unprocessable(
        `Engine configuration v${row.version} has no usable initial_b_by_level, so question difficulty cannot be initialised`,
        'ENGINE_CONFIG_INVALID',
        parsed.error.issues.map((i) => ({ field: ['params', ...i.path.map(String)].join('.'), message: i.message })),
      );
    }
    return parsed.data.initial_b_by_level[String(label) as '1' | '2' | '3' | '4' | '5'];
  }

  async getActive(tenantId: string): Promise<EngineConfigDto> {
    const row = await this.requireActiveRow(tenantId);
    return this.toDto(row);
  }

  async listVersions(tenantId: string, limit = 50): Promise<EngineConfigListDto> {
    const rows = await this.db
      .select()
      .from(engineConfig)
      .where(eq(engineConfig.tenantId, tenantId))
      .orderBy(desc(engineConfig.version))
      .limit(limit);
    return { items: rows.map((r) => this.toDto(r)) };
  }

  async getVersion(tenantId: string, id: string): Promise<EngineConfigDto> {
    const [row] = await this.db
      .select()
      .from(engineConfig)
      .where(and(eq(engineConfig.tenantId, tenantId), eq(engineConfig.id, id)))
      .limit(1);
    if (!row) throw AppException.notFound('Engine configuration version not found');
    return this.toDto(row);
  }

  // ---------------------------------------------------------------- writes

  /**
   * Creates the next version for an organisation. Parameters are validated in full first:
   * a version that the engine could not run on is never stored.
   */
  async createVersion(auth: AuthContext, tenantId: string, dto: CreateEngineConfigDto): Promise<EngineConfigDto> {
    const parsed = parseEngineParams(dto.params);
    if (!parsed.ok) throw AppException.validation(parsed.issues.map((i) => ({ field: i.field, message: i.message })));

    try {
      const row = await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ max: max(engineConfig.version) })
          .from(engineConfig)
          .where(eq(engineConfig.tenantId, tenantId));
        const version = (current?.max ?? 0) + 1;

        if (dto.activate === true) await this.deactivateCurrent(auth, tenantId, tx);

        const actor = this.actorFor(auth, tenantId);
        const [created] = await tx
          .insert(engineConfig)
          .values({
            tenantId,
            version,
            params: dto.params,
            changeNote: dto.changeNote,
            createdBy: actor,
            isActive: dto.activate === true,
            activatedAt: dto.activate === true ? sql`now()` : null,
            activatedBy: dto.activate === true ? actor : null,
          })
          .returning();
        await this.recordPlatformAction(auth, tenantId, 'engine_config.platform_created', created!.id, { version, activated: dto.activate === true }, tx);
        return created!;
      });
      return this.toDto(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw AppException.conflict('Another configuration version was created at the same time; try again', 'CONFLICT');
      }
      throw err;
    }
  }

  /** Makes one stored version the active one. The previous active version is deactivated in the same transaction. */
  async activateVersion(auth: AuthContext, tenantId: string, id: string): Promise<EngineConfigDto> {
    const row = await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(engineConfig)
        .where(and(eq(engineConfig.tenantId, tenantId), eq(engineConfig.id, id)))
        .limit(1)
        .for('update');
      if (!target) throw AppException.notFound('Engine configuration version not found');
      if (target.isActive) throw AppException.conflict(`Version ${target.version} is already active`, 'INVALID_STATE');

      const parsed = parseEngineParams(target.params);
      if (!parsed.ok) {
        throw AppException.unprocessable(
          `Version ${target.version} is incomplete and cannot be activated`,
          'ENGINE_CONFIG_INVALID',
          parsed.issues.map((i) => ({ field: i.field, message: i.message })),
        );
      }

      await this.deactivateCurrent(auth, tenantId, tx);
      const [activated] = await tx
        .update(engineConfig)
        .set({ isActive: true, activatedAt: sql`now()`, activatedBy: this.actorFor(auth, tenantId), deactivatedAt: null, deactivatedBy: null })
        .where(and(eq(engineConfig.tenantId, tenantId), eq(engineConfig.id, id)))
        .returning();
      await this.recordPlatformAction(auth, tenantId, 'engine_config.platform_activated', activated!.id, { version: activated!.version }, tx);
      return activated!;
    });
    return this.toDto(row);
  }

  private async deactivateCurrent(auth: AuthContext, tenantId: string, tx: Executor): Promise<void> {
    await tx
      .update(engineConfig)
      .set({ isActive: false, deactivatedAt: sql`now()`, deactivatedBy: this.actorFor(auth, tenantId) })
      .where(and(eq(engineConfig.tenantId, tenantId), eq(engineConfig.isActive, true), isNull(engineConfig.deactivatedAt)));
  }

  private toDto(row: EngineConfigRow): EngineConfigDto {
    const parsed = parseEngineParams(row.params);
    const issues: ParamIssue[] = parsed.ok ? [] : parsed.issues;
    return toEngineConfigDto(row, issues);
  }
}
