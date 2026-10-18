import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BLOCK_FORMATS, BLOCK_STATUSES, type BlockFormat, type BlockStatus } from '../../database/schema';
import { AUTHORABLE_FORMATS, THEORY_LIMITS, type AuthorableFormat } from '../theory-text';

const trimOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class TheoryTableDto {
  @ApiProperty({ type: [String], example: ['Body', 'I about central axis'] })
  @IsArray()
  @ArrayMaxSize(THEORY_LIMITS.tableColumnsMax)
  @IsString({ each: true })
  columns!: string[];

  @ApiProperty({ type: 'array', items: { type: 'array', items: { type: 'string' } }, example: [['Ring', 'MR²']] })
  @IsArray()
  @ArrayMaxSize(THEORY_LIMITS.tableRowsMax)
  @IsArray({ each: true })
  rows!: string[][];
}

// ---------------------------------------------------------------- student output

export class TheoryBlockDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: BLOCK_FORMATS, description: 'Block layout: paragraph, formula, callout, list, table, heading, example, figure' })
  type!: BlockFormat;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Text of the block; for lists and tables, optional introductory text' })
  body!: string | null;
  @ApiPropertyOptional({ type: [String], description: 'List items (list blocks)' }) items?: string[];
  @ApiPropertyOptional({ type: TheoryTableDto, description: 'Table content (table blocks)' }) table?: TheoryTableDto;
}

export class TheoryDto {
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty({ description: 'Sub-topic name' }) title!: string;
  @ApiProperty({ description: 'Estimated reading time in minutes (0 when there is no theory yet)' }) readMinutes!: number;
  @ApiProperty({ type: [TheoryBlockDto], description: 'Published theory blocks in reading order; empty when none are published' })
  blocks!: TheoryBlockDto[];
}

// ---------------------------------------------------------------- admin

export class CreateTheoryBlockDto {
  @ApiProperty({ enum: AUTHORABLE_FORMATS, description: '`figure` blocks come from content ingestion (they need an uploaded image)' })
  @IsIn(AUTHORABLE_FORMATS)
  type!: AuthorableFormat;

  @ApiPropertyOptional({ maxLength: THEORY_LIMITS.titleMax, nullable: true })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(THEORY_LIMITS.titleMax)
  title?: string | null;

  @ApiPropertyOptional({ maxLength: THEORY_LIMITS.bodyMax, nullable: true, description: 'Required for every type except list and table' })
  @IsOptional()
  @IsString()
  @MaxLength(THEORY_LIMITS.bodyMax + 1000)
  body?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'List blocks only' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(THEORY_LIMITS.listItemsMax)
  @IsString({ each: true })
  items?: string[] | null;

  @ApiPropertyOptional({ type: TheoryTableDto, description: 'Table blocks only' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TheoryTableDto)
  table?: TheoryTableDto | null;

  @ApiPropertyOptional({ minimum: 0, description: 'Reading order within the sub-topic (ascending). Defaults to the end.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;

  @ApiPropertyOptional({ default: false, description: 'Publish immediately. Otherwise the block is saved unpublished (status approved).' })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export const EDITABLE_BLOCK_STATUSES = ['approved', 'published'] as const;

export class UpdateTheoryBlockDto {
  @ApiPropertyOptional({ enum: AUTHORABLE_FORMATS }) @IsOptional() @IsIn(AUTHORABLE_FORMATS) type?: AuthorableFormat;

  @ApiPropertyOptional({ nullable: true, description: 'null clears the title' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MaxLength(THEORY_LIMITS.titleMax)
  title?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(THEORY_LIMITS.bodyMax + 1000)
  body?: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(THEORY_LIMITS.listItemsMax)
  @IsString({ each: true })
  items?: string[] | null;

  @ApiPropertyOptional({ type: TheoryTableDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => TheoryTableDto)
  table?: TheoryTableDto | null;

  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsInt() @Min(0) @Max(1_000_000) sortOrder?: number;

  @ApiPropertyOptional({ enum: EDITABLE_BLOCK_STATUSES, description: '`published` shows the block to students; `approved` unpublishes it' })
  @IsOptional()
  @IsIn(EDITABLE_BLOCK_STATUSES)
  status?: (typeof EDITABLE_BLOCK_STATUSES)[number];
}

export class AdminTheoryBlockDto extends TheoryBlockDto {
  @ApiProperty({ format: 'uuid' }) subtopicId!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ enum: BLOCK_STATUSES }) status!: BlockStatus;
  @ApiProperty({ description: 'SHA-256 of the normalised text (duplicate detection)' }) contentHash!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'Source document, for extracted blocks' }) sourceAssetId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) sourcePage!: number | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) publishedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class AdminTheoryBlockListDto {
  @ApiProperty({ type: [AdminTheoryBlockDto] }) items!: AdminTheoryBlockDto[];
}
