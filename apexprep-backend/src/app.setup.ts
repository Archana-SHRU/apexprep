import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { rawBodyMiddleware } from './common/http/raw-body';
import { requestContextMiddleware } from './common/request-context/request-context';
import { createValidationPipe } from './common/validation/validation';
import type { Env } from './config/env.schema';

/**
 * Everything that shapes HTTP behaviour, in one place so main.ts and the e2e tests run
 * the exact same stack: request ids, security headers, cookies, CORS, /v1 versioning,
 * validation, error format and Swagger.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Only trust X-Forwarded-For from the configured number of proxy hops.
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  app.disable('x-powered-by');

  // First in the chain, as `requestContextMiddleware` documents: it opens the per-request context that carries
  // the request id (echoed as X-Request-Id and in every error body) and, once JwtAuthGuard has run, the
  // principal the audit writer attributes a change to. Without it every audit row is written as SYSTEM.
  app.use(requestContextMiddleware);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  // Source PDFs (POST /v1/admin/ingestion/assets) arrive as the raw body. The ceiling is the same
  // UPLOAD_MAX_MB the upload service checks, applied here so an oversized file is refused while it
  // is being read instead of after all of it has been held in memory.
  app.use(rawBodyMiddleware('application/pdf', config.get('UPLOAD_MAX_MB', { infer: true }) * 1024 * 1024));
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true, // the refresh token travels in an HttpOnly cookie
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    // X-Filename carries the original name of an uploaded PDF (admin ingestion); without it here a browser's
    // preflight refuses the upload from the app's own origin.
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-Filename'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); // → /v1/...
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('ApexPrep API')
        .setDescription(
          'Adaptive learning and question practice platform. All routes are under /v1. ' +
            'Errors always have the shape { "error": { "code", "message", "details"?, "requestId" } }.',
        )
        .setVersion('1')
        .addBearerAuth()
        .addCookieAuth('apx_refresh', { type: 'apiKey', in: 'cookie', name: 'apx_refresh' })
        .build(),
    );
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  }
}
