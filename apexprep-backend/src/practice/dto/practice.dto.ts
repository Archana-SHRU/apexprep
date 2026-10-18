import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ATTEMPT_OUTCOMES,
  DEVICE_TYPES,
  PLACEMENT_STATUSES,
  SELECTION_REASONS,
  SESSION_EVENT_TYPES,
  SESSION_MODES,
  SESSION_STATUSES,
  type AttemptOutcome,
  type DeviceType,
  type PlacementStatus,
  type SelectionReasonValue,
  type SessionEventType,
  type SessionMode,
  type SessionStatus,
} from '../../database/schema';
import { StudentQuestionDto } from '../../questions/dto/questions.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ---------------------------------------------------------------- input

export class CreatePracticeSessionDto {
  @ApiProperty({ format: 'uuid', description: 'The sub-topic to practise. Practice is always scoped to one sub-topic.' })
  @IsUUID()
  subtopicId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, description: 'How many questions the student is aiming for in this sitting' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  targetQuestionCount?: number;

  @ApiPropertyOptional({ enum: DEVICE_TYPES, default: 'unknown' })
  @IsOptional()
  @IsIn(DEVICE_TYPES)
  deviceType?: DeviceType;
}

export class SubmitAttemptDto {
  @ApiProperty({ format: 'uuid', description: 'The served item being answered (from GET /practice/sessions/{id}/next)' })
  @IsUUID()
  sessionItemId!: string;

  @ApiProperty({
    type: Object,
    description:
      'The student\'s response: `{ "optionKeys": ["A"] }`, `{ "value": "4.2" }`, `{ "matrix": { "A": ["q"] } }` or `{ "text": "…" }`. Correctness is decided on the server; nothing about it is read from this payload.',
    example: { optionKeys: ['A'] },
  })
  @IsObject()
  response!: Record<string, unknown>;

  @ApiProperty({ minimum: 0, maximum: 86_400_000, description: 'Time spent on the question, in milliseconds' })
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  totalTimeMs!: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 86_400_000, description: 'Time to first interaction, in milliseconds' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  ttfiMs?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000, default: 0, description: 'How many times the student changed their answer' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  answerChanges?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 5, default: 0, description: 'How many hints were revealed' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  hintCount?: number;

  @ApiPropertyOptional({ format: 'date-time', description: "The client's own timestamp for the submission" })
  @IsOptional()
  @IsISO8601({ strict: true })
  clientSubmittedAt?: string;

  @ApiPropertyOptional({
    description: 'Idempotency key. Prefer the `Idempotency-Key` header; this field is the fallback for clients that cannot set headers.',
    minLength: 8,
    maxLength: 128,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9_.:-]{8,128}$/, { message: 'idempotencyKey must be 8-128 characters of letters, digits, _ . : or -' })
  idempotencyKey?: string;
}

export class SessionEventDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated id; a replayed batch is ignored' })
  @IsUUID()
  clientEventId!: string;

  @ApiProperty({ enum: SESSION_EVENT_TYPES })
  @IsIn(SESSION_EVENT_TYPES)
  eventType!: SessionEventType;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  occurredAt!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 86_400_000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  durationMs?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'The served item this event belongs to' })
  @IsOptional()
  @IsUUID()
  sessionItemId?: string;
}

export class SubmitSessionEventsDto {
  @ApiProperty({ type: [SessionEventDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SessionEventDto)
  events!: SessionEventDto[];
}

export class EndSessionDto {
  @ApiPropertyOptional({ enum: ['completed', 'abandoned'], default: 'completed' })
  @IsOptional()
  @IsIn(['completed', 'abandoned'])
  status?: 'completed' | 'abandoned';

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// ---------------------------------------------------------------- output

export class PracticeSessionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty({ enum: SESSION_MODES, description: '`placement` until the placement questions are done, then `adaptive`' })
  mode!: SessionMode;
  @ApiProperty({ enum: SESSION_STATUSES }) status!: SessionStatus;
  @ApiProperty() servedCount!: number;
  @ApiProperty() answeredCount!: number;
  @ApiProperty({ nullable: true, type: Number }) targetQuestionCount!: number | null;
  @ApiProperty({ description: 'Whether focus tracking is on for this session (organisation switch and student opt-out)' })
  focusTrackingEnabled!: boolean;
  @ApiProperty({ description: 'True when this call returned the session that was already open' }) resumed!: boolean;
  @ApiProperty({ description: 'True once the flagged-guess limit is reached; no further questions are served' }) paused!: boolean;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) endedAt!: string | null;
}

export class StudentProgressDto {
  @ApiProperty({ description: "The student's ability estimate for this sub-topic (Elo scale)" }) theta!: number;
  @ApiProperty({ minimum: 1, maximum: 5, description: 'Working level, maintained by the promotion/demotion ladder' }) level!: number;
  @ApiProperty() attemptsCount!: number;
  @ApiProperty() gradedCount!: number;
  @ApiProperty() correctCount!: number;
  @ApiProperty({ enum: PLACEMENT_STATUSES }) placementStatus!: PlacementStatus;
}

export class SessionStartDto {
  @ApiProperty({ type: PracticeSessionDto }) session!: PracticeSessionDto;
  @ApiProperty({ type: StudentProgressDto, description: "The student's ability in this sub-topic, seeded on a cold start" })
  progress!: StudentProgressDto;
  @ApiProperty({ description: 'θ points removed for inactivity when this session opened (0 when none)' }) decayApplied!: number;
}


export class ServedItemDto {
  @ApiProperty({ format: 'uuid', description: 'Pass this back when submitting the attempt' }) id!: string;
  @ApiProperty({ description: '1-based position within the session' }) position!: number;
  @ApiProperty({ enum: SELECTION_REASONS, description: 'Why the engine chose this question' }) selectionReason!: SelectionReasonValue;
  @ApiProperty({ format: 'date-time' }) servedAt!: string;
}

export class ContentGapDto {
  @ApiProperty({ description: 'How many questions were eligible for this student' }) eligibleCount!: number;
  @ApiProperty({ description: 'The minimum the engine wants before it considers the pool healthy' }) minEligible!: number;
  @ApiProperty({ description: 'Whether the pool was widened to the parent topic to find this question' }) widenedToParentTopic!: boolean;
}

export class NextQuestionDto {
  @ApiProperty({ type: ServedItemDto }) item!: ServedItemDto;
  @ApiProperty({ type: StudentQuestionDto, description: 'No answer key, no solution, no engine difficulty' }) question!: StudentQuestionDto;
  @ApiProperty({ type: PracticeSessionDto }) session!: PracticeSessionDto;
  @ApiProperty({ type: StudentProgressDto }) progress!: StudentProgressDto;
  @ApiPropertyOptional({ type: ContentGapDto, description: 'Present when the sub-topic has fewer eligible questions than the engine wants' })
  contentGap?: ContentGapDto;
}

export class LevelChangeDto {
  @ApiProperty({ enum: ['promoted', 'demoted', 'unchanged'] }) change!: 'promoted' | 'demoted' | 'unchanged';
  @ApiProperty({ nullable: true, type: String, description: 'Which ladder rule fired' }) rule!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'A guard that stopped an earned change (l1_protection, l5_ceiling)' })
  blockedBy!: string | null;
}

export class AttemptResultDto {
  @ApiProperty({ format: 'uuid' }) attemptId!: string;
  @ApiProperty({ format: 'uuid' }) questionId!: string;
  @ApiProperty({ description: 'The question version this was graded against' }) questionVersion!: number;
  @ApiProperty({ enum: ATTEMPT_OUTCOMES }) outcome!: AttemptOutcome;
  @ApiProperty({ nullable: true, type: Number, description: 'S ∈ [0,1]; null for an answer awaiting marking' }) score!: number | null;
  @ApiProperty({ nullable: true, type: Boolean, description: 'null for a long-form answer, which is not graded automatically' })
  correct!: boolean | null;
  @ApiProperty({
    type: Object,
    description: 'The answer key — the first and only place it is disclosed, after the attempt has been recorded.',
  })
  revealedAnswer!: Record<string, unknown>;
  @ApiProperty({ description: 'Whether an explanation can be fetched for this question' }) explanationAvailable!: boolean;
  @ApiProperty({ description: 'Incorrect and answered too fast: recorded, but excluded from the ability update' }) probableGuess!: boolean;
  // `expectedScore` is deliberately NOT returned to a student. E = 1/(1+10^((b−θ)/elo_scale)), and θ
  // is in `progress`, so publishing E lets the student solve for b exactly — and `difficulty_b` is
  // a column the student projection explicitly forbids. It is recorded on the attempt row and
  // available to admins and to the replay, which is where it belongs.
  @ApiProperty({ type: StudentProgressDto }) progress!: StudentProgressDto;
  @ApiProperty({ type: LevelChangeDto }) level!: LevelChangeDto;
  @ApiProperty({ type: PracticeSessionDto }) session!: PracticeSessionDto;
  @ApiProperty({ description: 'True when this key was already used: the stored attempt is returned unchanged' }) replayed!: boolean;
}

export class SessionEventsResultDto {
  @ApiProperty({ description: 'Events stored by this call (replays are ignored)' }) accepted!: number;
  @ApiProperty() received!: number;
}

export class RevealHintDto {
  @ApiProperty({ format: 'uuid', description: 'The served session item id' })
  @IsUUID()
  sessionItemId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 10, description: '1-based index of the hint requested' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  hintIndex?: number;
}

export class RevealedHintDto {
  @ApiProperty({ description: '1-based index of the revealed hint' })
  hintIndex!: number;

  @ApiProperty({ description: 'The hint text' })
  hintText!: string;

  @ApiProperty({ description: 'Total number of hints available for this question' })
  totalHints!: number;

  @ApiProperty({ description: 'Number of hints remaining to reveal' })
  hintsRemaining!: number;
}

