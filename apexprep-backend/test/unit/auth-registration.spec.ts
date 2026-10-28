import { ConfigService } from '@nestjs/config';
import { AppException } from '../../src/common/errors/app-exception';
import { AuthService } from '../../src/auth/auth.service';
import { AuthController } from '../../src/auth/auth.controller';
import { AuthorizationGuard } from '../../src/common/auth/authorization.guard';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { TenantRow, UserRow } from '../../src/database/schema';

describe('Auth Registration & Session Guard Unit Tests', () => {
  const dummyTenant: TenantRow = {
    id: 'd0000000-0000-4000-8000-000000000001',
    slug: 'dev-sandbox',
    name: 'ApexPrep Sandbox',
    status: 'active',
    benchmarkingEnabled: true,
    focusTrackingEnabled: true,
    selfRegistrationEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const dummyUser: UserRow = {
    id: 'u0000000-0000-4000-8000-000000000001',
    tenantId: dummyTenant.id,
    email: 'newuser@example.test',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$dummyhash',
    role: 'STUDENT',
    displayName: 'New Student',
    status: 'active',
    primaryTrackId: null,
    goalText: null,
    targetRank: null,
    dailyQuestionGoal: null,
    targetExamDate: null,
    emailVerifiedAt: null,
    onboardedAt: null,
    focusTrackingOptOut: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockDb = {
    transaction: jest.fn(async (cb) => cb({})),
  };

  const mockUsers = {
    insert: jest.fn().mockResolvedValue(dummyUser),
    findById: jest.fn().mockResolvedValue(dummyUser),
  };

  const mockTenants = {
    findBySlug: jest.fn(),
  };

  const mockPasswords = {
    hash: jest.fn().mockResolvedValue('$argon2id$v=19$m=19456,t=2,p=1$dummyhash'),
    verify: jest.fn(),
  };

  const mockTokens = {
    signAccessToken: jest.fn().mockReturnValue('mock.access.token'),
    accessTtlSeconds: 900,
  };

  const mockRefreshTokens = {
    issue: jest.fn().mockResolvedValue({ token: 'mock-refresh-token' }),
    rotate: jest.fn(),
  };

  const mockEmailVerification = {
    issue: jest.fn().mockResolvedValue(jest.fn()),
  };

  const mockAudit = {
    record: jest.fn().mockResolvedValue(undefined),
  };

  const mockMail = {
    dispatch: jest.fn(),
  };

  const mockPasswordResets = {
    issue: jest.fn(),
    ttlMinutes: 60,
  };

  const config = new ConfigService({
    FRONTEND_URL: 'http://localhost:5173',
    PASSWORD_RESET_PATH: '/reset-password',
    DEFAULT_TENANT_SLUG: 'dev-sandbox',
    AUTH_MAX_FAILED_LOGINS: 5,
    AUTH_LOCKOUT_MINUTES: 15,
    REQUIRE_VERIFIED_EMAIL: false,
    REFRESH_COOKIE_SECURE: false,
    REFRESH_COOKIE_SAMESITE: 'lax',
    REFRESH_TOKEN_IN_BODY: false,
    CORS_ORIGINS: 'http://localhost:5173',
  });

  let authService: AuthService;
  let authController: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    authService = new AuthService(
      mockDb as never,
      mockUsers as never,
      mockTenants as never,
      mockPasswords as never,
      mockTokens as never,
      mockRefreshTokens as never,
      mockEmailVerification as never,
      mockAudit as never,
      mockMail as never,
      mockPasswordResets as never,
      config as never,
    );
    authController = new AuthController(
      authService,
      mockRefreshTokens as never,
      config as never,
    );
  });

  describe('Registration flow', () => {
    it('successfully registers a student when tenant exists and allows self-registration', async () => {
      mockTenants.findBySlug.mockResolvedValue(dummyTenant);

      const result = await authService.register({
        email: 'newuser@example.test',
        password: 'ValidPassword123!',
        displayName: 'New Student',
      });

      expect(mockTenants.findBySlug).toHaveBeenCalledWith('dev-sandbox');
      expect(mockUsers.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'newuser@example.test',
          tenantId: dummyTenant.id,
          role: 'STUDENT',
        }),
        expect.anything(),
      );
      expect(result).toMatchObject({
        accessToken: 'mock.access.token',
        refreshToken: 'mock-refresh-token',
        user: expect.objectContaining({
          email: 'newuser@example.test',
          role: 'STUDENT',
        }),
      });
    });

    it('throws 404 TENANT_NOT_FOUND (Unknown organisation) when organisation does not exist', async () => {
      mockTenants.findBySlug.mockResolvedValue(undefined);

      try {
        await authService.register({
          email: 'newuser@example.test',
          password: 'ValidPassword123!',
          displayName: 'New Student',
          tenantSlug: 'non-existent-org',
        });
        fail('Expected register to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        const appErr = err as AppException;
        expect(appErr.getStatus()).toBe(404);
        expect(appErr.code).toBe('TENANT_NOT_FOUND');
        expect(appErr.message).toBe('Unknown organisation');
      }
    });

    it('throws 403 REGISTRATION_CLOSED when organisation has disabled self-registration', async () => {
      mockTenants.findBySlug.mockResolvedValue({
        ...dummyTenant,
        selfRegistrationEnabled: false,
      });

      try {
        await authService.register({
          email: 'newuser@example.test',
          password: 'ValidPassword123!',
          displayName: 'New Student',
        });
        fail('Expected register to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        const appErr = err as AppException;
        expect(appErr.getStatus()).toBe(403);
        expect(appErr.code).toBe('REGISTRATION_CLOSED');
      }
    });
  });

  describe('Missing authentication sessions', () => {
    it('POST /v1/auth/refresh returns 401 TOKEN_INVALID when no refresh token/cookie is presented', async () => {
      const mockReq = { cookies: {}, headers: {} } as never;
      const mockRes = { cookie: jest.fn(), clearCookie: jest.fn() } as never;

      await expect(
        authController.refresh({}, mockReq, mockRes),
      ).rejects.toThrow(
        expect.objectContaining({
          status: 401,
          code: 'TOKEN_INVALID',
          message: 'No refresh token provided',
        }),
      );
    });

    it('AuthorizationGuard returns 401 for protected endpoints when request lacks authentication principal', () => {
      const guard = new AuthorizationGuard(new Reflector());
      const context = {
        getHandler: () => () => undefined,
        getClass: () => class {},
        switchToHttp: () => ({
          getRequest: () => ({ auth: undefined }),
        }),
      } as unknown as ExecutionContext;

      try {
        guard.canActivate(context);
        fail('Expected guard to throw 401');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).getStatus()).toBe(401);
      }
    });
  });
});
