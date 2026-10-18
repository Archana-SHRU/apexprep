import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { EXPLANATION_STATUSES, EXPLANATION_TIERS, RETRIEVAL_SCOPES } from '../../database/schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The reasons `review_tasks.review_tasks_student_report` accepts. */
export const REPORT_REASONS = ['wrong_answer', 'wrong_solution', 'typo', 'unclear', 'missing_diagram', 'wrong_topic', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

// ---------------------------------------------------------------- input

export class ReportQuestionDto {
  @ApiProperty({ enum: REPORT_REASONS, description: 'What is wrong. `wrong_solution` covers a faulty explanation.' })
  @IsIn(REPORT_REASONS)
  reason!: ReportReason;

  @ApiPropertyOptional({ maxLength: 2000, description: 'What the student saw. Shown to the reviewer, never to other students.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class ReviewExplanationDto {
  @ApiProperty({
    enum: ['approve', 'reject'],
    description:
      'Approving releases an explanation that a mandatory-approval track was holding. Rejecting takes it out of circulation; the record is kept either way.',
  })
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @ApiPropertyOptional({ maxLength: 2000, description: 'Why. Stored on the audit row, never shown to a student.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class ExplanationQueryDto {
  @ApiPropertyOptional({
    description:
      'Admin only: the wrong option whose variant to read. A student never sends this — the variant follows from their own recorded attempt.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,4}$/, { message: 'optionKey must be 1-4 letters or digits' })
  optionKey?: string;
}

// ---------------------------------------------------------------- output

export class ExplanationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) questionId!: string;
  @ApiProperty({ description: 'The question version this explanation was written for' }) questionVersion!: number;
  @ApiProperty({
    enum: ['official_solution', 'notes_only', 'mostly_notes', 'general_knowledge'],
    description:
      'Where the explanation came from: the course\'s own approved solution, generated and fully supported by the course notes, generated and mostly supported by them, or generated from general subject knowledge.',
  })
  source!: 'official_solution' | 'notes_only' | 'mostly_notes' | 'general_knowledge';
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Text that must be displayed with the explanation. Set to "Not from official notes — pending review" for general knowledge.',
  })
  notice!: string | null;
  @ApiProperty() summary!: string;
  @ApiProperty({ type: [String] }) steps!: string[];
  @ApiProperty({ nullable: true, type: String }) keyConcept!: string | null;
  @ApiProperty({ nullable: true, type: String }) commonMistake!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The wrong option this explanation also covers, when it was written for a particular distractor.',
  })
  optionKey!: string | null;
  @ApiProperty({ description: 'Whether a reviewer has been asked to look at this explanation' }) underReview!: boolean;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
}

export class ReportResultDto {
  @ApiProperty({ format: 'uuid', description: 'The review task this report created' }) reportId!: string;
  @ApiProperty({ enum: REPORT_REASONS }) reason!: ReportReason;
  @ApiProperty({ description: 'How many students have now reported this question' }) reportCount!: number;
  @ApiProperty({ description: 'True when this report took the explanation out of circulation' }) explanationUnpublished!: boolean;
}

/** Admin view: everything the student view hides, for reviewing an explanation. */
export class AdminExplanationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) questionId!: string;
  @ApiProperty() questionVersion!: number;
  @ApiProperty({ enum: EXPLANATION_TIERS }) sourceTier!: string;
  @ApiProperty({ enum: EXPLANATION_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String }) optionKey!: string | null;
  @ApiProperty({ nullable: true, type: String }) provider!: string | null;
  @ApiProperty({ nullable: true, type: String }) model!: string | null;
  @ApiProperty({ nullable: true, type: String }) promptVersion!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'The computed grounding score, 0-1' }) groundingScore!: number | null;
  @ApiProperty({ type: [String], format: 'uuid', description: 'Theory blocks that actually supported the explanation' })
  groundingBlockIds!: string[];
  @ApiProperty({ nullable: true, enum: RETRIEVAL_SCOPES, description: 'How far retrieval had to widen' })
  retrievalScope!: string | null;
  @ApiProperty({ description: 'Whether a student would be shown this right now' }) studentVisible!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Why not, when it is not visible' }) blockedReason!: string | null;
  @ApiProperty({ type: Object, description: 'Retrieval and validation trace, plus the answer the model argued for' })
  diagnostics!: Record<string, unknown>;
  @ApiProperty() summary!: string;
  @ApiProperty({ type: [String] }) steps!: string[];
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) reviewedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
}

export class ReindexResultDto {
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty({ description: 'Published theory blocks considered' }) blocks!: number;
  @ApiProperty({ description: 'Embeddings written (new or changed text)' }) embedded!: number;
  @ApiProperty({ description: 'Blocks whose text had not changed since last time' }) unchanged!: number;
  @ApiProperty({ description: 'The embedding model used' }) model!: string;
}

export * from './ask-question.dto';

