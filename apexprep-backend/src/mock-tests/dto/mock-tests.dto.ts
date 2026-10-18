import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  TEST_ITEM_STATUSES,
  TEST_KINDS,
  TEST_SESSION_STATUSES,
  TEST_STATUSES,
  type TestItemStatus,
  type TestKind,
  type TestSessionStatus,
  type TestStatus,
} from '../../database/schema';
import { StudentQuestionDto } from '../../questions/dto/questions.dto';

export class MockTestAttemptSummaryDto {
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty({ enum: TEST_SESSION_STATUSES }) status!: TestSessionStatus;
  @ApiProperty() totalScore!: number;
  @ApiProperty() maxScore!: number;
  @ApiProperty() accuracy!: number;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) submittedAt!: string | null;
}

export class MockTestSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: TEST_KINDS }) kind!: TestKind;
  @ApiProperty() durationMinutes!: number;
  @ApiProperty() totalMarks!: number;
  @ApiProperty() defaultPositiveMarks!: number;
  @ApiProperty() defaultNegativeMarks!: number;
  @ApiProperty({ enum: TEST_STATUSES }) status!: TestStatus;
  @ApiProperty() questionCount!: number;
  @ApiProperty() sectionCount!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) instructions!: string | null;
  @ApiPropertyOptional({ type: MockTestAttemptSummaryDto, nullable: true })
  lastAttempt!: MockTestAttemptSummaryDto | null;
}

export class MockTestSectionDetailDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) subjectId!: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() questionCount!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) durationMinutes!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) instructions!: string | null;
}

export class MockTestDetailDto extends MockTestSummaryDto {
  @ApiProperty({ type: [MockTestSectionDetailDto] }) sections!: MockTestSectionDetailDto[];
  @ApiProperty({ type: [MockTestAttemptSummaryDto] }) pastAttempts!: MockTestAttemptSummaryDto[];
}

export class TestSessionQuestionDto {
  @ApiProperty({ format: 'uuid' }) testItemId!: string;
  @ApiProperty({ format: 'uuid' }) sectionId!: string;
  @ApiProperty() sectionName!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() positiveMarks!: number;
  @ApiProperty() negativeMarks!: number;
  @ApiProperty({ type: StudentQuestionDto }) question!: StudentQuestionDto;
  @ApiPropertyOptional({ type: Object, nullable: true }) currentResponse!: Record<string, unknown> | null;
  @ApiProperty({ enum: TEST_ITEM_STATUSES }) status!: TestItemStatus;
  @ApiProperty() timeSpentSec!: number;
}

export class TestSessionSectionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() sortOrder!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) durationMinutes!: number | null;
  @ApiProperty({ type: [TestSessionQuestionDto] }) questions!: TestSessionQuestionDto[];
}

export class TestSessionStateDto {
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty({ format: 'uuid' }) testId!: string;
  @ApiProperty() testTitle!: string;
  @ApiProperty({ enum: TEST_KINDS }) kind!: TestKind;
  @ApiProperty() durationMinutes!: number;
  @ApiProperty() totalMarks!: number;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty({ description: 'Remaining seconds until deadline' }) remainingSeconds!: number;
  @ApiProperty({ enum: TEST_SESSION_STATUSES }) status!: TestSessionStatus;
  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'The question the student last had open, so a refresh resumes where they were.' })
  activeTestItemId!: string | null;
  @ApiProperty({ type: [TestSessionSectionDto] }) sections!: TestSessionSectionDto[];
}

export class SubmitTestAnswerDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  testItemId!: string;

  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsObject()
  response!: Record<string, unknown> | null;

  @ApiProperty({ enum: TEST_ITEM_STATUSES })
  @IsIn(TEST_ITEM_STATUSES)
  status!: TestItemStatus;

  @ApiPropertyOptional({
    minimum: 0,
    deprecated: true,
    description: 'Ignored. Time spent is measured by the server from the focus endpoint; accepted only so older clients keep working.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  timeSpentSec?: number;
}

export class FocusTestItemDto {
  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'The question now open, or null when none is (for example the tab was closed).' })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  testItemId!: string | null;
}

export class SessionClockDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty({ description: 'Seconds left until the deadline, on the server clock.' }) remainingSeconds!: number;
}

export class SectionResultDto {
  @ApiProperty({ format: 'uuid' }) sectionId!: string;
  @ApiProperty() sectionName!: string;
  @ApiProperty() score!: number;
  @ApiProperty() maxScore!: number;
  @ApiProperty() correctCount!: number;
  @ApiProperty() incorrectCount!: number;
  @ApiProperty() unattemptedCount!: number;
  @ApiProperty() accuracy!: number;
  @ApiProperty() timeSpentSec!: number;
}

export class QuestionResultOptionDto {
  @ApiProperty() key!: string;
  @ApiProperty() text!: string;
  @ApiPropertyOptional() isCorrect?: boolean;
}

export class QuestionResultMatrixDto {
  @ApiProperty({ type: [QuestionResultOptionDto] }) left!: QuestionResultOptionDto[];
  @ApiProperty({ type: [QuestionResultOptionDto] }) right!: QuestionResultOptionDto[];
}

export class QuestionResultAnalysisDto {
  @ApiProperty({ format: 'uuid' }) testItemId!: string;
  @ApiProperty({ format: 'uuid' }) questionId!: string;
  @ApiProperty() sectionName!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() stem!: string;
  @ApiPropertyOptional({ type: Object, nullable: true }) stemJson!: Record<string, unknown> | null;
  @ApiProperty() type!: string;
  @ApiProperty({ type: [QuestionResultOptionDto] }) options!: QuestionResultOptionDto[];
  @ApiPropertyOptional({ type: QuestionResultMatrixDto }) matrix?: QuestionResultMatrixDto;
  @ApiProperty({ type: Object }) correctAnswer!: Record<string, unknown>;
  @ApiPropertyOptional({ type: Object, nullable: true }) studentResponse!: Record<string, unknown> | null;
  @ApiProperty({ enum: TEST_ITEM_STATUSES }) status!: TestItemStatus;
  @ApiProperty({ description: 'correct | incorrect | unattempted | partial | ungraded' }) outcome!: string;
  @ApiProperty() score!: number;
  @ApiProperty() positiveMarks!: number;
  @ApiProperty() negativeMarks!: number;
  @ApiProperty() timeSpentSec!: number;
  @ApiPropertyOptional({ type: Object, nullable: true })
  solution?: {
    body: string;
    finalAnswerText?: string | null;
  } | null;
}

export class TestResultDto {
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty({ format: 'uuid' }) testId!: string;
  @ApiProperty() testTitle!: string;
  @ApiProperty({ enum: TEST_KINDS }) kind!: TestKind;
  @ApiProperty({ enum: TEST_SESSION_STATUSES }) status!: TestSessionStatus;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) submittedAt!: string | null;
  @ApiProperty() timeSpentSec!: number;
  @ApiProperty({ description: 'The total after the floor at 0 that mock tests have always applied.' }) totalScore!: number;
  @ApiProperty({ description: 'The total before that floor, so a negative paper is visible rather than hidden.' }) rawScore!: number;
  @ApiProperty() maxScore!: number;
  @ApiProperty() percentage!: number;
  @ApiProperty() accuracy!: number;
  @ApiProperty() correctCount!: number;
  @ApiProperty() incorrectCount!: number;
  @ApiProperty() unattemptedCount!: number;
  @ApiProperty({ type: [SectionResultDto] }) sections!: SectionResultDto[];
  @ApiProperty({ type: [QuestionResultAnalysisDto] }) questions!: QuestionResultAnalysisDto[];
}
