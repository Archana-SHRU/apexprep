import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { DRIZZLE, type Database } from '../../database/database.module';
import type { PurgeEventsResultDto } from './dto/maintenance.dto';

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Purges raw focus-tracking and practice session events older than the retention threshold
   * (default 365 days / 12 months) per DPDP requirements (§15.2 / E5).
   * Aggregated student statistics, scores, and attempt histories remain untouched.
   */
  async purgeOldSessionEvents(auth: AuthContext, olderThanDays = 365): Promise<PurgeEventsResultDto> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);

    const result = await this.db.execute<{ count: string | number }>(sql`
      WITH deleted AS (
        DELETE FROM session_events
        WHERE tenant_id = ${auth.tenantId}
          AND occurred_at < ${cutoff}
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM deleted
    `);

    const purgedCount = Number(result.rows[0]?.count ?? 0);

    await this.audit.record({
      tenantId: auth.tenantId,
      action: 'maintenance.session_events_purged',
      entityType: 'session_events',
      entityId: auth.tenantId,
      after: {
        olderThanDays,
        cutoffDate: cutoff.toISOString(),
        purgedCount,
      },
    });

    this.logger.log(`Purged ${purgedCount} raw session events older than ${olderThanDays} days for tenant ${auth.tenantId}`);

    return {
      purgedCount,
      cutoffDate: cutoff.toISOString(),
      tenantId: auth.tenantId,
    };
  }
}
