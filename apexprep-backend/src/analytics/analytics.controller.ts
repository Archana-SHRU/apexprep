import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../common/auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../common/auth/decorators';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto, LearnerAnalyticsDto, LearnerSummaryDto, RecommendationsDto, type AnalyticsRange } from './dto/analytics.dto';

/**
 * A learner's own figures.
 *
 * `analytics:own` throughout — a permission the role map has granted STUDENT since Phase 2 and which no
 * controller had used until now. It means exactly what its name says: a learner's own data, never anyone
 * else's. The learner is taken from the verified JWT, so there is no id in any path or query that could
 * point at another learner, and no endpoint here accepts a user id at all.
 *
 * Read-only. Nothing here writes, and nothing here recomputes what the adaptive engine has already
 * decided — `level` is read from `ability_scores`.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('summary')
  @RequirePermissions('analytics:own')
  @ApiOperation({
    summary: 'Today at a glance: streak, questions solved, accuracy and time',
    description:
      'Every field is a count or a ratio of counts over the learner’s own attempts. `todayAccuracy` is null — not 0 — ' +
      'when nothing has been graded today, because a learner who has not started has no accuracy. Days are UTC days.',
  })
  @ApiOkResponse({ type: LearnerSummaryDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'Not a learner account' })
  summary(@CurrentAuth() auth: AuthContext): Promise<LearnerSummaryDto> {
    return this.service.summary(auth);
  }

  @Get('analytics')
  @RequirePermissions('analytics:own')
  @ApiOperation({
    summary: 'Accuracy, pace, coverage, per-level accuracy, a weekly trend and per-subject standing',
    description:
      'Computed from `attempts` and `ability_scores`. Mastery appears as the L1–L5 `level` the engine maintains, ' +
      'not as a percentage — the requirements define mastery as θ mapped to a band and define no percentage, so none ' +
      'is returned. Empty weeks and unattempted levels are present with `accuracy: null` so a chart cannot draw over a gap.',
  })
  @ApiOkResponse({ type: LearnerAnalyticsDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'Not a learner account' })
  analytics(@CurrentAuth() auth: AuthContext, @Query() query: AnalyticsQueryDto): Promise<LearnerAnalyticsDto> {
    return this.service.analytics(auth, { range: query.range, subjectId: query.subjectId });
  }

  @Get('recommendations')
  @RequirePermissions('analytics:own')
  @ApiOperation({
    summary: 'Up to three sub-topics worth opening next',
    description:
      'Each item is a fact about the learner’s own attempts with the reason stated: where they last practised, their ' +
      'lowest-accuracy sub-topic with enough evidence, and the one they have left longest. A learner with no history ' +
      'gets an empty list rather than a suggestion invented for them.',
  })
  @ApiOkResponse({ type: RecommendationsDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'Not a learner account' })
  recommendations(@CurrentAuth() auth: AuthContext): Promise<RecommendationsDto> {
    return this.service.recommendations(auth);
  }

  @Get(['reports/export.pdf', 'reports/export'])
  @RequirePermissions('analytics:own')
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Export student performance and subtopic diagnostic report as a PDF document',
    description: 'Generates a PDF summary of overall metrics, mastery levels, and subtopic accuracy.',
  })
  @ApiOkResponse({ description: 'The generated PDF report stream' })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'Not a learner account' })
  async exportReport(
    @CurrentAuth() auth: AuthContext,
    @Query('range') range?: string,
  ): Promise<StreamableFile> {
    const validRange: AnalyticsRange = range === '7d' || range === '30d' || range === '90d' ? range : 'all';
    const buffer = await this.service.exportReportPdf(auth, validRange);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: 'attachment; filename="apexprep-performance-report.pdf"',
    });
  }
}
