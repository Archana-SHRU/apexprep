import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { NOTE_SCOPE_LEVELS, TUTOR_INTENTS, type NoteScopeLevel, type TutorIntent } from '../../database/schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ---------------------------------------------------------------- revision notes

export class NotesScopeDto {
  @ApiProperty({ enum: NOTE_SCOPE_LEVELS, description: 'The syllabus level to summarise' })
  @IsIn(NOTE_SCOPE_LEVELS)
  level!: NoteScopeLevel;

  @ApiProperty({ format: 'uuid', description: 'The published node at that level' })
  @IsUUID()
  id!: string;
}

export class NoteItemDto {
  @ApiProperty() text!: string;
  @ApiProperty({ type: [String], description: 'The source notes (content block ids) this item is taken from' })
  sourceBlockIds!: string[];
}

export class RevisionNotesDto {
  @ApiProperty({ enum: ['ready', 'outdated', 'not_generated', 'no_source'] })
  state!: 'ready' | 'outdated' | 'not_generated' | 'no_source';
  @ApiProperty({ description: 'The node summarised' })
  scope!: { level: NoteScopeLevel; id: string; name: string; path: string };
  @ApiPropertyOptional({ nullable: true, type: Object, description: 'Present when state is ready' })
  notes!: {
    id: string;
    title: string;
    overview: string;
    keyPoints: NoteItemDto[];
    concepts: { term: string; explanation: string; sourceBlockIds: string[] }[];
    formulas: { expression: string; meaning: string; sourceBlockIds: string[] }[];
    commonMistakes: NoteItemDto[];
    quickRevision: NoteItemDto[];
    sources: { blockId: string; title: string | null }[];
    generatedAt: string;
  } | null;
  @ApiProperty({ description: 'True when served from the cache without calling a provider' })
  cached!: boolean;
  @ApiProperty({ description: 'Published theory blocks under this node' })
  sourceBlockCount!: number;
}

// ---------------------------------------------------------------- generated questions

export const GENERATABLE_TYPES = ['single_correct', 'multi_correct', 'integer', 'numeric', 'assertion_reason'] as const;
export type GeneratableType = (typeof GENERATABLE_TYPES)[number];

export class GenerateQuestionsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subtopicId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 3, default: 1, description: 'How many fresh questions to ask for' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  count?: number;

  @ApiPropertyOptional({ enum: GENERATABLE_TYPES, description: 'Question type; single_correct when omitted' })
  @IsOptional()
  @IsIn(GENERATABLE_TYPES)
  type?: GeneratableType;
}

export class GeneratedQuestionsResultDto {
  @ApiProperty({ description: 'The adaptive engine’s target level for this learner in this sub-topic' })
  targetLevel!: number;
  @ApiProperty({ description: 'Questions that passed validation and joined the practice pool. No answers are included.' })
  generated!: { questionId: string; type: string; difficultyLabel: number; status: 'published' | 'in_review' }[];
  @ApiProperty({ description: 'Generations that failed validation and were discarded' })
  rejected!: number;
  @ApiProperty() message!: string;
}

// ---------------------------------------------------------------- tutor

export class StartConversationDto {
  @ApiProperty({ format: 'uuid', description: 'The sub-topic the conversation is about' })
  @IsUUID()
  subtopicId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'The question being worked on, when there is one' })
  @IsOptional()
  @IsUUID()
  questionId?: string;
}

export class TutorMessageInputDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;

  @ApiPropertyOptional({ enum: TUTOR_INTENTS, default: 'free' })
  @IsOptional()
  @IsIn(TUTOR_INTENTS)
  intent?: TutorIntent;
}

export class TutorMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['student', 'tutor'] }) role!: 'student' | 'tutor';
  @ApiProperty({ enum: TUTOR_INTENTS }) intent!: TutorIntent;
  @ApiProperty() body!: string;
  @ApiProperty({ type: [String], description: 'Worked steps, for tutor replies that have them' }) steps!: string[];
  @ApiProperty({ description: 'True when the reply rests on the course notes' }) grounded!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class TutorConversationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty({ nullable: true, type: String }) questionId!: string | null;
  @ApiProperty({ description: 'Whether the learner has answered the question; before that the tutor gives hints, not answers' })
  answered!: boolean;
  @ApiProperty({ type: [TutorMessageDto] }) messages!: TutorMessageDto[];
}

export class TutorReplyDto {
  @ApiProperty({ type: TutorMessageDto }) student!: TutorMessageDto;
  @ApiProperty({ type: TutorMessageDto }) tutor!: TutorMessageDto;
}

// ---------------------------------------------------------------- visuals

export class VisualExplanationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) questionId!: string;
  @ApiProperty({ enum: ['diagram', 'graph', 'step_by_step', 'animation', 'illustration', 'image', 'none'] })
  visualType!: string;
  @ApiProperty() title!: string;
  @ApiProperty() caption!: string;
  @ApiProperty({ description: 'The concept the visual is about' }) concept!: string;
  @ApiProperty({ description: 'Why this format was chosen, or why no visual was drawn' }) reason!: string;
  @ApiPropertyOptional({ nullable: true, type: Object, description: 'The validated scene to draw' })
  scene!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'For an image: the authenticated URL of the stored image' })
  imageUrl!: string | null;
  @ApiProperty() cached!: boolean;
}
