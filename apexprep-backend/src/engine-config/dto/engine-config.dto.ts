import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsObject, IsOptional, IsString, Length } from 'class-validator';
import type { EngineConfigRow } from '../../database/schema';
import type { ParamIssue } from '../../adaptive/engine-params';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateEngineConfigDto {
  @ApiProperty({
    type: Object,
    description:
      'The complete parameter set. Every key is required and nothing has a default: a missing key is rejected with its path, rather than the engine running on an invented value. See docs/DECISIONS.md §C.',
  })
  @IsObject()
  params!: Record<string, unknown>;

  @ApiProperty({ maxLength: 2000, description: 'Why this version exists; stored with the version and in the audit log' })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  changeNote!: string;

  @ApiPropertyOptional({ default: false, description: 'Activate this version immediately (deactivating the current one)' })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}

export class EngineParamIssueDto {
  @ApiProperty({ example: 'params.probe.every_n' }) field!: string;
  @ApiProperty() message!: string;
}

export class EngineConfigDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ description: 'Version number within the organisation; versions are immutable' }) version!: number;
  @ApiProperty() schemaVersion!: number;
  @ApiProperty({ type: Object }) params!: Record<string, unknown>;
  @ApiProperty() changeNote!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ description: 'Whether these parameters satisfy the engine schema in full' }) paramsValid!: boolean;
  @ApiProperty({ type: [EngineParamIssueDto], description: 'Empty when paramsValid is true' }) paramsIssues!: EngineParamIssueDto[];
  @ApiProperty({
    description: 'True when the version carries provisional values pending the requirements document (the seed marks them)',
  })
  provisional!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) activatedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) deactivatedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class EngineConfigListDto {
  @ApiProperty({ type: [EngineConfigDto] }) items!: EngineConfigDto[];
}

export function toEngineConfigDto(row: EngineConfigRow, issues: ParamIssue[]): EngineConfigDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    version: row.version,
    schemaVersion: row.schemaVersion,
    params: row.params,
    changeNote: row.changeNote,
    isActive: row.isActive,
    paramsValid: issues.length === 0,
    paramsIssues: issues,
    provisional: row.params.provisional === true,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
