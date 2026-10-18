import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { UserDto } from '../../users/user.dto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password.service';
import { OPAQUE_TOKEN_PATTERN } from '../token.service';

const normaliseEmail = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class RegisterDto {
  @ApiProperty({ example: 'Arjun Verma', minLength: 1, maxLength: 120 })
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  displayName!: string;

  @ApiProperty({ example: 'arjun@example.com', maxLength: 254 })
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH, format: 'password' })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
    message: `password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
  })
  password!: string;

  @ApiPropertyOptional({
    example: 'dev-sandbox',
    description: 'Organisation to join. Defaults to the server\'s DEFAULT_TENANT_SLUG.',
  })
  @IsOptional()
  @IsString()
  @Matches(SLUG, { message: 'tenantSlug must be a lowercase slug' })
  @MaxLength(63)
  tenantSlug?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'arjun@example.com' })
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @Length(1, PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({ example: 'dev-sandbox', description: 'Defaults to the server\'s DEFAULT_TENANT_SLUG.' })
  @IsOptional()
  @IsString()
  @Matches(SLUG, { message: 'tenantSlug must be a lowercase slug' })
  @MaxLength(63)
  tenantSlug?: string;
}

export class RefreshDto {
  @ApiPropertyOptional({
    description: 'For non-browser clients. Browsers send the HttpOnly apx_refresh cookie instead.',
  })
  @IsOptional()
  @IsString()
  @Matches(OPAQUE_TOKEN_PATTERN, { message: 'refreshToken is malformed' })
  refreshToken?: string;
}

export class LogoutDto extends RefreshDto {
  @ApiPropertyOptional({ description: 'Sign out every device and invalidate all access tokens', default: false })
  @IsOptional()
  @IsBoolean()
  allDevices?: boolean;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token from the verification link' })
  @IsString()
  @Matches(OPAQUE_TOKEN_PATTERN, { message: 'token is malformed' })
  token!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'arjun@example.com', maxLength: 254 })
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({ example: 'dev-sandbox', description: "Defaults to the server's DEFAULT_TENANT_SLUG." })
  @IsOptional()
  @IsString()
  @Matches(SLUG, { message: 'tenantSlug must be a lowercase slug' })
  @MaxLength(63)
  tenantSlug?: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token from the password reset link' })
  @IsString()
  @Matches(OPAQUE_TOKEN_PATTERN, { message: 'token is malformed' })
  token!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH, format: 'password' })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
    message: `password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
  })
  password!: string;
}

export class ForgotPasswordResponseDto {
  @ApiProperty({ example: 'If an account exists for that email address, a password reset link has been sent.' })
  message!: string;
}

export class ResetPasswordResponseDto {
  @ApiProperty({ example: true }) passwordReset!: true;
}

export class AuthResponseDto {
  @ApiProperty({ description: 'Short-lived JWT; send as `Authorization: Bearer <token>`' }) accessToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: 'Bearer';
  @ApiProperty({ description: 'Access token lifetime in seconds', example: 900 }) expiresIn!: number;
  @ApiPropertyOptional({
    description: 'Only when REFRESH_TOKEN_IN_BODY=true (non-browser clients). Browsers get the HttpOnly cookie.',
  })
  refreshToken?: string;
  @ApiProperty({ type: UserDto }) user!: UserDto;
}

export class VerifyEmailResponseDto {
  @ApiProperty({ example: true }) emailVerified!: true;
}
