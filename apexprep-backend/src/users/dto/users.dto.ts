import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Student self-service profile / onboarding (PATCH /v1/me/profile). All fields optional. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  displayName?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Track id from GET /v1/tracks (must belong to your organisation)' })
  @IsOptional()
  @IsUUID('4')
  primaryTrackId?: string;

  @ApiPropertyOptional({ maxLength: 200, example: 'IIT Bombay CSE' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  goal?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 10_000_000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  targetRank?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  dailyQuestionGoal?: number;

  @ApiPropertyOptional({ format: 'date', example: '2027-05-23' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'targetExamDate must be YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  targetExamDate?: string;

  @ApiPropertyOptional({ description: 'Opt out of focus tracking (tab switches, idle time)' })
  @IsOptional()
  @IsBoolean()
  focusTrackingOptOut?: boolean;

  @ApiPropertyOptional({ description: 'Mark onboarding complete (sets onboarded=true; cannot be undone)' })
  @IsOptional()
  @IsBoolean()
  completeOnboarding?: boolean;
}

export class ListUsersQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ description: 'Case-insensitive match on email or name', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  search?: string;
}

export class ListTenantUsersQueryDto extends ListUsersQueryDto {
  @ApiPropertyOptional({ enum: ['STUDENT', 'ADMIN'], description: 'Defaults to both' })
  @IsOptional()
  @IsIn(['STUDENT', 'ADMIN'])
  role?: 'STUDENT' | 'ADMIN';
}

export class ChangeUserStatusDto {
  @ApiProperty({ enum: ['active', 'disabled'] })
  @IsIn(['active', 'disabled'])
  status!: 'active' | 'disabled';
}

