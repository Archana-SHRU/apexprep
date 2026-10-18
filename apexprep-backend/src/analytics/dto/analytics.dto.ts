import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * A learner's own figures.
 *
 * Two conventions run through every DTO here, and the frontend depends on both:
 *
 * 1. **`null` means "no data", never "zero".** A learner who has answered nothing has no accuracy; a
 *    percentage of nothing is not 0%. Reporting 0 would tell a new learner they got everything wrong.
 *    Every nullable field below is nullable for that reason, and the UI renders `—`.
 *
 * 2. **Mastery is a level, not a percentage.** The requirements define mastery as "current θ mapped to the
 *    L1–L5 band" (§10) and define no 0-100 mastery figure, so none is returned. `level` is the band the
 *    adaptive engine maintains in `ability_scores.level`. A client may draw it as a bar — that is a visual
 *    encoding of a real value — but no percentage is computed here or expected to be computed anywhere.
 */

export const ANALYTICS_RANGES = ['7d', '30d', '90d', 'all'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ enum: ANALYTICS_RANGES, default: '30d', description: 'Window the figures are computed over' })
  @IsOptional()
  @IsIn(ANALYTICS_RANGES)
  range?: AnalyticsRange;

  @ApiPropertyOptional({ format: 'uuid', description: 'Restrict every figure to one subject' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;
}

// ---------------------------------------------------------------- summary

export class LearnerSummaryDto {
  @ApiProperty({ description: 'Attempts recorded today (UTC day)' }) solvedToday!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: "Accuracy over today's graded attempts, 0-100. Null when nothing has been graded today.",
  })
  todayAccuracy!: number | null;
  @ApiProperty({ description: 'Minutes spent on questions today, from recorded attempt times' }) studyMinutesToday!: number;
  @ApiProperty({
    description:
      'Consecutive days with at least one attempt, ending today or yesterday. Counted in UTC days — see analytics.math.ts.',
  })
  streakDays!: number;
  @ApiProperty({ nullable: true, type: Number, description: "The learner's own daily goal, if they set one" })
  dailyQuestionGoal!: number | null;
  @ApiProperty({ description: 'Attempts recorded in total, all time' }) questionsSolvedTotal!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Whole days until the learner’s target exam date. Null when no date is set; negative once it has passed.',
  })
  daysToTargetExam!: number | null;
}

// ---------------------------------------------------------------- analytics

export class LevelAccuracyDto {
  @ApiProperty({ minimum: 1, maximum: 5 }) level!: number;
  @ApiProperty() attempted!: number;
  @ApiProperty() correct!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Null when nothing at this level has been graded' })
  accuracy!: number | null;
}

export class TrendPointDto {
  @ApiProperty({ format: 'date', description: 'Monday (UTC) of the week' }) weekStart!: string;
  @ApiProperty() questions!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Null for a week with nothing graded — the week is still present' })
  accuracy!: number | null;
}

export class SubtopicPerformanceDto {
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty() subtopicName!: string;
  @ApiProperty() topicName!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty() questions!: number;
  @ApiProperty({ nullable: true, type: Number }) accuracy!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Median seconds per question, excluding probable guesses' })
  paceSeconds!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: 5,
    description: 'The L1–L5 band from ability_scores.level. Mastery is a band, not a percentage.',
  })
  level!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Whole days since the last attempt here' })
  lastPracticedDays!: number | null;
}

export class SubjectSummaryDto {
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) colorHex!: string | null;
  @ApiProperty() questions!: number;
  @ApiProperty({ nullable: true, type: Number }) accuracy!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Mean L1–L5 band across the sub-topics of this subject that have an ability row. Null when none do.',
  })
  level!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'Sub-topic with the highest accuracy here' })
  strongest!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Sub-topic with the lowest accuracy here' })
  needsReview!: string | null;
}

export class LearnerAnalyticsDto {
  @ApiProperty({ enum: ANALYTICS_RANGES }) range!: string;
  @ApiProperty({ nullable: true, type: Number }) overallAccuracy!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Percentage points against the preceding window of equal length. Null when either window has nothing graded.',
  })
  accuracyDelta!: number | null;
  @ApiProperty() questionsSolved!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Median seconds per question, excluding probable guesses' })
  paceSeconds!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: '§10 coverage: percentage of published sub-topics with at least 10 attempts. Null when the track has none.',
  })
  coveragePct!: number | null;
  @ApiProperty({ type: [LevelAccuracyDto], description: 'Always five rows, L1–L5' }) levelAccuracy!: LevelAccuracyDto[];
  @ApiProperty({ type: [TrendPointDto], description: 'Weekly, oldest first; empty weeks are present with accuracy null' })
  trend!: TrendPointDto[];
  @ApiProperty({ type: [SubtopicPerformanceDto], description: 'Lowest accuracy first, at most 5' }) weakSubtopics!: SubtopicPerformanceDto[];
  @ApiProperty({ type: [SubtopicPerformanceDto], description: 'Highest accuracy first, at most 5' }) strongSubtopics!: SubtopicPerformanceDto[];
  /**
   * Every sub-topic the learner has attempted, unranked.
   *
   * The two lists above are the top five of each end, which is what a dashboard panel wants. The syllabus
   * pages want something different: the learner's standing on *each* sub-topic they open, so a sub-topic
   * with real attempts is not shown as blank merely because it fell outside a top-five slice. A sub-topic
   * absent from this list has no attempts, and the client renders it as "no data" — never as zero.
   */
  @ApiProperty({
    type: [SubtopicPerformanceDto],
    description: 'Every sub-topic with at least one attempt in scope, unranked. Absent means no attempts.',
  })
  subtopicPerformance!: SubtopicPerformanceDto[];
  @ApiProperty({ type: [SubjectSummaryDto] }) subjectSummary!: SubjectSummaryDto[];
}

// ---------------------------------------------------------------- recommendations

export const RECOMMENDATION_KINDS = ['continue', 'practice', 'focus'] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export class RecommendationDto {
  @ApiProperty({
    enum: RECOMMENDATION_KINDS,
    description:
      '`continue` — where the learner last practised. `practice` — their weakest sub-topic with enough evidence. ' +
      '`focus` — a sub-topic they have not returned to. Each is a fact about their own attempts, not a prediction.',
  })
  kind!: RecommendationKind;
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty() subtopicName!: string;
  @ApiProperty() topicName!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty({ description: 'Published questions available in this sub-topic' }) questionCount!: number;
  @ApiProperty({ nullable: true, type: Number }) accuracy!: number | null;
  @ApiProperty({ nullable: true, type: Number, minimum: 1, maximum: 5 }) level!: number | null;
  @ApiProperty({ nullable: true, type: Number }) lastPracticedDays!: number | null;
  @ApiProperty({ description: 'Why this sub-topic, in one line the UI can show verbatim' }) reason!: string;
}

export class RecommendationsDto {
  @ApiProperty({ type: [RecommendationDto], description: 'At most three, and fewer when the evidence is not there' })
  items!: RecommendationDto[];
}
