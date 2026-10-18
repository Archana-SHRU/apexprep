import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ValidatedNotes } from '../../learning-ai/notes/notes.validation';
import {
  BLOCK_FORMATS,
  BLOCK_KINDS,
  BLOCK_STATUSES,
  JOB_STATUSES,
  QUESTION_TYPES,
  type BlockFormat,
  type BlockStatus,
  type JobStatus,
  type QuestionType,
} from '../../database/schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ---------------------------------------------------------------- input

export class UploadAssetDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Track hint: narrows syllabus mapping and is shown to the reviewer.' })
  @IsOptional()
  @IsUUID()
  trackId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Subject hint. Must sit under `trackId` when both are given.' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Free text for the reviewer: what this document is and where it came from.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  hint?: string;
}

export class ListJobsQueryDto {
  @ApiPropertyOptional({ enum: JOB_STATUSES })
  @IsOptional()
  @IsIn(JOB_STATUSES)
  status?: JobStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ReviewBlockDto {
  @ApiPropertyOptional({ maxLength: 2000, description: 'Why. Required when rejecting: a rejection without a reason is not reviewable.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** The reviewer-settable part of an extracted question. Everything is optional: this is a patch. */
export class QuestionProposalPatchDto {
  @ApiPropertyOptional({ enum: QUESTION_TYPES, description: 'Change what kind of question this is, when the pipeline read it wrongly.' })
  @IsOptional()
  @IsIn(QUESTION_TYPES)
  type?: QuestionType;

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 20000)
  stem?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'L1-L5. Required before a question can be published.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  difficultyLabel?: number;

  @ApiPropertyOptional({ minimum: 5, maximum: 7200 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(7200)
  expectedTimeSeconds?: number;

  @ApiPropertyOptional({ type: [Object], description: 'Replaces every option: `[{ key, text, isCorrect }]`.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  options?: { key: string; text: string; isCorrect: boolean }[];

  @ApiPropertyOptional({ type: Object, description: 'integer and numeric only: `{ value, tolerance?, mode? }`.' })
  @IsOptional()
  @IsObject()
  numericAnswer?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'The reviewer has checked the answer key as it stands (typically one a model proposed) and says it is right.' })
  @IsOptional()
  @IsBoolean()
  confirmAnswer?: boolean;

  @ApiPropertyOptional({ description: "Accept the suggested difficulty and expected time where none is set. Nothing suggested counts until this is done." })
  @IsOptional()
  @IsBoolean()
  acceptSuggested?: boolean;

  @ApiPropertyOptional({ description: 'The question refers to a figure that could not be extracted; the reviewer says it may publish without it.' })
  @IsOptional()
  @IsBoolean()
  diagramAcknowledged?: boolean;
}

/** The notes of a learning draft, as the reviewer edited them. Validated for shape; the draft keeps who wrote what. */
export class DraftPatchDto {
  @ApiProperty({ type: Object, description: 'The whole notes object: title, overview, keyPoints, concepts, formulas, commonMistakes, quickRevision.' })
  @IsObject()
  notes!: ValidatedNotes;
}

export class BlockPatchDto {
  @ApiPropertyOptional({ maxLength: 100000, description: 'The corrected text. Every call is a save, so a client may PATCH as the reviewer types.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100000)
  text?: string;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  title?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'An existing published sub-topic. Ingestion never creates one.' })
  @IsOptional()
  @IsUUID()
  subtopicId?: string;

  @ApiPropertyOptional({ type: QuestionProposalPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuestionProposalPatchDto)
  question?: QuestionProposalPatchDto;

  @ApiPropertyOptional({ maxLength: 50000, description: 'The solution matched to this question: its text, written or corrected by the reviewer.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 50000)
  solutionText?: string;

  @ApiPropertyOptional({ type: DraftPatchDto, description: 'For a drafted revision-notes block: the edited notes.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => DraftPatchDto)
  draft?: DraftPatchDto;
}

export class ReclassifyBlockDto {
  @ApiProperty({ enum: BLOCK_KINDS, description: 'What this block actually is. The way an `ambiguous` block becomes usable.' })
  @IsIn(BLOCK_KINDS)
  kind!: 'theory' | 'question' | 'solution' | 'ambiguous';

  @ApiPropertyOptional({ enum: BLOCK_FORMATS })
  @IsOptional()
  @IsIn(BLOCK_FORMATS)
  format?: BlockFormat;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class MergeBlocksDto {
  @ApiProperty({ type: [String], format: 'uuid', minItems: 2, maxItems: 20, description: 'Merged into the first in reading order; the rest are kept and point at it.' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  blockIds!: string[];
}

export class SplitPieceDto {
  @ApiProperty({ maxLength: 100000 })
  @Transform(trim)
  @IsString()
  @Length(1, 100000)
  text!: string;

  @ApiPropertyOptional({ enum: BLOCK_KINDS })
  @IsOptional()
  @IsIn(BLOCK_KINDS)
  kind?: 'theory' | 'question' | 'solution' | 'ambiguous';

  @ApiPropertyOptional({ enum: BLOCK_FORMATS })
  @IsOptional()
  @IsIn(BLOCK_FORMATS)
  format?: BlockFormat;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  subtopicId?: string;
}

export class SplitBlockDto {
  @ApiProperty({ type: [SplitPieceDto], minItems: 2, maxItems: 20 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SplitPieceDto)
  pieces!: SplitPieceDto[];
}

export class UnpublishBlockDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;
}

// ---------------------------------------------------------------- output

export class UploadAssetResultDto {
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty({ format: 'uuid', description: 'The ingestion job now queued for this asset' }) jobId!: string;
  @ApiProperty({ description: 'Lowercase hex SHA-256 of the bytes: the duplicate key' }) sha256!: string;
  @ApiProperty() pageCount!: number;
  @ApiProperty() byteSize!: number;
  @ApiProperty({ description: 'The object-storage key. Never a URL, never a filesystem path the client could use.' })
  storageKey!: string;
  @ApiProperty({ description: "The queue's own id for the job" }) queueJobId!: string;
}

export class IngestionJobDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty({ enum: JOB_STATUSES, description: 'The stage it is in, or `failed`/`cancelled`' }) status!: JobStatus;
  @ApiProperty({ minimum: 0, maximum: 100 }) progressPct!: number;
  @ApiProperty({ description: 'How many times this job has been run' }) attemptCount!: number;
  @ApiProperty() pagesTotal!: number;
  @ApiProperty({ description: 'How many pages needed OCR because their text layer was too thin' }) pagesOcr!: number;
  @ApiProperty({ type: Object, description: 'Blocks produced, by kind' }) blocks!: Record<string, number>;
  @ApiProperty({ nullable: true, type: String, description: 'A stable code, not a message' }) errorCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) errorMessage!: string | null;
  @ApiProperty({ description: 'Open review tasks this job produced' }) openReviewTasks!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) finishedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    nullable: true,
    type: Object,
    description:
      'What syllabus-hierarchy detection found: `status` is `detected`, `needs_review` (the PDF does not state its structure — ' +
      'nothing was invented) or `not_applicable` (no subject was named), with the method, counts and notes. Null before processing.',
  })
  hierarchy!: Record<string, unknown> | null;
}

export class IngestionJobListDto {
  @ApiProperty({ type: [IngestionJobDto] }) items!: IngestionJobDto[];
}

export class GateFailureDto {
  @ApiProperty({ description: 'Which gate' }) gate!: string;
  @ApiProperty() detail!: string;
}

export class ReviewedBlockDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) jobId!: string | null;
  @ApiProperty({ enum: BLOCK_KINDS }) kind!: string;
  @ApiProperty({ enum: BLOCK_FORMATS }) format!: string;
  @ApiProperty({ enum: BLOCK_STATUSES }) status!: BlockStatus;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty() text!: string;
  @ApiProperty({ description: 'The text exactly as the PDF gave it. The same as `text` unless a faithful rewrite replaced it.' }) originalText!: string;
  @ApiProperty({ nullable: true, type: Number, description: 'The page of the source PDF this came from' }) sourcePage!: number | null;
  @ApiProperty({ description: 'Position in the document, so reading order survives' }) sortOrder!: number;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) subtopicId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) classificationConfidence!: number | null;
  @ApiProperty({ nullable: true, type: Number }) taggingConfidence!: number | null;
  @ApiProperty({ description: 'True when this text came from OCR, which always needs a person' }) fromOcr!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) reviewedBy!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) reviewedAt!: string | null;
  @ApiProperty({ description: 'A person has looked at the content (not merely chosen its sub-topic).' }) contentReviewed!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'Set when this block was merged into another' })
  mergedIntoId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'Set when this block came out of a split' })
  splitFromId!: string | null;
  @ApiProperty() openReviewTasks!: number;
  @ApiProperty({ description: 'Whether it would pass the publication gates right now' }) publishable!: boolean;
  @ApiProperty({ type: [GateFailureDto], description: 'What is stopping it, when it is not publishable' })
  gateFailures!: { gate: string; detail: string }[];
  @ApiProperty({
    enum: ['ready', 'flagged', 'blocked', 'done', 'excluded'],
    description:
      'Where it stands for the single approval: ready (publishes), flagged (publishes once confirmed), blocked (needs an edit), done, or excluded.',
  })
  readiness!: 'ready' | 'flagged' | 'blocked' | 'done' | 'excluded';
  @ApiProperty({ type: [String], description: 'Why it is flagged or blocked, in words' }) readinessReasons!: string[];
  @ApiProperty({
    type: Object,
    description: 'Extracted, AI-assisted or AI-generated; what was inferred rather than printed; whether a person edited it; who classified it.',
  })
  provenance!: {
    origin: 'extracted' | 'ai_assisted' | 'ai_generated';
    ai: { task: string; provider: string; model: string; at: string; textDecision?: string } | null;
    inferred: string[];
    edited: boolean;
    classifiedBy: string | null;
  };
  @ApiProperty({ nullable: true, type: Object, description: 'The extracted question, for a question block' })
  question!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: Object, description: 'The solution matched to this question: text, confidence, whether the match is confirmed' })
  solution!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: Object, description: 'For a drafted revision-notes block: the notes, what they were written from, and whether they were activated' })
  draft!: Record<string, unknown> | null;
  @ApiProperty({ type: Object, description: 'What the machine concluded and why: classification, mapping, auto-approval, source' })
  machineNotes!: Record<string, unknown>;
  @ApiProperty({ description: 'Whether the pipeline judged this eligible for approval without a person' })
  autoApprovalEligible!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Why it was mapped where it was (or why it is not mapped)' })
  mappingReason!: string | null;
  @ApiProperty({ nullable: true, type: Number }) mappingConfidence!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'Chapter heading the PDF prints above this block' }) suggestedChapter!: string | null;
  @ApiProperty({ nullable: true, type: String }) suggestedTopic!: string | null;
  @ApiProperty({ nullable: true, type: String }) suggestedSubtopic!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'The syllabus suggestion this block is waiting on' })
  suggestionId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) existingChapterId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) existingTopicId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) existingSubtopicId!: string | null;
  @ApiProperty({ type: [Object], description: 'Other existing sub-topics the text resembles, best first' })
  alternatives!: { subtopicId: string; score: number }[];
}

// ---------------------------------------------------------------- syllabus suggestions

export class ApproveSuggestionDto {
  @ApiPropertyOptional({ maxLength: 200, description: 'Edited chapter name. New names must appear in the uploaded PDF.' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, 200, { message: 'chapterName must be 1-200 characters' })
  chapterName?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, 200, { message: 'topicName must be 1-200 characters' })
  topicName?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, 200, { message: 'subtopicName must be 1-200 characters' })
  subtopicName?: string;
}

export class RejectSuggestionDto {
  @ApiPropertyOptional({ maxLength: 2000, description: 'Why, for the record' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(2000)
  reason?: string;
}

export class SuggestionLevelDto {
  @ApiProperty({ nullable: true, type: String, description: 'The name (null when the PDF does not state this level)' }) name!: string | null;
  @ApiProperty({ enum: ['existing', 'new', 'unresolved'] }) state!: 'existing' | 'new' | 'unresolved';
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) existingId!: string | null;
  @ApiProperty({ nullable: true, type: String }) existingName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Status of the existing node; a draft is published on approval' }) existingStatus!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'The node approval created, if it created one' }) createdId!: string | null;
  @ApiProperty({ nullable: true, type: Object, description: 'The heading line and page it came from' }) evidence!: Record<string, unknown> | null;
}

export class SyllabusSuggestionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid', description: 'The upload that first proposed it' }) jobId!: string;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) status!: string;
  @ApiProperty({ format: 'uuid' }) trackId!: string;
  @ApiProperty() trackName!: string;
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ type: SuggestionLevelDto }) chapter!: SuggestionLevelDto;
  @ApiProperty({ type: SuggestionLevelDto }) topic!: SuggestionLevelDto;
  @ApiProperty({ type: SuggestionLevelDto }) subtopic!: SuggestionLevelDto;
  @ApiProperty() confidence!: number;
  @ApiProperty() mappingReason!: string;
  @ApiProperty({ type: Object, description: 'Detection method and notes' }) evidence!: Record<string, unknown>;
  @ApiProperty({ description: 'Blocks of this upload waiting on it' }) linkedBlocks!: number;
  @ApiProperty({ description: 'True when a level is unresolved: approval then needs that name entered' }) needsNames!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) reviewedBy!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) reviewedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) rejectionReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class SyllabusSuggestionListDto {
  @ApiProperty({ nullable: true, type: Object, description: "The job's hierarchy-detection summary (see IngestionJobDto.hierarchy)" })
  hierarchy!: Record<string, unknown> | null;
  @ApiProperty({ type: [SyllabusSuggestionDto] }) suggestions!: SyllabusSuggestionDto[];
}

export class ApprovedSuggestionDto {
  @ApiProperty({ type: SyllabusSuggestionDto }) suggestion!: SyllabusSuggestionDto;
  @ApiProperty({ format: 'uuid', description: 'The sub-topic the linked blocks now sit under' }) subtopicId!: string;
  @ApiProperty({ description: 'Blocks that received the sub-topic. They still need the normal approve → publish.' }) blocksMapped!: number;
  @ApiProperty({ type: [String], description: 'Levels created by this approval' }) created!: string[];
}

/** What happened when the published theory was embedded for semantic retrieval. */
export class EmbeddingOutcomeDto {
  @ApiProperty({ description: 'Whether embedding was attempted at all' }) attempted!: boolean;
  @ApiProperty({ nullable: true, type: Number, description: 'Blocks embedded, or null when it could not run' })
  embedded!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'Why it could not run, when it could not' })
  note!: string | null;
}

export interface EmbeddingOutcome {
  attempted: boolean;
  embedded: number | null;
  note: string | null;
}

export class PublishBlockResultDto {
  @ApiProperty({ format: 'uuid' }) blockId!: string;
  @ApiProperty({ enum: BLOCK_KINDS }) kind!: string;
  @ApiProperty() published!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'The question this block became, for a question block' })
  questionId!: string | null;
  @ApiProperty({ type: [GateFailureDto] }) gateFailures!: { gate: string; detail: string }[];
  @ApiProperty({
    type: EmbeddingOutcomeDto,
    nullable: true,
    description: 'For a theory block: whether its sub-topic was re-embedded for semantic retrieval, or why not. Null for a question block.',
  })
  embeddings!: EmbeddingOutcome | null;
  @ApiPropertyOptional({ description: 'For a learning draft that was approved but not activated: why.' }) note?: string;
}

export class ReviewTaskDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ minimum: 1, maximum: 5, description: '1 is highest' }) priority!: number;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) contentBlockId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) subtopicId!: string | null;
  @ApiProperty({ nullable: true, type: Object }) suggestion!: Record<string, unknown> | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class JobDetailDto {
  @ApiProperty({ type: IngestionJobDto }) job!: IngestionJobDto;
  @ApiProperty({ type: [ReviewTaskDto] }) reviewTasks!: ReviewTaskDto[];
}

// ---------------------------------------------------------------- the consolidated document

export class SuggestionDecisionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;

  @ApiPropertyOptional({ maxLength: 200, description: 'Edited chapter name. New names must appear in the uploaded PDF.' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, 200)
  chapterName?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, 200)
  topicName?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, 200)
  subtopicName?: string;
}

export class ApproveDocumentDto {
  @ApiPropertyOptional({
    description:
      'Also confirm the flagged blocks (those nothing blocks but the rules ask a person to look at: low confidence, OCR, model-assisted). ' +
      'A deliberate act: they are marked reviewed by you and audited. Blocks that are blocked stay blocked.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  confirmFlagged?: boolean;

  @ApiPropertyOptional({ description: 'Report what would happen and change nothing.', default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    type: [SuggestionDecisionDto],
    description: 'The syllabus suggestions to approve, with any names you edited. Every pending suggestion not listed here and not rejected below is approved as proposed.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SuggestionDecisionDto)
  suggestions?: SuggestionDecisionDto[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Suggestions to reject: nothing is added to the syllabus for them.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  rejectSuggestionIds?: string[];
}

export class ApplyDefaultsDto {
  @ApiPropertyOptional({ description: "Accept each question's suggested difficulty and expected time where none is set." })
  @IsOptional()
  @IsBoolean()
  acceptSuggested?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'A difficulty (L1–L5) for every question that has none.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  difficultyLabel?: number;

  @ApiPropertyOptional({
    type: Object,
    description: 'Seconds of expected solving time by question type, for every question of that type that has none: `{ "single_correct": 120, "numeric": 180 }`.',
  })
  @IsOptional()
  @IsObject()
  expectedTimeSecondsByType?: Record<string, number>;
}

export class PreviewSummaryDto {
  @ApiProperty({ type: Object, description: 'How many blocks are ready, flagged, blocked, done and excluded' })
  readiness!: { ready: number; flagged: number; blocked: number; done: number; excluded: number };
  @ApiProperty() questions!: number;
  @ApiProperty() theory!: number;
  @ApiProperty({ description: 'Solutions matched to a question and confirmed' }) solutionsAttached!: number;
  @ApiProperty({ description: 'Learning-material drafts a model wrote, waiting for a person' }) drafts!: number;
  @ApiProperty() suggestionsPending!: number;
  @ApiProperty({ description: 'Pending suggestions that cannot be approved until a level they leave unresolved is named' }) suggestionsNeedingNames!: number;
  @ApiProperty({ description: 'Questions still missing a difficulty or expected time, which only a person can supply' }) questionsMissingValues!: number;
  @ApiProperty({ description: 'Questions whose answer a model proposed and the document does not state' }) answersToVerify!: number;
  @ApiProperty({ description: 'What approving now publishes: the ready blocks, and the flagged ones too if you confirm them' })
  wouldPublish!: { ready: number; withFlagged: number };
  @ApiProperty({ description: 'Whether the document can be approved now' }) canApprove!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Why it cannot, when it cannot' }) cannotApproveBecause!: string | null;
}

export class JobPreviewDto {
  @ApiProperty({ type: IngestionJobDto }) job!: IngestionJobDto;
  @ApiProperty({ type: PreviewSummaryDto }) summary!: PreviewSummaryDto;
  @ApiProperty({ type: SyllabusSuggestionListDto }) syllabus!: SyllabusSuggestionListDto;
  @ApiProperty({ type: [ReviewedBlockDto], description: 'The whole document in reading order, each block with what is wrong or uncertain about it' })
  blocks!: ReviewedBlockDto[];
}

export class BlockOutcomeDto {
  @ApiProperty({ format: 'uuid' }) blockId!: string;
  @ApiProperty({ nullable: true, type: Number }) sourcePage!: number | null;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ enum: ['published', 'confirmed_and_published', 'skipped', 'blocked', 'failed'] }) outcome!: string;
  @ApiProperty({ type: [String], description: 'Why, for anything that was not published' }) reasons!: string[];
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) questionId!: string | null;
}

export class SuggestionOutcomeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['approved', 'rejected', 'skipped', 'failed'] }) outcome!: string;
  @ApiProperty({ nullable: true, type: String }) detail!: string | null;
}

export class ApprovalResultDto {
  @ApiProperty({ description: 'True when nothing was changed because `dryRun` was set' }) dryRun!: boolean;
  @ApiProperty({ type: [SuggestionOutcomeDto] }) suggestions!: SuggestionOutcomeDto[];
  @ApiProperty({ type: [BlockOutcomeDto] }) blocks!: BlockOutcomeDto[];
  @ApiProperty({ type: Object }) totals!: { published: number; confirmed: number; skipped: number; blocked: number; failed: number };
  @ApiProperty({ description: 'Whether every block is now settled, so the job is complete' }) complete!: boolean;
  @ApiProperty({ type: Object, nullable: true, description: 'How the sub-topics were re-embedded for semantic retrieval' }) embeddings!: { attempted: number; embedded: number } | null;
}
