import { Logger, VersioningType } from '@nestjs/common';
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

  // Configure CORS allow-list from environment, frontend URLs, and Vercel preview patterns
  const configuredOrigins = config.get('CORS_ORIGINS', { infer: true }) ?? [];
  const frontendUrl = config.get('FRONTEND_URL', { infer: true });
  const appPublicUrl = config.get('APP_PUBLIC_URL', { infer: true });

  const allowedOrigins: (string | RegExp)[] = [];
  const seenOrigins = new Set<string>();

  const registerOrigin = (raw?: string | null) => {
    if (!raw) return;
    const clean = raw.trim().replace(/\/+$/, '');
    const lower = clean.toLowerCase();
    if (clean && !seenOrigins.has(lower)) {
      seenOrigins.add(lower);
      allowedOrigins.push(clean);
    }
  };

  for (const origin of configuredOrigins) {
    registerOrigin(origin);
  }
  registerOrigin(frontendUrl);
  registerOrigin(appPublicUrl);

  // Explicit deployed origins
  registerOrigin('https://apexprep-dpdhyvhg1-archana-shrus-projects.vercel.app');
  registerOrigin('https://apexprep.vercel.app');

  // Vercel deployment patterns for ApexPrep
  const vercelPatterns = [
    /^https:\/\/apexprep(-[a-z0-9-]+)?\.vercel\.app$/i,
    /^https:\/\/apexprep(-[a-z0-9-]+)?-archana-shrus-projects\.vercel\.app$/i,
  ];
  for (const pattern of vercelPatterns) {
    allowedOrigins.push(pattern);
  }

  // CORS runs before request body/cookie parsing so preflight OPTIONS requests are answered immediately
  app.enableCors({
    origin: (requestOrigin, callback) => {
      if (requestOrigin) {
        const normalized = requestOrigin.trim().replace(/\/+$/, '');
        const isAllowed = allowedOrigins.some((allowed) =>
          typeof allowed === 'string'
            ? allowed.toLowerCase() === normalized.toLowerCase()
            : allowed.test(normalized),
        );
        if (!isAllowed) {
          // Safe diagnostic: log rejected origin without logging headers, cookies, or body
          const safeOrigin = requestOrigin.replace(/[\r\n\t]/g, '').slice(0, 200);
          Logger.warn(`[CORS] Rejected request from unauthorized origin: ${safeOrigin}`, 'Cors');
        }
      }
      callback(null, allowedOrigins as any);
    },
    credentials: true, // the refresh token travels in an HttpOnly cookie
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    // X-Filename carries the original name of an uploaded PDF (admin ingestion); without it here a browser's
    // preflight refuses the upload from the app's own origin.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Filename',
      'Accept',
      'Origin',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

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
