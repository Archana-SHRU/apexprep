import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { permissionsFor } from '../common/auth/permissions';
import { AppException } from '../common/errors/app-exception';
import type { Env } from '../config/env.schema';
import { DRIZZLE, type Database } from '../database/database.module';
import { isUniqueViolation } from '../database/pg-error';
import { MailService } from '../mail/mail.service';
import { passwordResetEmail, registrationWelcomeEmail } from '../mail/templates';
import type { TenantRow, UserRow } from '../database/schema';
import { TenantsRepository } from '../tenants/tenants.repository';
import { toUserDto, type UserDto } from '../users/user.dto';
import { UsersRepository } from '../users/users.repository';
import type { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';
import { EmailVerificationService } from './email-verification.service';
import { PasswordResetService } from './password-reset.service';
import { passwordPolicyViolation, PasswordService } from './password.service';
import { RefreshTokensService } from './refresh-tokens.service';
import { TokenService } from './token.service';

export interface AuthResult {
  user: UserDto;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

const INVALID_CREDENTIALS = () =>
  AppException.unauthenticated('Invalid email or password', 'INVALID_CREDENTIALS');

const RESET_TOKEN_INVALID = () =>
  AppException.unprocessable('This password reset link is invalid or has expired. Request a new one.', 'TOKEN_INVALID');

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly defaultTenantSlug?: string;
  private readonly frontendUrl: string;
  private readonly resetPath: string;
  private readonly maxFailedLogins: number;
  private readonly lockoutMinutes: number;
  private readonly requireVerifiedEmail: boolean;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly users: UsersRepository,
    private readonly tenants: TenantsRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly emailVerification: EmailVerificationService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly passwordResets: PasswordResetService,
    config: ConfigService<Env, true>,
  ) {
    this.frontendUrl = config.get('FRONTEND_URL', { infer: true });
    this.resetPath = config.get('PASSWORD_RESET_PATH', { infer: true });
    this.defaultTenantSlug = config.get('DEFAULT_TENANT_SLUG', { infer: true });
    this.maxFailedLogins = config.get('AUTH_MAX_FAILED_LOGINS', { infer: true });
    this.lockoutMinutes = config.get('AUTH_LOCKOUT_MINUTES', { infer: true });
    this.requireVerifiedEmail = config.get('REQUIRE_VERIFIED_EMAIL', { infer: true });
  }

  /**
   * Which tenant's user directory a register/login request refers to. This only selects
   * where to look; it grants nothing. After login, the tenant comes solely from the JWT.
   */
  private async resolveTenant(slug: string | undefined): Promise<TenantRow | undefined> {
    const effective = slug ?? this.defaultTenantSlug;
    if (!effective) return undefined;
    const tenant = await this.tenants.findBySlug(effective);
    return tenant?.status === 'active' ? tenant : undefined;
  }

  async register(dto: RegisterDto): Promise<AuthResult> {
    const tenant = await this.resolveTenant(dto.tenantSlug);
    if (!tenant) throw AppException.notFound('Unknown organisation', 'TENANT_NOT_FOUND');
    if (!tenant.selfRegistrationEnabled) {
      throw AppException.forbidden('Registration is not open for this organisation', 'REGISTRATION_CLOSED');
    }
    const violation = passwordPolicyViolation(dto.password, dto.email);
    if (violation) throw AppException.validation([{ field: 'password', message: violation }]);

    const passwordHash = await this.passwords.hash(dto.password);
    let sendVerification: () => void;
    let result: { user: UserRow; refreshToken: string };
    try {
      result = await this.db.transaction(async (tx) => {
        const user = await this.users.insert(
          { tenantId: tenant.id, email: dto.email, passwordHash, role: 'STUDENT', displayName: dto.displayName },
          tx,
        );
        sendVerification = await this.emailVerification.issue(tx, user);
        const { token } = await this.refreshTokens.issue(tx, { tenantId: tenant.id, userId: user.id });
        await this.audit.record(
          {
            tenantId: tenant.id,
            actor: { userId: user.id, role: 'STUDENT' },
            action: 'user.registered',
            entityType: 'user',
            entityId: user.id,
          },
          tx,
        );
        return { user, refreshToken: token };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'users_tenant_email_uq')) {
        throw AppException.conflict('An account with this email already exists', 'EMAIL_TAKEN');
      }
      throw err;
    }
    // After commit, and best effort: a mail outage must not fail a registration that already succeeded.
    // Sent once per account — a repeated registration with the same email is EMAIL_TAKEN and sends nothing.
    this.mail.dispatch(
      registrationWelcomeEmail({ to: result.user.email, displayName: result.user.displayName, signInUrl: `${this.frontendUrl}/login` }),
    );
    sendVerification!();
    return this.buildResult(result.user, result.refreshToken);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const tenant = await this.resolveTenant(dto.tenantSlug);
    const user = tenant ? await this.users.findByEmail(tenant.id, dto.email) : undefined;
    if (!user) {
      await this.passwords.burnVerification(dto.password);
      throw INVALID_CREDENTIALS();
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_ATTEMPTS',
        'Too many failed sign-in attempts. Try again later.',
        undefined,
        { 'Retry-After': String(retryAfter) },
      );
    }
    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      await this.users.recordFailedLogin(user.tenantId, user.id, this.maxFailedLogins, this.lockoutMinutes);
      throw INVALID_CREDENTIALS();
    }
    // Checked only after a correct password, so these states can't be probed without it.
    if (user.status !== 'active') throw AppException.forbidden('This account has been disabled', 'ACCOUNT_DISABLED');
    if (this.requireVerifiedEmail && !user.emailVerifiedAt) {
      throw AppException.forbidden('Verify your email address before signing in', 'EMAIL_NOT_VERIFIED');
    }

    const rehashed = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(dto.password)
      : undefined;
    // The update returns the row it wrote, so the login path does not read the user back a second
    // time purely to pick up `last_login_at` and `token_version`.
    const fresh = await this.users.recordSuccessfulLogin(user.tenantId, user.id, rehashed);
    const { token } = await this.db.transaction((tx) =>
      this.refreshTokens.issue(tx, { tenantId: user.tenantId, userId: user.id }),
    );
    return this.buildResult(fresh ?? user, token);
  }

  async refresh(presented: string): Promise<AuthResult> {
    const outcome = await this.refreshTokens.rotate(presented);
    switch (outcome.kind) {
      case 'expired':
        throw AppException.unauthenticated('Session has expired. Please sign in again.', 'TOKEN_EXPIRED');
      case 'invalid':
      case 'reused':
        throw AppException.unauthenticated('Session is no longer valid. Please sign in again.', 'TOKEN_INVALID');
      case 'rotated': {
        const principal = await this.loadPrincipal(outcome.userId, outcome.tenantId);
        const user = principal ? await this.users.findById(outcome.tenantId, outcome.userId) : undefined;
        if (!principal || !user) {
          await this.db.transaction((tx) => this.refreshTokens.revokeFamily(tx, outcome.familyId, 'admin'));
          throw AppException.unauthenticated('Session is no longer valid. Please sign in again.', 'TOKEN_INVALID');
        }
        return this.buildResult(user, outcome.token);
      }
    }
  }

  /**
   * Revokes the presented refresh token's family (this device). With allDevices, revokes
   * every session of the user and bumps token_version so outstanding access tokens stop
   * working immediately. Unknown tokens are ignored: logout is idempotent.
   */
  async logout(presented: string | undefined, allDevices: boolean): Promise<void> {
    if (!presented) return;
    const owner = await this.refreshTokens.revokeByToken(presented, 'logout');
    if (!owner || !allDevices) return;
    await this.db.transaction(async (tx) => {
      await this.refreshTokens.revokeAllForUser(tx, owner.tenantId, owner.userId, 'logout');
      await this.users.bumpTokenVersion(owner.tenantId, owner.userId, tx);
    });
  }

  async me(auth: AuthContext): Promise<UserDto> {
    const user = await this.users.findById(auth.tenantId, auth.userId);
    if (!user) throw AppException.unauthenticated();
    return toUserDto(user);
  }

  async verifyEmail(token: string): Promise<void> {
    if (!(await this.emailVerification.verify(token))) {
      throw AppException.unprocessable('This verification link is invalid or has expired', 'TOKEN_INVALID');
    }
  }

  async resendVerification(auth: AuthContext): Promise<void> {
    const user = await this.users.findById(auth.tenantId, auth.userId);
    if (!user || user.emailVerifiedAt) return;
    const send = await this.db.transaction((tx) => this.emailVerification.issue(tx, user));
    send();
  }

  /**
   * Always resolves the same way, whether or not the email belongs to an account, so the endpoint cannot
   * be used to discover who is registered. For a real, active account the link is issued and emailed in
   * the background: the response does not wait on the database writes or the mail server, which also
   * keeps its timing the same for known and unknown addresses.
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const tenant = await this.resolveTenant(dto.tenantSlug);
    const user = tenant ? await this.users.findByEmail(tenant.id, dto.email) : undefined;
    if (!user || user.status !== 'active') return;
    void this.sendPasswordReset(user).catch((err: unknown) => {
      this.logger.warn(`Password reset could not be issued: ${(err as { code?: string }).code ?? 'UNKNOWN'}`);
    });
  }

  private async sendPasswordReset(user: UserRow): Promise<void> {
    const token = await this.passwordResets.issue(user);
    if (!token) {
      // Server-side only (the response is identical either way), and without the address.
      this.logger.log('Password reset not re-sent: a link was issued for this account less than a minute ago');
      return;
    }
    await this.audit.record({
      tenantId: user.tenantId,
      actor: null,
      action: 'auth.password_reset_requested',
      entityType: 'user',
      entityId: user.id,
    });
    const resetUrl = `${this.frontendUrl}${this.resetPath}?token=${token}`;
    this.mail.dispatch(passwordResetEmail({ to: user.email, displayName: user.displayName, resetUrl, ttlMinutes: this.passwordResets.ttlMinutes }));
  }

  /**
   * Sets a new password with a reset token. Afterwards every session of the user is gone: refresh tokens
   * are revoked and token_version is bumped, so access tokens already issued stop working too.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const owner = await this.passwordResets.peek(dto.token);
    const user = owner ? await this.users.findById(owner.tenantId, owner.userId) : undefined;
    if (!owner || !user || user.status !== 'active') throw RESET_TOKEN_INVALID();
    const violation = passwordPolicyViolation(dto.password, user.email);
    if (violation) throw AppException.validation([{ field: 'password', message: violation }]);
    const passwordHash = await this.passwords.hash(dto.password);

    await this.db.transaction(async (tx) => {
      const consumed = await this.passwordResets.consume(tx, dto.token);
      if (!consumed || consumed.userId !== user.id) throw RESET_TOKEN_INVALID();
      await this.users.update(user.tenantId, user.id, { passwordHash, failedLoginCount: 0, lockedUntil: null }, tx);
      await this.users.bumpTokenVersion(user.tenantId, user.id, tx);
      await this.refreshTokens.revokeAllForUser(tx, user.tenantId, user.id, 'password_change');
      await this.passwordResets.discardOpen(tx, user);
      await this.audit.record(
        { tenantId: user.tenantId, actor: null, action: 'auth.password_reset', entityType: 'user', entityId: user.id },
        tx,
      );
    });
  }

  /**
   * Current principal from the database, or null if the user was deleted or disabled or the
   * tenant is suspended. Used on every authenticated request (JwtAuthGuard).
   */
  async loadPrincipal(userId: string, tenantId: string, tokenVersion?: number): Promise<AuthContext | null> {
    const row = await this.users.findPrincipal(userId, tenantId);
    if (!row || row.status !== 'active' || row.tenantStatus !== 'active' || row.tenantDeletedAt) return null;
    if (tokenVersion !== undefined && row.tokenVersion !== tokenVersion) return null;
    return {
      userId: row.id,
      tenantId: row.tenantId,
      role: row.role,
      permissions: permissionsFor(row.role),
      tokenVersion: row.tokenVersion,
    };
  }

  private buildResult(user: UserRow, refreshToken: string): AuthResult {
    return {
      user: toUserDto(user),
      accessToken: this.tokens.signAccessToken({
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
        tokenVersion: user.tokenVersion,
      }),
      expiresIn: this.tokens.accessTtlSeconds,
      refreshToken,
    };
  }
}
