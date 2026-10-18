import { Module } from '@nestjs/common';
import { EngineConfigModule } from '../engine-config/engine-config.module';
import { UsersModule } from '../users/users.module';
import { AdminStatsController } from './admin-stats.controller';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { BenchmarkController } from './benchmark.controller';
import { BenchmarkRepository } from './benchmark.repository';
import { BenchmarkService } from './benchmark.service';
import { ReportPdfService } from './report-pdf.service';

/**
 * A learner's own figures, read from `attempts` and `ability_scores`,
 * plus anonymous peer benchmarks and performance reports.
 */
@Module({
  imports: [UsersModule, EngineConfigModule],
  controllers: [AnalyticsController, AdminStatsController, BenchmarkController],
  providers: [
    AnalyticsRepository,
    AnalyticsService,
    ReportPdfService,
    BenchmarkRepository,
    BenchmarkService,
  ],
  exports: [AnalyticsService, ReportPdfService, BenchmarkService],
})
export class AnalyticsModule {}
