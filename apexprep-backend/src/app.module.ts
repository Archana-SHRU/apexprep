import type { ExecutionContext } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AuthorizationGuard } from './common/auth/authorization.guard';
import { AUTH_RATE_LIMIT_KEY } from './common/auth/decorators';
import { validateEnv, type Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { EngineConfigModule } from './engine-config/engine-config.module';
import { ExplanationsModule } from './explanations/explanations.module';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { LearningAiModule } from './learning-ai/learning-ai.module';
import { MockTestsModule } from './mock-tests/mock-tests.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { LearnerTracksModule } from './learner-tracks/learner-tracks.module';
import { MailModule } from './mail/mail.module';
import { PracticeModule } from './practice/practice.module';
import { QuestionsModule } from './questions/questions.module';
import { SyllabusModule } from './syllabus/syllabus.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';
import { MaintenanceModule } from './common/maintenance/maintenance.module';

function isAuthRateLimited(context: ExecutionContext): boolean {
  return Boolean(
    Reflect.getMetadata(AUTH_RATE_LIMIT_KEY, context.getHandler()) ??
      Reflect.getMetadata(AUTH_RATE_LIMIT_KEY, context.getClass()),
  );
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      // In-memory counters per API instance. When the API scales out, swap in a Redis
      // ThrottlerStorage here (planned with the queue module); nothing else changes.
      useFactory: (config: ConfigService<Env, true>) => {
        const ttl = config.get('THROTTLE_TTL_SECONDS', { infer: true }) * 1000;
        return [
          { name: 'default', ttl, limit: config.get('THROTTLE_LIMIT', { infer: true }) },
          // Stricter bucket, applied only to routes marked @AuthRateLimit() (login, register, …).
          {
            name: 'auth',
            ttl,
            limit: config.get('AUTH_THROTTLE_LIMIT', { infer: true }),
            skipIf: (context: ExecutionContext) => !isAuthRateLimited(context),
          },
        ];
      },
    }),
    DatabaseModule,
    AuditModule,
    MailModule,
    HealthModule,
    UsersModule,
    LearnerTracksModule,
    AnalyticsModule,
    TenantsModule,
    AuthModule,
    SyllabusModule,
    QuestionsModule,
    EngineConfigModule,
    PracticeModule,
    ExplanationsModule,
    IngestionModule,
    LearningAiModule,
    MockTestsModule,
    MaintenanceModule,
  ],
  providers: [
    // Order matters: rate limit → authenticate → authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
})
export class AppModule {}
