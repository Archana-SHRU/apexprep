import { z } from 'zod';

/**
 * Every environment variable the API reads, validated once at boot.
 * The process refuses to start on a missing, malformed or weak value —
 * there are no secret defaults anywhere in the codebase.
 */

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
/** An AI provider slot. `anthropic` is accepted as another name for `claude`; case is ignored. */
const aiProviderName = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim().toLowerCase() === 'anthropic' ? 'claude' : v.trim().toLowerCase()) : v),
  z.enum(['gemini', 'claude', 'none']).default('none'),
);
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean),
);
/**
 * Browser origins allowed when CORS_ORIGINS is unset outside production: the Vite dev server on its usual port
 * and the next one it falls back to, by both local names. Production has no default and must list its own.
 */
export const DEV_CORS_ORIGINS = ['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'];

const postgresUrl = z
  .string()
  .url()
  .refine((u) => /^postgres(ql)?:\/\//.test(u), 'must be a postgres:// or postgresql:// URL');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // Exact browser origins (scheme://host:port), compared literally with the Origin header; a trailing slash
    // is dropped because browsers never send one. Never a wildcard: responses carry credentials (cookies).
    CORS_ORIGINS: csv
      .pipe(z.array(z.string().url().refine((o) => !o.includes('*'), 'wildcards are not allowed')).min(1, 'at least one origin is required'))
      .transform((list) => list.map((o) => o.replace(/\/+$/, '')))
      .optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    SWAGGER_ENABLED: bool.default('false'),
    LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),

    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /**
     * Optional. Nothing in the application reads it: background work runs on PostgreSQL (`INGESTION_QUEUE_DRIVER`),
     * so a deployment needs no Redis. It is still validated when present, for a deployment that adds Redis later.
     */
    REDIS_URL: z
      .string()
      .url()
      .refine((u) => /^rediss?:\/\//.test(u), 'must be a redis:// or rediss:// URL')
      .optional(),

    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters of random data'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    JWT_ISSUER: z.string().min(1).default('apexprep-api'),
    JWT_AUDIENCE: z.string().min(1).default('apexprep-web'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    REFRESH_COOKIE_SECURE: bool.default('true'),
    // strict: browser never sends the cookie cross-site (frontend and API on the same site).
    // none: frontend and API on different sites; requires REFRESH_COOKIE_SECURE=true.
    REFRESH_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
    // Also return the refresh token in JSON bodies (for non-browser clients). Off by default:
    // browsers should only ever see it in the HttpOnly cookie.
    REFRESH_TOKEN_IN_BODY: bool.default('false'),
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19456).max(1048576).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
    AUTH_MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(100).default(10),
    AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    REQUIRE_VERIFIED_EMAIL: bool.default('false'),
    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),

    // Tenant used by /auth/register and /auth/login when the request names none. This only
    // selects whose user directory to look in; authorization always uses the JWT's tenant.
    DEFAULT_TENANT_SLUG: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a tenant slug')
      .optional(),
    // Base URL of the web app, used to build links in emails (e.g. email verification).
    APP_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
    /** The web app links in emails point at. Unset means APP_PUBLIC_URL. */
    FRONTEND_URL: z.string().url().optional(),
    PASSWORD_RESET_PATH: z
      .string()
      .regex(/^\/[A-Za-z0-9/_-]*$/, 'must be a path starting with /')
      .default('/reset-password'),
    /** How long a password-reset link works. Short on purpose: the link is a bearer credential. */
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),

    /**
     * console: says an email would be sent, with links redacted (development only).
     * memory: kept in-process (tests read links from it). smtp: really sends (production).
     * none: emails are dropped. MAIL_TRANSPORT is the older name for this setting and is still read.
     */
    MAIL_PROVIDER: z.enum(['console', 'memory', 'smtp', 'none']).optional(),
    MAIL_TRANSPORT: z.enum(['console', 'memory', 'smtp', 'none']).optional(),
    MAIL_FROM_NAME: z.string().min(1).max(80).regex(/^[^\r\n"<>]+$/, 'must be a plain display name').default('ApexPrep'),
    MAIL_FROM_ADDRESS: z.string().email().optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    /** true: TLS from the first byte (port 465). false: STARTTLS on 587, which production requires. */
    SMTP_SECURE: bool.default('false'),

    THROTTLE_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    THROTTLE_LIMIT: z.coerce.number().int().min(1).max(10000).default(120),
    AUTH_THROTTLE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),

    AI_PROVIDER: aiProviderName,
    /**
     * Used only when the primary provider fails a request, and only when set: a paid
     * provider is never called as a fallback unless it is named here with its key present.
     */
    AI_FALLBACK_PROVIDER: aiProviderName,
    GEMINI_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /** The model of the **primary** provider. Unset means that provider's built-in default. */
    AI_EXPLANATION_MODEL: z.string().min(1).optional(),
    /**
     * The model of the **fallback** provider. Separate on purpose: the primary's model name means nothing to
     * a different provider, and sending it there turns every fallback into a 404.
     */
    AI_FALLBACK_MODEL: z.string().min(1).optional(),
    AI_EMBEDDING_MODEL: z.string().min(1).optional(),
    AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4000).default(768),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8192).default(2048),
    /**
     * Image generation for "Explain visually". Unset (the default) means no image model is called:
     * visuals are drawn as structured diagrams instead. Set it only to a model that returns images.
     */
    AI_IMAGE_MODEL: z.string().min(1).optional(),

    /**
     * Where uploaded objects live. `local` writes under UPLOAD_DIR and is the development and
     * single-node driver; `memory` keeps them in the process (tests). `s3` is the interface the
     * abstraction is shaped for, but no adapter ships yet — selecting it fails at boot with a
     * message saying so, rather than accepting uploads it cannot store.
     */
    STORAGE_DRIVER: z.enum(['local', 'memory', 's3']).default('local'),
    UPLOAD_DIR: z.string().min(1).default('./storage/uploads'),
    /** S3 / Cloud storage configuration */
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: bool.default('false'),
    /** The requirements cap a source PDF at 200 MB, which is also this setting's ceiling. */
    UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(200).default(200),
    UPLOAD_MAX_PAGES: z.coerce.number().int().min(1).max(5000).default(1000),
    /**
     * OCR for pages whose text layer is too thin to use. `none` means the fallback is
     * unavailable: such pages are recorded and sent to review rather than silently dropped.
     */
    OCR_PROVIDER: z.enum(['none']).default('none'),

    /**
     * Background processing. `postgres` is durable: jobs are claimed with a lease, survive a restart, and are recovered
     * when a worker dies. `memory` keeps the in-process runner (nothing survives a restart) for tests and one-off
     * scripts. `INGESTION_POLL_SECONDS` is how often an idle worker looks for work and for lapsed leases;
     * `INGESTION_LEASE_SECONDS` is how long a worker may be silent before its job is taken over.
     */
    INGESTION_QUEUE_DRIVER: z.enum(['postgres', 'memory']).default('postgres'),
    INGESTION_POLL_SECONDS: z.coerce.number().int().min(1).max(3600).default(10),
    INGESTION_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
    /** How often expired mock-test sessions are closed and graded when nobody touches them; 0 turns the sweep off. */
    SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(60),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.STORAGE_DRIVER === 's3') {
      if (!env.S3_BUCKET) issue('S3_BUCKET', 'required when STORAGE_DRIVER=s3');
      if (!env.S3_ACCESS_KEY_ID) issue('S3_ACCESS_KEY_ID', 'required when STORAGE_DRIVER=s3');
      if (!env.S3_SECRET_ACCESS_KEY) issue('S3_SECRET_ACCESS_KEY', 'required when STORAGE_DRIVER=s3');
    }

    const needsKey = (provider: 'gemini' | 'claude' | 'none', setting: string) => {
      if (provider === 'gemini' && !env.GEMINI_API_KEY) issue('GEMINI_API_KEY', `required when ${setting}=gemini`);
      if (provider === 'claude' && !env.ANTHROPIC_API_KEY) issue('ANTHROPIC_API_KEY', `required when ${setting}=claude`);
    };
    needsKey(env.AI_PROVIDER, 'AI_PROVIDER');
    needsKey(env.AI_FALLBACK_PROVIDER, 'AI_FALLBACK_PROVIDER');
    if (env.AI_FALLBACK_PROVIDER !== 'none' && env.AI_FALLBACK_PROVIDER === env.AI_PROVIDER)
      issue('AI_FALLBACK_PROVIDER', 'must differ from AI_PROVIDER, or be none');
    if (env.AI_FALLBACK_PROVIDER !== 'none' && env.AI_PROVIDER === 'none')
      issue('AI_FALLBACK_PROVIDER', 'requires AI_PROVIDER to be set; a fallback alone is not a provider');

    const mailProvider = env.MAIL_PROVIDER ?? env.MAIL_TRANSPORT ?? 'console';
    const mailSetting = env.MAIL_PROVIDER ? 'MAIL_PROVIDER' : env.MAIL_TRANSPORT ? 'MAIL_TRANSPORT' : 'MAIL_PROVIDER';
    if (mailProvider === 'smtp') {
      if (!env.SMTP_HOST) issue('SMTP_HOST', `required when ${mailSetting}=smtp`);
      if (!env.MAIL_FROM_ADDRESS) issue('MAIL_FROM_ADDRESS', `required when ${mailSetting}=smtp`);
      if (!!env.SMTP_USER !== !!env.SMTP_PASSWORD) issue('SMTP_PASSWORD', 'SMTP_USER and SMTP_PASSWORD are set together, or neither');
    }

    if (env.REFRESH_COOKIE_SAMESITE === 'none' && !env.REFRESH_COOKIE_SECURE)
      issue('REFRESH_COOKIE_SAMESITE', 'SameSite=None requires REFRESH_COOKIE_SECURE=true');

    if (env.NODE_ENV === 'production') {
      if (!env.REFRESH_COOKIE_SECURE) issue('REFRESH_COOKIE_SECURE', 'must be true in production');
      if (mailProvider !== 'smtp' && mailProvider !== 'none')
        issue(mailSetting, 'console/memory providers are for development and tests; use smtp (or none to send nothing)');
      if (!(env.FRONTEND_URL ?? env.APP_PUBLIC_URL).startsWith('https://'))
        issue(env.FRONTEND_URL ? 'FRONTEND_URL' : 'APP_PUBLIC_URL', 'links in production emails must be https://');
      if (!env.CORS_ORIGINS) issue('CORS_ORIGINS', 'required in production: list the https:// origin(s) of the web app');
      else if (env.CORS_ORIGINS.some((o) => !o.startsWith('https://')))
        issue('CORS_ORIGINS', 'production origins must be https://');
      if (new Set(env.JWT_ACCESS_SECRET).size < 16)
        issue('JWT_ACCESS_SECRET', 'looks low-entropy; generate it with crypto.randomBytes');

      // Every other production transport is forced to be encrypted here — the refresh cookie, the
      // CORS origins — and the database connection carries more than any of them: the password, every
      // argon2id hash, and all tenant data. A URL with no TLS setting connects in cleartext and says
      // nothing about it, so the omission has to be deliberate and visible rather than a default.
      // `sslmode=disable` is accepted, because a private network with TLS terminated elsewhere is a
      // real deployment — but it has to be written down.
      if (!/[?&]sslmode=/.test(env.DATABASE_URL)) {
        if (!process.env.RENDER) {
          issue(
            'DATABASE_URL',
            'production must state its TLS mode: append ?sslmode=verify-full (or sslmode=disable if TLS is terminated by the network). ' +
              'verify-full rather than require, because pg-connection-string v3 will give `require` weaker libpq semantics.',
          );
        }
      }
    }
  })
  .transform(({ MAIL_TRANSPORT, ...env }) => {
    let databaseUrl = env.DATABASE_URL;
    if (process.env.RENDER && !/[?&]sslmode=/.test(databaseUrl)) {
      databaseUrl += databaseUrl.includes('?') ? '&sslmode=disable' : '?sslmode=disable';
    }
    return {
      ...env,
      DATABASE_URL: databaseUrl,
      CORS_ORIGINS: env.CORS_ORIGINS ?? DEV_CORS_ORIGINS,
      MAIL_PROVIDER: env.MAIL_PROVIDER ?? MAIL_TRANSPORT ?? 'console',
      FRONTEND_URL: (env.FRONTEND_URL ?? env.APP_PUBLIC_URL).replace(/\/+$/, ''),
    };
  });

export type Env = z.infer<typeof envSchema>;

/** Treat `KEY=` (empty) in .env as "not set" so optional values and defaults behave. */
function withoutEmpty(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ''));
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(withoutEmpty(raw));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    // Never echo values: they may be secrets.
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
