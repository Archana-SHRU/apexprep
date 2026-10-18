import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ROLES, type Role } from '../common/auth/permissions';
import type { UserRow } from '../database/schema';

/**
 * Public shape of a user. Built field-by-field from the row by toUserDto — never by
 * spreading — so password_hash, token_version, lockout counters and similar internals
 * cannot reach a response even if new columns are added later.
 */
export class UserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ example: 'arjun@example.com' }) email!: string;
  @ApiProperty({ example: 'Arjun Verma' }) displayName!: string;
  @ApiProperty({ enum: ROLES }) role!: Role;
  @ApiProperty({ enum: ['active', 'disabled'] }) status!: 'active' | 'disabled';
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty({ description: 'Student has completed onboarding' }) onboarded!: boolean;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) primaryTrackId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'IIT Bombay CSE' }) goal!: string | null;
  @ApiProperty({ nullable: true, type: Number }) targetRank!: number | null;
  @ApiProperty({ nullable: true, type: Number }) dailyQuestionGoal!: number | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) targetExamDate!: string | null;
  @ApiProperty() focusTrackingOptOut!: boolean;
  @ApiPropertyOptional({ type: Number, description: 'Questions solved' }) questionsSolved?: number;
  @ApiPropertyOptional({ type: String, nullable: true }) primaryTrackName?: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) lastLoginAt!: string | null;
}

export function toUserDto(u: UserRow, extra?: { questionsSolved?: number; primaryTrackName?: string | null }): UserDto {
  return {
    id: u.id,
    tenantId: u.tenantId,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    emailVerified: u.emailVerifiedAt !== null,
    onboarded: u.onboardedAt !== null,
    primaryTrackId: u.primaryTrackId,
    primaryTrackName: extra?.primaryTrackName ?? null,
    questionsSolved: extra?.questionsSolved,
    goal: u.goalText,
    targetRank: u.targetRank,
    dailyQuestionGoal: u.dailyQuestionGoal,
    targetExamDate: u.targetExamDate,
    focusTrackingOptOut: u.focusTrackingOptOut,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  };
}

export class UserPageDto {
  @ApiProperty({ type: [UserDto] }) items!: UserDto[];
  @ApiProperty({ nullable: true, type: String, description: 'Pass as `cursor` to get the next page' })
  nextCursor!: string | null;
}
