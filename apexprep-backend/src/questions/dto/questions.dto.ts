import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor';
import {
  OPTION_SIDES,
  QUESTION_STATUSES,
  QUESTION_TYPES,
  TOLERANCE_MODES,
  type MatrixAnswer,
  type OptionSide,
  type QuestionStatus,
  type QuestionType,
  type ToleranceMode,
} from '../../database/schema';
import { DECIMAL, SHAPE_LIMITS } from '../question-shape';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Accepts 4.2 or "4.20"; stored and returned as a string so no precision is lost. */
const decimalString = ({ value }: { value: unknown }) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : value;

export const HINTS_MAX = 5;
export const HINT_MAX_LENGTH = 1000;

// ---------------------------------------------------------------- input

export class QuestionOptionInputDto {
  @ApiProperty({ example: 'A', description: '1-4 letters or digits, unique within the question (within its side for matrix_match)' })
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,4}$/, { message: 'key must be 1-4 letters or digits' })
  key!: string;

  @ApiProperty({ example: 'MR²', maxLength: SHAPE_LIMITS.optionBodyMax })
  @IsString()
  @Length(1, SHAPE_LIMITS.optionBodyMax)
  text!: string;

  @ApiPropertyOptional({ default: false, description: 'Answer key. Never sent to students.' })
  @IsOptional()
  @IsBoolean()
  isCorrect?: boolean;

  @ApiPropertyOptional({ enum: OPTION_SIDES, default: 'single', description: "matrix_match uses 'left' and 'right'" })
  @IsOptional()
  @IsIn(OPTION_SIDES)
  side?: OptionSide;
}

export class NumericAnswerInputDto {
  @ApiProperty({ example: '4.20', description: 'Exact value; a decimal string keeps the precision you typed' })
  @Transform(decimalString)
  @IsString()
  @Matches(DECIMAL, { message: 'value must be a decimal number' })
  value!: string;

  @ApiPropertyOptional({ example: '0.05', description: 'Accepted deviation. Integer questions are always exact (0).' })
  @IsOptional()
  @Transform(decimalString)
  @IsString()
  @Matches(DECIMAL, { message: 'tolerance must be a decimal number' })
  tolerance?: string;

  @ApiPropertyOptional({ enum: TOLERANCE_MODES, description: 'absolute: |given − correct| ≤ tolerance. relative: tolerance is a fraction of the correct value.' })
  @IsOptional()
  @IsIn(TOLERANCE_MODES)
  mode?: ToleranceMode;
}

/** Fields shared by create and update; every one optional here, required ones re-declared in CreateQuestionDto. */
class QuestionContentInput {
  @ApiPropertyOptional({ type: Object, nullable: true, description: 'Optional rich representation of the stem (blocks, LaTeX, table data)' })
  @IsOptional()
  @IsObject()
  stemJson?: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: [String], maxItems: HINTS_MAX, description: 'Progressive hints. Students receive only the count until they ask for one.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(HINTS_MAX)
  @IsString({ each: true })
  @MaxLength(HINT_MAX_LENGTH, { each: true })
  hints?: string[];

  @ApiPropertyOptional({ type: [QuestionOptionInputDto], description: 'Option types and matrix_match only. Sending this replaces every option.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SHAPE_LIMITS.optionsMax * 2)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionInputDto)
  options?: QuestionOptionInputDto[];

  @ApiPropertyOptional({ type: NumericAnswerInputDto, description: 'integer and numeric types only' })
  @IsOptional()
  @ValidateNested()
  @Type(() => NumericAnswerInputDto)
  numericAnswer?: NumericAnswerInputDto;

  @ApiPropertyOptional({
    type: Object,
    description: 'matrix_match only: left key → right keys, e.g. {"A": ["q"], "B": ["p", "s"]}',
    example: { A: ['q'], B: ['p', 's'] },
  })
  @IsOptional()
  @IsObject()
  matrixAnswer?: MatrixAnswer;

  @ApiPropertyOptional({ type: [String], format: 'uuid', maxItems: 10, description: 'Other sub-topics this question also tests. Sending this replaces the list.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  secondarySubtopicIds?: string[];
}

export class CreateQuestionDto extends QuestionContentInput {
  @ApiProperty({ format: 'uuid', description: 'Primary sub-topic: the atomic unit practice is scoped to' })
  @IsUUID()
  subtopicId!: string;

  @ApiProperty({ enum: QUESTION_TYPES })
  @IsIn(QUESTION_TYPES)
  type!: QuestionType;

  @ApiProperty({ maxLength: 20000 })
  @Transform(trim)
  @IsString()
  @Length(1, 20000)
  stem!: string;

  @ApiProperty({ minimum: 1, maximum: 5, description: 'L1-L5. Sets the starting Elo difficulty from the active engine configuration.' })
  @IsInt()
  @Min(1)
  @Max(5)
  difficultyLabel!: number;

  @ApiProperty({ minimum: 5, maximum: 7200, description: 'Expected solving time in seconds' })
  @IsInt()
  @Min(5)
  @Max(7200)
  expectedTimeSeconds!: number;
}

/**
 * `type` is intentionally absent: changing the type would change how stored attempts were
 * graded, so create a new question instead (DECISIONS.md §B23).
 */
export class UpdateQuestionDto extends QuestionContentInput {
  @ApiPropertyOptional({ format: 'uuid', description: 'Move the question to another primary sub-topic' })
  @IsOptional()
  @IsUUID()
  subtopicId?: string;

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 20000)
  stem?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
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
}

export class OfficialSolutionInputDto {
  @ApiProperty({ maxLength: 50000, description: 'The published solution. Explanations prefer this over anything generated.' })
  @Transform(trim)
  @IsString()
  @Length(1, 50000)
  body!: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  finalAnswerText?: string | null;

  @ApiPropertyOptional({ type: Object, nullable: true, description: 'Structured steps, or the rubric for long-form questions' })
  @IsOptional()
  @IsObject()
  bodyJson?: Record<string, unknown> | null;
}

export class QuestionTaxonomyDto {
  @ApiProperty({ format: 'uuid' }) trackId!: string;
  @ApiProperty() trackName!: string;
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ format: 'uuid' }) chapterId!: string;
  @ApiProperty() chapterName!: string;
  @ApiProperty({ format: 'uuid' }) topicId!: string;
  @ApiProperty() topicName!: string;
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty() subtopicName!: string;
}

export class ListQuestionsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Numbered pages, for a table that jumps to a page and shows a total. Mutually exclusive with `cursor`. The response then carries `total`, `page` and `pageSize`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, description: 'Rows per page when `page` is given; defaults to `limit`, then 20.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter by track' }) @IsOptional() @IsUUID() trackId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Filter by subject' }) @IsOptional() @IsUUID() subjectId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Filter by subtopic' }) @IsOptional() @IsUUID() subtopicId?: string;
  @ApiPropertyOptional({ enum: QUESTION_STATUSES }) @IsOptional() @IsIn(QUESTION_STATUSES) status?: QuestionStatus;
  @ApiPropertyOptional({ enum: QUESTION_TYPES }) @IsOptional() @IsIn(QUESTION_TYPES) type?: QuestionType;
  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  difficultyLabel?: number;

  @ApiPropertyOptional({ description: 'Full-text search over question stems' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  search?: string;
}

// ---------------------------------------------------------------- output

export class AdminQuestionOptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() key!: string;
  @ApiProperty({ enum: OPTION_SIDES }) side!: OptionSide;
  @ApiProperty() text!: string;
  @ApiProperty({ description: 'Answer key — admin view only' }) isCorrect!: boolean;
  @ApiProperty() sortOrder!: number;
}

export class OfficialSolutionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ nullable: true, type: Object }) bodyJson!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true, type: String }) finalAnswerText!: string | null;
  @ApiProperty({ enum: ['draft', 'approved', 'rejected'] }) status!: 'draft' | 'approved' | 'rejected';
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class NumericAnswerDto {
  @ApiProperty({ example: '4.20' }) value!: string;
  @ApiProperty({ example: '0.05' }) tolerance!: string;
  @ApiProperty({ enum: TOLERANCE_MODES }) mode!: ToleranceMode;
}

export class AdminQuestionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) secondarySubtopicIds!: string[];
  @ApiProperty({ enum: QUESTION_TYPES }) type!: QuestionType;
  @ApiProperty({ enum: QUESTION_STATUSES }) status!: QuestionStatus;
  @ApiProperty({ description: 'Increases whenever the content or answer key changes; attempts record the version they were graded against' })
  version!: number;
  @ApiProperty() stem!: string;
  @ApiProperty({ nullable: true, type: Object }) stemJson!: Record<string, unknown> | null;
  @ApiProperty({ type: [AdminQuestionOptionDto] }) options!: AdminQuestionOptionDto[];
  @ApiProperty({ nullable: true, type: NumericAnswerDto }) numericAnswer!: NumericAnswerDto | null;
  @ApiProperty({ nullable: true, type: Object, description: 'matrix_match answer key' }) matrixAnswer!: MatrixAnswer | null;
  @ApiProperty({ minimum: 1, maximum: 5 }) difficultyLabel!: number;
  @ApiProperty({ description: 'Elo-scale difficulty maintained by the adaptive engine' }) difficultyB!: number;
  @ApiProperty({ description: 'Attempts the difficulty has been calibrated on' }) calibrationN!: number;
  @ApiProperty() expectedTimeSeconds!: number;
  @ApiProperty({ type: [String] }) hints!: string[];
  @ApiProperty({ nullable: true, type: OfficialSolutionDto }) officialSolution!: OfficialSolutionDto | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) sourceAssetId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) sourcePage!: number | null;
  @ApiPropertyOptional({ type: QuestionTaxonomyDto, nullable: true }) taxonomy?: QuestionTaxonomyDto | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) publishedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class AdminQuestionSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subjectName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) trackName?: string | null;
  @ApiProperty({ enum: QUESTION_TYPES }) type!: QuestionType;
  @ApiProperty({ enum: QUESTION_STATUSES }) status!: QuestionStatus;
  @ApiProperty() version!: number;
  @ApiProperty({ description: 'First 200 characters of the stem' }) stemPreview!: string;
  @ApiProperty() difficultyLabel!: number;
  @ApiProperty() difficultyB!: number;
  @ApiProperty() expectedTimeSeconds!: number;
  @ApiProperty() hasOfficialSolution!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class AdminQuestionPageDto {
  @ApiProperty({ type: [AdminQuestionSummaryDto] }) items!: AdminQuestionSummaryDto[];
  @ApiProperty({ nullable: true, type: String, description: 'Pass as `cursor` for the next page. Null in numbered-page mode.' }) nextCursor!: string | null;
  @ApiPropertyOptional({ description: 'Rows matching the filters. Present in numbered-page mode.' }) total?: number;
  @ApiPropertyOptional({ description: 'The page returned. Present in numbered-page mode.' }) page?: number;
  @ApiPropertyOptional({ description: 'Rows per page. Present in numbered-page mode.' }) pageSize?: number;
}

export class StudentOptionDto {
  @ApiProperty() key!: string;
  @ApiProperty() text!: string;
}

export class StudentMatrixDto {
  @ApiProperty({ type: [StudentOptionDto] }) left!: StudentOptionDto[];
  @ApiProperty({ type: [StudentOptionDto] }) right!: StudentOptionDto[];
}

/** Exactly what a student receives. No answer key, no solution, no engine internals. */
export class StudentQuestionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Question version this payload was built from' }) version!: number;
  @ApiProperty({ enum: QUESTION_TYPES }) type!: QuestionType;
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty() stem!: string;
  @ApiProperty({ nullable: true, type: Object }) stemJson!: Record<string, unknown> | null;
  @ApiProperty({ minimum: 1, maximum: 5 }) difficultyLabel!: number;
  @ApiProperty() expectedTimeSeconds!: number;
  @ApiProperty({ description: 'How many hints exist; the text is revealed through the practice API' }) hintCount!: number;
  @ApiProperty({ type: [StudentOptionDto] }) options!: StudentOptionDto[];
  @ApiPropertyOptional({ type: StudentMatrixDto, description: 'matrix_match only' }) matrix?: StudentMatrixDto;
}
