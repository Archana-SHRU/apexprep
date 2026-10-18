import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Pool } from 'pg';
import { Public } from '../common/auth/decorators';
import { PG_POOL } from '../database/database.module';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Process is up. No dependencies checked — used for container liveness.
   *
   * The only route in the application exempt from rate limiting, because an orchestrator probes it
   * every few seconds and it touches nothing: no database, no I/O, a constant body.
   */
  @Get('live')
  @HttpCode(200)
  @SkipThrottle()
  @ApiOkResponse({ description: 'Process is running' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Dependencies reachable and schema migrated — used for readiness / load balancer checks.
   *
   * Rate-limited, unlike `/live`, because it queries the database: unauthenticated and unthrottled,
   * a plain request flood could hold every pooled connection without any limiter seeing it. The
   * default bucket is generous enough for any real probe interval.
   *
   * The body says *whether* the schema is migrated, never how many migrations there are. How far
   * along a deployment is tells an anonymous caller which release is running, and readiness does
   * not need to answer that.
   */
  @Get('ready')
  @ApiOkResponse({ description: 'Database reachable and migrations applied' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is not ready' })
  async ready(): Promise<{ status: 'ok'; database: 'ok'; migrated: true }> {
    try {
      const { rows } = await this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM schema_migrations');
      if (Number(rows[0]?.n ?? 0) === 0) throw new Error('no migrations applied');
      return { status: 'ok', database: 'ok', migrated: true };
    } catch {
      // Do not leak connection details in the response body.
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'unreachable_or_unmigrated' });
    }
  }
}
