import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class CheckDivergenceDto {
  @ApiPropertyOptional({
    description: 'Elo point divergence threshold triggering a teacher review task (default 250)',
    default: 250,
    minimum: 50,
    maximum: 1000,
  })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(1000)
  threshold?: number = 250;

  @ApiPropertyOptional({
    description: 'Minimum calibrated attempts before testing divergence (default 30)',
    default: 30,
    minimum: 5,
    maximum: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(500)
  minCalibrations?: number = 30;
}

export class QuestionDivergenceItemDto {
  @ApiProperty({ format: 'uuid' })
  questionId!: string;

  @ApiProperty({ description: 'Question stem excerpt' })
  stem!: string;

  @ApiProperty({ description: 'Current teacher-assigned level (1-5)' })
  currentLabel!: number;

  @ApiProperty({ description: 'Calibrated suggested level based on empirical student performance (1-5)' })
  suggestedLabel!: number;

  @ApiProperty({ description: 'Current calibrated empirical difficulty B (Elo scale)' })
  observedB!: number;

  @ApiProperty({ description: 'Expected starting difficulty B for assigned level' })
  expectedB!: number;

  @ApiProperty({ description: 'Absolute difference in Elo points' })
  delta!: number;

  @ApiProperty({ description: 'Number of calibrated attempts evaluated' })
  calibrationN!: number;

  @ApiProperty({ nullable: true, format: 'uuid', description: 'Review task ID opened for teacher review' })
  reviewTaskId!: string | null;
}

export class DivergenceCheckResultDto {
  @ApiProperty({ description: 'Total published questions evaluated with sufficient calibrations' })
  scannedCount!: number;

  @ApiProperty({ description: 'Number of questions with observed divergence >= threshold' })
  divergingCount!: number;

  @ApiProperty({ description: 'Number of new teacher review tasks opened' })
  tasksOpened!: number;

  @ApiProperty({ type: [QuestionDivergenceItemDto], description: 'Detailed items requiring teacher attention' })
  divergences!: QuestionDivergenceItemDto[];
}
