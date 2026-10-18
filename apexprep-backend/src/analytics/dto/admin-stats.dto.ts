import { ApiProperty } from '@nestjs/swagger';

export class SubjectQuestionsStatDto {
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() trackName!: string;
  @ApiProperty({ nullable: true }) colorHex!: string | null;
  @ApiProperty() publishedCount!: number;
  @ApiProperty() totalCount!: number;
  @ApiProperty({ nullable: true }) questionCount?: number;
}

export class DailyPracticeVolumeDto {
  @ApiProperty({ example: '2026-10-05' }) date!: string;
  @ApiProperty() totalAttempts!: number;
  @ApiProperty() correctAttempts!: number;
  @ApiProperty() activeLearners!: number;
  @ApiProperty({ nullable: true }) attemptsCount?: number;
  @ApiProperty({ nullable: true }) uniqueLearners?: number;
}

export class LearnersStatsDto {
  @ApiProperty({ description: 'Total registered students' }) total!: number;
  @ApiProperty({ description: 'Active (non-disabled) students' }) active!: number;
  @ApiProperty({ description: 'Disabled students', nullable: true }) disabled?: number;
  @ApiProperty({ description: 'Students enrolled in at least one track' }) enrolled!: number;
  @ApiProperty({ description: 'Students who completed onboarding' }) onboarded!: number;
}

export class QuestionsStatsDto {
  @ApiProperty() total!: number;
  @ApiProperty() published!: number;
  @ApiProperty() draft!: number;
  @ApiProperty() retired!: number;
  @ApiProperty({ type: [SubjectQuestionsStatDto] }) bySubject!: SubjectQuestionsStatDto[];
}

export class PracticeStatsDto {
  @ApiProperty() totalAttempts!: number;
  @ApiProperty() todayAttempts!: number;
  @ApiProperty({ type: [DailyPracticeVolumeDto] }) dailyVolume!: DailyPracticeVolumeDto[];
  @ApiProperty({ nullable: true, type: [DailyPracticeVolumeDto] }) dailyPracticeVolume?: DailyPracticeVolumeDto[];
}

export class IngestionStatsDto {
  @ApiProperty() totalJobs!: number;
  @ApiProperty() successfulJobs!: number;
  @ApiProperty({ nullable: true }) publishedJobs?: number;
  @ApiProperty() failedJobs!: number;
  @ApiProperty({ nullable: true }) awaitingReviewJobs?: number;
  @ApiProperty({ nullable: true }) successRate!: number | null;
  @ApiProperty({ nullable: true }) successRatePct?: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() extractedQuestions!: number;
}

export class AdminStatsDto {
  @ApiProperty({ type: LearnersStatsDto }) learners!: LearnersStatsDto;
  @ApiProperty({ type: QuestionsStatsDto }) questions!: QuestionsStatsDto;
  @ApiProperty({ type: PracticeStatsDto }) practice!: PracticeStatsDto;
  @ApiProperty({ type: IngestionStatsDto }) ingestion!: IngestionStatsDto;
}
