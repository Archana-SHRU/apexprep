import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PurgeEventsDto {
  @ApiPropertyOptional({
    description: 'Purge session events older than this many days (minimum 30, default 365)',
    default: 365,
    minimum: 30,
    maximum: 1825,
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(1825)
  olderThanDays?: number = 365;
}

export class PurgeEventsResultDto {
  @ApiProperty({ description: 'Number of purged session event records' })
  purgedCount!: number;

  @ApiProperty({ description: 'Cutoff ISO timestamp prior to which events were removed' })
  cutoffDate!: string;

  @ApiProperty({ description: 'Tenant UUID events were purged from' })
  tenantId!: string;
}
