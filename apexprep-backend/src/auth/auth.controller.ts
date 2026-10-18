import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthContext } from '../common/auth/auth-context';
import { AuthRateLimit, CurrentAuth, Public } from '../common/auth/decorators';
import { AppException } from '../common/errors/app-exception';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import type { Env } from '../config/env.schema';
import { UserDto } from '../users/user.dto';
import { AuthService, type AuthResult } from './auth.service';
import {
  AuthResponseDto,
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  ResetPasswordResponseDto,
  VerifyEmailDto,
  VerifyEmailResponseDto,
} from './dto/auth.dto';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './refresh-cookie';
import { RefreshTokensService } from './refresh-tokens.service';

/** The same words whether or not the address is registered: the endpoint must not reveal accounts. */
export const FORGOT_PASSWORD_MESSAGE = 'If an account exists for that email address, a password reset link has been sent.';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly cookieConfig: Pick<Env, 'REFRESH_COOKIE_SECURE' | 'REFRESH_COOKIE_SAMESITE'>;
  private readonly refreshInBody: boolean;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    private readonly auth: AuthService,
    private readonly refreshTokens: RefreshTokensService,
    config: ConfigService<Env, true>,
  ) {
    this.cookieConfig = {
      REFRESH_COOKIE_SECURE: config.get('REFRESH_COOKIE_SECURE', { infer: true }),
      REFRESH_COOKIE_SAMESITE: config.get('REFRESH_COOKIE_SAMESITE', { infer: true }),
    };
    this.refreshInBody = config.get('REFRESH_TOKEN_IN_BODY', { infer: true });
    this.allowedOrigins = new Set(config.get('CORS_ORIGINS', { infer: true }));
  }

  @Post('register')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a student account and sign in', description: 'Sets the HttpOnly `apx_refresh` cookie.' })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'VALIDATION_FAILED' })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'REGISTRATION_CLOSED' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'EMAIL_TAKEN' })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'RATE_LIMITED' })
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponseDto> {
    return this.respond(res, await this.auth.register(dto));
  }

  @Post('login')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password', description: 'Sets the HttpOnly `apx_refresh` cookie.' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'INVALID_CREDENTIALS' })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'ACCOUNT_DISABLED or EMAIL_NOT_VERIFIED' })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'TOO_MANY_ATTEMPTS (account locked) or RATE_LIMITED' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<AuthResponseDto> {
    return this.respond(res, await this.auth.login(dto));
  }

  @Post('refresh')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth('apx_refresh')
  @ApiOperation({
    summary: 'Exchange a refresh token for a new access token',
    description:
      'Rotates the refresh token: the presented one is revoked and a new one is issued. Presenting an already-rotated ' +
      'token revokes the whole session family (theft detection).',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'TOKEN_INVALID or TOKEN_EXPIRED' })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const token = this.presentedToken(dto, req);
    if (!token) throw AppException.unauthenticated('No refresh token provided', 'TOKEN_INVALID');
    try {
      return this.respond(res, await this.auth.refresh(token));
    } catch (err) {
      clearRefreshCookie(res, this.cookieConfig);
      throw err;
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('apx_refresh')
  @ApiOperation({ summary: 'Sign out this device (or all devices)' })
  @ApiNoContentResponse({ description: 'Always 204; unknown tokens are ignored' })
  async logout(@Body() dto: LogoutDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = this.presentedToken(dto, req);
    await this.auth.logout(token, dto.allDevices ?? false);
    clearRefreshCookie(res, this.cookieConfig);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiOkResponse({ type: UserDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  me(@CurrentAuth() auth: AuthContext): Promise<UserDto> {
    return this.auth.me(auth);
  }

  @Post('verify-email')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address with the token from the verification link' })
  @ApiOkResponse({ type: VerifyEmailResponseDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'TOKEN_INVALID (unknown, used or expired)' })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<VerifyEmailResponseDto> {
    await this.auth.verifyEmail(dto.token);
    return { emailVerified: true };
  }

  @Post('resend-verification')
  @AuthRateLimit()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a new verification email (no-op if already verified)' })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  async resendVerification(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.auth.resendVerification(auth);
  }

  @Post('forgot-password')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email a password reset link',
    description:
      'Always 202 with the same message, whether or not the address belongs to an account. At most one link per ' +
      'account per minute; a new link invalidates any earlier unused one.',
  })
  @ApiAcceptedResponse({ type: ForgotPasswordResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'VALIDATION_FAILED' })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'RATE_LIMITED' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    await this.auth.forgotPassword(dto);
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  @Post('reset-password')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password with the token from a reset link',
    description: 'The token is single-use. On success every existing session of the account is signed out.',
  })
  @ApiOkResponse({ type: ResetPasswordResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto, description: 'VALIDATION_FAILED (malformed token or password policy)' })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto, description: 'TOKEN_INVALID (unknown, used or expired)' })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'RATE_LIMITED' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<ResetPasswordResponseDto> {
    await this.auth.resetPassword(dto);
    return { passwordReset: true };
  }

  /**
   * Body token (non-browser clients) wins over the cookie. A cookie-borne token from a
   * browser origin outside the CORS allow-list is refused (defence against CSRF when the
   * cookie is configured SameSite=None).
   */
  private presentedToken(dto: RefreshDto, req: Request): string | undefined {
    if (dto.refreshToken) return dto.refreshToken;
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const fromCookie = cookies?.[REFRESH_COOKIE];
    if (typeof fromCookie !== 'string' || fromCookie.length === 0) return undefined;
    const origin = req.get('origin');
    if (origin && !this.allowedOrigins.has(origin)) {
      throw AppException.forbidden('Origin not allowed', 'ORIGIN_NOT_ALLOWED');
    }
    return fromCookie;
  }

  private respond(res: Response, result: AuthResult): AuthResponseDto {
    setRefreshCookie(res, result.refreshToken, this.refreshTokens.ttlSeconds, this.cookieConfig);
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      ...(this.refreshInBody ? { refreshToken: result.refreshToken } : {}),
      user: result.user,
    };
  }
}
