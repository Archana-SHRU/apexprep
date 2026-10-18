import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { MockTestsService } from './mock-tests.service';

/**
 * Closes and grades mock-test papers whose deadline passed while nobody was looking.
 *
 * A paper is closed the first time anything touches it after its deadline, so a student who walks away would
 * otherwise have a paper that stays `in_progress` (and blocks starting the test again, and never shows in their
 * history) until they next open it. This sweep makes the server's deadline mean something on its own.
 *
 * Safe to run on every instance at once: closing happens under the session's row lock and is idempotent, so two
 * sweeps that reach the same paper close it once. `SWEEP_INTERVAL_SECONDS=0` turns it off.
 */
@Injectable()
export class MockTestSweep implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MockTestSweep.name);
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<number> | null = null;

  constructor(
    private readonly tests: MockTestsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.get('SWEEP_INTERVAL_SECONDS', { infer: true });
    if (seconds <= 0) return;
    this.timer = setInterval(() => void this.runOnce(), seconds * 1000);
    this.timer.unref();
    void this.runOnce();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy?.catch(() => undefined);
  }

  /** One pass. Never overlaps itself; never throws (a database blip is retried on the next tick). */
  runOnce(): Promise<number> {
    if (this.busy) return this.busy;
    this.busy = this.tests
      .finalizeExpiredSessions(200)
      .then((closed) => {
        if (closed > 0) this.logger.log(`closed ${closed} mock-test paper(s) past their deadline`);
        return closed;
      })
      .catch((error: unknown) => {
        this.logger.warn(`mock-test sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      })
      .finally(() => {
        this.busy = null;
      });
    return this.busy;
  }
}
