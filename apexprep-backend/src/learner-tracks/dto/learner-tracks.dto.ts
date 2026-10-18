import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { LEARNER_TRACK_STATUSES, type LearnerTrackStatus } from '../../database/schema';
import { TrackDto } from '../../syllabus/dto/syllabus.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class EnrolTrackDto {
  @ApiProperty({ format: 'uuid', description: 'A published track in your organisation' })
  @IsUUID()
  trackId!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'What the learner is working towards in this track, in their own words',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  goalText?: string;

  @ApiPropertyOptional({
    description: 'Make this the primary track. A learner has at most one, enforced by the database.',
  })
  @IsOptional()
  @IsBoolean()
  makePrimary?: boolean;
}

export class UpdateEnrolmentDto {
  @ApiPropertyOptional({
    description: 'Pass true to make this the primary track. Passing false is rejected: choose another track instead.',
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({ maxLength: 200, description: 'Empty string clears the goal' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  goalText?: string;
}

export class LearnerTrackDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) trackId!: string;
  @ApiProperty({ description: 'A learner has at most one primary track' }) isPrimary!: boolean;
  @ApiProperty({ enum: LEARNER_TRACK_STATUSES }) status!: LearnerTrackStatus;
  @ApiProperty({ nullable: true, type: String }) goalText!: string | null;
  @ApiProperty({ format: 'date-time' }) enrolledAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) leftAt!: string | null;
  @ApiProperty({
    type: TrackDto,
    description: 'The track itself, including its learning context. `kind` may be null on a track that predates it.',
  })
  track!: TrackDto;
}
