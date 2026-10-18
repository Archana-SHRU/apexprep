import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { NODE_STATUSES, TRACK_KINDS, type NodeStatus, type TrackKind } from '../../database/schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MESSAGE = 'slug must be lowercase letters, digits and single hyphens';

export const SYLLABUS_LEVELS = ['track', 'subject', 'chapter', 'topic', 'subtopic'] as const;
export type SyllabusLevel = (typeof SYLLABUS_LEVELS)[number];

// ---------------------------------------------------------------- admin input

class NodeBaseInput {
  @ApiProperty({ example: 'rotational-dynamics', maxLength: 80 })
  @IsString()
  @Matches(SLUG, { message: SLUG_MESSAGE })
  @MaxLength(80)
  slug!: string;

  @ApiProperty({ example: 'Rotational Dynamics', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: 'Position among siblings (ascending)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;

  @ApiPropertyOptional({ enum: NODE_STATUSES, default: 'draft', description: 'Students see only published nodes whose ancestors are all published' })
  @IsOptional()
  @IsIn(NODE_STATUSES)
  status?: NodeStatus;
}

export class CreateTrackDto extends NodeBaseInput {
  @ApiPropertyOptional({ example: 'JEE', maxLength: 20, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 20)
  shortName?: string | null;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ example: 2027, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  examYear?: number | null;

  @ApiPropertyOptional({ example: '2027-05-23', format: 'date', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'examDate must be YYYY-MM-DD' })
  examDate?: string | null;

  // -------------------------------------------------------------- learning context (0013)
  //
  // What sort of learning this track is, so the platform is not implicitly about exams. Every field
  // is optional and nothing is inferred from another: a track that says nothing about itself stays
  // uncategorised, which is what every track created before migration 0013 is.

  @ApiPropertyOptional({
    enum: TRACK_KINDS,
    nullable: true,
    description:
      'What sort of learning context this is. `olympiad` is the value the Olympiad safety rules read: ' +
      'generated explanations on such a track need a human before a student sees them, and L5 content ' +
      'on it is never auto-approved.',
  })
  @IsOptional()
  @IsIn(TRACK_KINDS)
  kind?: TrackKind | null;

  @ApiPropertyOptional({ example: 'primary', maxLength: 40, nullable: true, description: 'Free text; no vocabulary is imposed' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  educationStage?: string | null;

  @ApiPropertyOptional({ example: 'Class 5', maxLength: 40, nullable: true, description: 'What the learner calls it' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  gradeLabel?: string | null;

  @ApiPropertyOptional({
    example: 5,
    nullable: true,
    description:
      'For ordering and filtering school tracks only — Class 5 before Class 6. It is NOT a difficulty ' +
      'mapping: no grade-to-difficulty rule is defined anywhere, because none is specified. Requires kind = school.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  gradeOrdinal?: number | null;

  @ApiPropertyOptional({ example: 'JEE', maxLength: 40, nullable: true, description: 'Free text; no exam list is imposed' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  examFamily?: string | null;

  @ApiPropertyOptional({ example: 'CBSE', maxLength: 40, nullable: true, description: 'Free text; no board list is imposed' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  curriculum?: string | null;

  @ApiPropertyOptional({ example: 'en-IN', maxLength: 35, nullable: true, description: 'BCP-47-style language tag' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, { message: 'locale must look like en, en-IN or sa-Deva-IN' })
  locale?: string | null;
}

export class CreateSubjectDto extends NodeBaseInput {
  @ApiPropertyOptional({ example: '#4361EE', nullable: true, description: 'Display colour' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'colorHex must look like #4361EE' })
  colorHex?: string | null;
}

export class CreateChapterDto extends NodeBaseInput {
  @ApiPropertyOptional({ example: 12.5, minimum: 0, maximum: 100, nullable: true, description: 'Approximate exam weightage, percent (display only)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  weightagePct?: number | null;
}

export class CreateTopicDto extends NodeBaseInput {}

export class CreateSubtopicDto extends NodeBaseInput {
  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  description?: string | null;
}

export class UpdateTrackDto extends PartialType(CreateTrackDto) {}
export class UpdateSubjectDto extends PartialType(CreateSubjectDto) {}
export class UpdateChapterDto extends PartialType(CreateChapterDto) {}
export class UpdateTopicDto extends PartialType(CreateTopicDto) {}
export class UpdateSubtopicDto extends PartialType(CreateSubtopicDto) {}

// ---------------------------------------------------------------- output

export class TrackDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) shortName!: string | null;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ nullable: true, type: Number }) examYear!: number | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) examDate!: string | null;
  // The learning context (migration 0013). Null on any track that has not been categorised, which
  // is every track that existed before it — the frontend must treat null as "not stated", never as
  // a default, and in particular never as "competitive exam".
  @ApiProperty({ enum: TRACK_KINDS, nullable: true, type: String }) kind!: TrackKind | null;
  @ApiProperty({ nullable: true, type: String }) educationStage!: string | null;
  @ApiProperty({ nullable: true, type: String }) gradeLabel!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Ordering only; not a difficulty' }) gradeOrdinal!: number | null;
  @ApiProperty({ nullable: true, type: String }) examFamily!: string | null;
  @ApiProperty({ nullable: true, type: String }) curriculum!: string | null;
  @ApiProperty({ nullable: true, type: String }) locale!: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ enum: NODE_STATUSES }) status!: NodeStatus;
}

export class SubjectDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) trackId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) colorHex!: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ enum: NODE_STATUSES }) status!: NodeStatus;
}

export class ChapterDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: Number }) weightagePct!: number | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ enum: NODE_STATUSES }) status!: NodeStatus;
}

export class TopicDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) chapterId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ enum: NODE_STATUSES }) status!: NodeStatus;
}

export class SubtopicDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) topicId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ enum: NODE_STATUSES }) status!: NodeStatus;
}

const MASTERY_DOC = {
  nullable: true,
  type: Number,
  description: "The student's mastery of this node, 0-1. Always null until the adaptive engine and analytics phases fill it in.",
};
const COUNT_DOC = { description: 'Published questions in this node (by primary sub-topic)' };

export class SubtopicNodeDto extends SubtopicDto {
  @ApiProperty(COUNT_DOC) questionCount!: number;
  @ApiProperty({ description: 'Whether the sub-topic has published theory' }) hasTheory!: boolean;
  @ApiProperty(MASTERY_DOC) mastery!: number | null;
}

export class TopicNodeDto extends TopicDto {
  @ApiProperty(COUNT_DOC) questionCount!: number;
  @ApiProperty(MASTERY_DOC) mastery!: number | null;
  @ApiProperty({ type: [SubtopicNodeDto] }) subtopics!: SubtopicNodeDto[];
}

export class ChapterNodeDto extends ChapterDto {
  @ApiProperty(COUNT_DOC) questionCount!: number;
  @ApiProperty(MASTERY_DOC) mastery!: number | null;
  @ApiProperty({ type: [TopicNodeDto] }) topics!: TopicNodeDto[];
}

export class SubjectNodeDto extends SubjectDto {
  @ApiProperty(COUNT_DOC) questionCount!: number;
  @ApiProperty(MASTERY_DOC) mastery!: number | null;
  @ApiProperty({ type: [ChapterNodeDto] }) chapters!: ChapterNodeDto[];
}

export class TrackTreeDto {
  @ApiProperty({ type: TrackDto }) track!: TrackDto;
  @ApiProperty(COUNT_DOC) questionCount!: number;
  @ApiProperty({ type: [SubjectNodeDto] }) subjects!: SubjectNodeDto[];
}

export class SubjectSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) colorHex!: string | null;
}

export class TrackSummaryDto extends TrackDto {
  @ApiProperty({ type: [SubjectSummaryDto] }) subjects!: SubjectSummaryDto[];
}

export class TrackListDto {
  @ApiProperty({ type: [TrackSummaryDto] }) items!: TrackSummaryDto[];
}

export class BreadcrumbDto {
  @ApiProperty({ enum: SYLLABUS_LEVELS }) level!: SyllabusLevel;
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
}

export class SubjectDetailDto {
  @ApiProperty({ type: [BreadcrumbDto] }) breadcrumbs!: BreadcrumbDto[];
  @ApiProperty({ type: SubjectNodeDto }) subject!: SubjectNodeDto;
}
export class ChapterDetailDto {
  @ApiProperty({ type: [BreadcrumbDto] }) breadcrumbs!: BreadcrumbDto[];
  @ApiProperty({ type: ChapterNodeDto }) chapter!: ChapterNodeDto;
}
export class TopicDetailDto {
  @ApiProperty({ type: [BreadcrumbDto] }) breadcrumbs!: BreadcrumbDto[];
  @ApiProperty({ type: TopicNodeDto }) topic!: TopicNodeDto;
}
export class SubtopicDetailDto {
  @ApiProperty({ type: [BreadcrumbDto] }) breadcrumbs!: BreadcrumbDto[];
  @ApiProperty({ type: SubtopicNodeDto }) subtopic!: SubtopicNodeDto;
}
