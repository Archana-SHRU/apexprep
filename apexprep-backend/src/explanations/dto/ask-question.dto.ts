import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const ASK_INTENTS = ['free', 'why_wrong', 'simplify', 'explain_step', 'concept'] as const;
export type AskIntent = (typeof ASK_INTENTS)[number];

export class AskQuestionDto {
  @ApiProperty({
    description: 'The doubt or question the learner is asking about this problem.',
    minLength: 2,
    maxLength: 1000,
    example: 'Why is option B incorrect?',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(1000)
  message!: string;

  @ApiPropertyOptional({
    enum: ASK_INTENTS,
    default: 'free',
    description: 'The pedagogical intent of the question.',
  })
  @IsOptional()
  @IsIn(ASK_INTENTS)
  intent?: AskIntent = 'free';
}

export class AskQuestionResponseDto {
  @ApiProperty({ format: 'uuid' })
  questionId!: string;

  @ApiProperty({ description: 'Direct answer and clarification from the tutor.' })
  answer!: string;

  @ApiProperty({ type: [String], description: 'Key steps to understand the solution.' })
  steps!: string[];

  @ApiProperty({ description: 'Whether the answer is grounded in official solutions and course notes.' })
  grounded!: boolean;

  @ApiProperty({
    enum: ['official_solution', 'notes_only', 'mostly_notes', 'general_knowledge', 'canned'],
    description: 'Origin of the guidance.',
  })
  source!: 'official_solution' | 'notes_only' | 'mostly_notes' | 'general_knowledge' | 'canned';

  @ApiProperty({ nullable: true, type: String })
  keyConcept!: string | null;

  @ApiProperty({ format: 'date-time' })
  answeredAt!: string;
}
