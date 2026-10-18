import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class BenchmarkQueryDto {
  @ApiProperty({ description: 'The sub-topic UUID to query peer benchmarks for' })
  @IsUUID('4')
  subtopicId!: string;
}

export class ComputeBenchmarkDto {
  @ApiProperty({ description: 'The sub-topic UUID to compute benchmarks for' })
  @IsUUID('4')
  subtopicId!: string;

  @ApiPropertyOptional({ description: 'Rolling window in days', default: 90 })
  @IsOptional()
  @IsInt()
  @Min(7)
  @Max(365)
  windowDays?: number = 90;

  @ApiPropertyOptional({ description: 'Date of snapshot YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  snapshotDate?: string;
}

export class BenchmarkDto {
  @ApiProperty({ format: 'uuid' })
  subtopicId!: string;

  @ApiProperty({ description: 'Whether the benchmark is published (cohort size threshold met)' })
  isPublished!: boolean;

  @ApiProperty({ description: 'Number of unique students with qualifying attempts in this subtopic' })
  qualifyingStudents!: number;

  @ApiProperty({ description: 'Minimum number of qualifying students required to publish benchmark (30)' })
  minQualifyingStudents!: number;

  @ApiProperty({ description: 'The top cohort size considered (e.g., top 10)' })
  topK!: number;

  @ApiProperty({ nullable: true, type: Number, description: 'Average accuracy of the top cohort in [0, 1]' })
  topAccuracy!: number | null;

  @ApiProperty({ nullable: true, type: Number, description: 'Median solving time in seconds for the top cohort' })
  topMedianTimeSeconds!: number | null;

  @ApiProperty({ nullable: true, type: String, description: 'Snapshot date (YYYY-MM-DD)' })
  snapshotDate!: string | null;

  @ApiPropertyOptional({ description: 'Informational message explaining cohort or publishing status' })
  message?: string;
}
