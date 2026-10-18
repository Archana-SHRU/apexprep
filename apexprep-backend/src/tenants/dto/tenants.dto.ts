import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/password.service';
import type { TenantRow } from '../../database/schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normaliseEmail = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class CreateTenantDto {
  @ApiProperty({ example: 'kota-academy', description: 'Lowercase slug, used at sign-in' })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lowercase letters, digits and single hyphens' })
  @MaxLength(63)
  slug!: string;

  @ApiProperty({ example: 'Kota Academy' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ default: false, description: 'Allow students to sign up themselves' })
  @IsOptional()
  @IsBoolean()
  selfRegistrationEnabled?: boolean;
}

export class UpdateTenantDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ enum: ['active', 'suspended'], description: 'Suspending signs every user out' })
  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() selfRegistrationEnabled?: boolean;
  @ApiPropertyOptional({ description: 'Anonymous benchmarking for this organisation' })
  @IsOptional()
  @IsBoolean()
  benchmarkingEnabled?: boolean;
  @ApiPropertyOptional({ description: 'Focus tracking for this organisation' })
  @IsOptional()
  @IsBoolean()
  focusTrackingEnabled?: boolean;
}

export class CreateStaffDto {
  @ApiProperty({ example: 'admin@kota-academy.in' })
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Priya Sharma' })
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  displayName!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH, format: 'password', description: 'Initial password' })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  password!: string;
}

export class TenantDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['active', 'suspended'] }) status!: 'active' | 'suspended';
  @ApiProperty() selfRegistrationEnabled!: boolean;
  @ApiProperty() benchmarkingEnabled!: boolean;
  @ApiProperty() focusTrackingEnabled!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class TenantPageDto {
  @ApiProperty({ type: [TenantDto] }) items!: TenantDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export function toTenantDto(t: TenantRow): TenantDto {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    status: t.status,
    selfRegistrationEnabled: t.selfRegistrationEnabled,
    benchmarkingEnabled: t.benchmarkingEnabled,
    focusTrackingEnabled: t.focusTrackingEnabled,
    createdAt: t.createdAt.toISOString(),
  };
}
