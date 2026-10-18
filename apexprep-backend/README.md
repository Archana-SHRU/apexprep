# ApexPrep Backend

API for the ApexPrep adaptive learning and question-practice platform (JEE, NEET, and the
Physics, Chemistry, Mathematics and Astronomy Olympiads). NestJS 11 + Drizzle ORM +
PostgreSQL 16 / pgvector + Redis / BullMQ, built as a modular monolith. This is a separate
project from `apexprep-frontend`, which is not modified.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): stack choices, modules, data model, security, phase plan
- [docs/FRONTEND-CONTRACT.md](docs/FRONTEND-CONTRACT.md): every frontend data call mapped to an endpoint, plus the conflicts
- [docs/DECISIONS.md](docs/DECISIONS.md): ambiguities, the defaults chosen, and values pending the requirements document

## Status: Phase 8 (a general adaptive learning platform: school, competitive exams and Olympiads)

| Area | State |
| --- | --- |
| Database schema, migrations 0001–0014, dev seed | Done. 181 SQL assertions pass. Migration 0007 (pgvector) still needs the Docker image to run. |
| Auth: register, login, refresh (rotating), logout, me, email verification | Done and tested |
| Users: student profile/onboarding, admin student list, enable/disable | Done and tested |
| Tenants: super-admin organisation management, staff creation | Done and tested |
| RBAC and tenant isolation (global guards, permission map) | Done and tested |
| Syllabus: tracks → subjects → chapters → topics → sub-topics, one-call tree, admin authoring | Done and tested |
| Theory by sub-topic (published blocks, reading estimate) and theory authoring | Done and tested |
| Question bank: 7 question types, per-type answer validation, publish/retire, official solutions | Done and tested |
| Student-safe question projection (no answer key, no solution, no engine difficulty) | Done and tested |
| Adaptive engine core: Elo updates, stepped K, ladder, guards, guesses, probes, decay, selection | Done and tested against the stated requirements |
| Engine configuration: immutable versions, activation, full parameter validation | Done and tested |
| Practice flow: start a session, get the next question, submit an attempt, adaptive update | Done and tested |
| Immutable attempts, server-side grading of all 7 types, idempotent submission | Done and tested |
| Ability projection (θ, level, ladder counters) rebuildable from the attempts alone | Done and tested |
| Explanations: official solution → RAG grounded in published theory → general knowledge | Done and tested |
| Grounding score and bands, answer-mismatch hard block, mandatory approval, reporting/unpublish | Done and tested |
| AI provider abstraction (Gemini primary, Claude fallback), keys only in server env | Done; **no external provider call was executed** (see below) |
| Uploading a source PDF: size, type-by-header, encryption, page limit, SHA-256 duplicate | Done and tested |
| Object storage behind a provider-independent boundary (local, in-memory; S3 refuses at boot) | Done and tested |
| Ingestion jobs: observable stages, retry-safe, idempotent, failures recorded with a stable code | Done and tested |
| Text extraction from the PDF's own text layer, page by page | Done and tested |
| OCR fallback for pages whose text layer is too thin | Boundary done; **no OCR provider is installable here** (see below) |
| Block classification (theory / question / solution / ambiguous) with a reason and a confidence | Done and tested |
| Syllabus mapping to existing published sub-topics only; a proposal never creates a node | Done and tested |
| Question and option extraction for the Phase 3 types, reusing Phase 3's own validator | Done and tested |
| Solution matching by numbering, stated answer, proximity and term overlap | Done and tested |
| Near-duplicate detection against the existing bank (pg_trgm, engine-config threshold) | Done and tested |
| Human review: approve, reject, edit (autosave), reclassify, merge, split, all audited | Done and tested |
| Quality gates blocking publication; auto-approval rules; 5 % audit sampling | Done and tested |
| Publishing through the Phase 3 question service, so there is one question model | Done and tested |
| **Learning contexts: a track says what it is** (school · competitive exam · Olympiad · other, with grade, curriculum and locale) | Done and tested |
| **A learner in several tracks at once**, with one primary track guaranteed by the database | Done and tested |
| **Mastery isolated per track**, structurally — a learner in three tracks has three independent sets | Done and tested |
| **§6.4 expected-time calibration**: the observed median replaces the admin's estimate at `calibration_n` 30 | Done, tested, and verified live |
| **Olympiad safety rules keyed on `tracks.kind`**, not on a track's name | Done and tested |
| Analytics, reports, admin review UI | Not built |

Verified in Phase 8: `npm run build`, `npm run typecheck`, `npm run lint` and `npm test`
(938 Jest tests: 556 unit, 382 e2e against a real PostgreSQL 16) all pass, as does
`test:sql` (181 SQL assertions). Both migration paths were verified against real PostgreSQL 16 — a
clean database 0001→0014, and an existing database with live data taking 0013+0014 — and the two land
on structurally identical schemas (479 columns, 137 indexes, 380 constraints, diffed). 32 live smoke
checks pass against the compiled server. See `docs/PHASE-8-REPORT.md`, which also lists what is **not**
done (NFR-S2 admin 2FA, FR-6.6, §15.2 DPDP) and the **required deployment step** for an existing
database.

> **Upgrading an existing database:** run `npm run db:migrate`, then `npm run engine:upgrade --apply`.
> Phase 8 adds a required engine parameter, and the engine refuses a configuration that lacks one
> rather than inventing a value — so practice answers 422 until a configuration containing it is
> activated. The script is a dry run by default.

Verified in Phase 7: the same commands passed with 873 tests and 158 SQL assertions. The compiled server was then started against a freshly
migrated and seeded database and driven over HTTP end to end: sign in; watch a student and an
anonymous caller get 403 and 401 on the upload route; have a file that is not a PDF, an encrypted
PDF and a truncated PDF each refused with the reason; upload a real two-page textbook PDF under a
deliberately hostile filename and see it stored under a UUID key inside the organisation's own
prefix; upload the same bytes again and get `409 DUPLICATE`; watch the job reach `awaiting_review`
having read both pages from the text layer, produced nine blocks, matched both solutions to their
questions and opened four review tasks; confirm no syllabus node was created; reclassify the
ambiguous block; reject the orphan solution without a reason and get 400, then with one and see the
text still on disk; try to publish a question and get `422 NOT_PUBLISHABLE` naming `expected_time`;
set the expected time and publish, producing a real published question with its difficulty from the
active engine configuration, its options, its official solution and its audit rows; check the
student projection carries no answer key; retire the seeded questions and watch a student be served
the ingested question through the ordinary practice flow; publish the ingested theory and see it go
from 6 to 7 student-visible blocks with the embedding attempt honestly reported as impossible here;
re-run the job twice and see identical block counts, the reviewer's work intact and the attempt
counter move; delete the stored object and re-run, getting `failed` with `errorCode:
asset_unreadable`; and read all thirteen ingestion routes out of the published OpenAPI document.

**No external AI provider call was executed.** There are no Gemini or Anthropic credentials in
this environment, and faking a successful external call would prove nothing. Instead: the two
providers' request shaping, authentication headers, error classification and reply parsing are
unit-tested against an injected `fetch`; the dispatcher's primary/fallback/refuse behaviour is
unit-tested; the e2e suite drives the **whole real request path** — controller, guards,
validation, service, repository, PostgreSQL, the grounding formula, the answer matcher, the
visibility rules and the cache — replacing only the provider at the network edge; and the live
flow exercises the real path up to that boundary. pgvector is likewise absent here, so semantic
retrieval could not run: the hybrid search fell back to its keyword half and said so in the
stored diagnostics.

**No OCR provider call was executed, and no S3 request was made.** Neither is installable in this
environment (DECISIONS.md §D), and both sit behind an interface with the same consequence: the
pipeline only ever OCRs a page whose text layer is too thin to use, and with `OCR_PROVIDER=none`
that page is **recorded and sent to review** rather than silently dropped — which is the behaviour
the tests assert. Object storage runs on the `local` and `memory` drivers, which enforce exactly the
same key rules an S3 adapter would; `STORAGE_DRIVER=s3` refuses at boot rather than accepting
uploads it cannot store. Publishing ingested theory calls Phase 6's own embedding path, and where
pgvector is missing the publish still succeeds and the response says why the embedding did not
happen.

## Prerequisites

- Node.js 22.12 or newer
- Docker Desktop (for PostgreSQL 16 + pgvector and Redis)

## Setup

```bash
# 1. Environment. Copy the template, then fill in POSTGRES_PASSWORD, DATABASE_URL,
#    TEST_DATABASE_URL, JWT_ACCESS_SECRET and the SEED_*_PASSWORD values.
cp .env.example .env            # PowerShell: Copy-Item .env.example .env

# Generate a JWT secret:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 2. Infrastructure (PostgreSQL 16 + pgvector, Redis 7; ports bound to 127.0.0.1)
docker compose up -d

# 3. Dependencies
npm install

# 4. Database
npm run db:migrate              # apply migrations
npm run db:seed                 # development data (refused when NODE_ENV=production)

# 5. Run
npm run dev                     # http://localhost:3000/v1/health/ready, Swagger at /docs
```

Example `.env` database lines (use the password you chose):

```
DATABASE_URL=postgres://apexprep:<password>@localhost:5432/apexprep
TEST_DATABASE_URL=postgres://apexprep:<password>@localhost:5432/apexprep_test
```

The `apexprep_test` database is created automatically the first time the Postgres container starts.

After seeding, sign in as the seeded student or admin with no `tenantSlug`
(`DEFAULT_TENANT_SLUG=dev-sandbox`). The optional super admin lives in the
`apexprep-platform` organisation, so pass `"tenantSlug": "apexprep-platform"` when logging in.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API with watch mode |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled API |
| `npm test` | Both Jest projects: unit (no database) and e2e (needs `TEST_DATABASE_URL`) |
| `npm run test:unit` | Unit tests only; no database or Docker needed |
| `npm run test:e2e` | E2E tests: resets and migrates `TEST_DATABASE_URL` (name must end in `_test`), then drives the real app over HTTP |
| `npm run test:sql` | Database-level tests: resets `TEST_DATABASE_URL`, migrates, seeds, runs `test/sql/*.sql` |
| `npm run lint` / `npm run typecheck` | ESLint (type-aware) / `tsc --noEmit` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:status` | Applied vs pending, with checksum verification |
| `npm run db:seed` | Development seed |
| `npm run db:reset` | Drop, re-migrate and re-seed (refused in production) |
| `npm run engine:upgrade` | Add engine parameters a release newly requires to each organisation's active configuration, as a new version. **Dry run by default**; `-- --apply` to make the change. Needed once after upgrading an existing database to Phase 8 — see the note above. |
| `npm run beta:learners` | Create a cohort of test learners, reproducible from one `--seed`. `--list` prints the credentials again, `--remove` deletes exactly that cohort. Emails are under the reserved `@beta.invalid` domain, so the whole cohort is identifiable |
| `npm run beta:load` | Drive login → tracks → tree → session → serve/answer against a running server and report p50/p90/p99 per request. Needs a cohort from `beta:learners` |

`npm test` fails with a clear message if `TEST_DATABASE_URL` is not set. Start Docker first,
or use `npm run test:unit`.

## API (Phases 2-8)

All routes are under `/v1`. Every error has the shape
`{ "error": { "code", "message", "details"?, "requestId" } }`, and every response carries an
`X-Request-Id` header. Swagger UI is at `/docs` (OpenAPI JSON at `/docs/openapi.json`).

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /v1/auth/register` | public | Create a student account and sign in |
| `POST /v1/auth/login` | public | Sign in |
| `POST /v1/auth/refresh` | refresh cookie | Rotate the refresh token, get a new access token |
| `POST /v1/auth/logout` | refresh cookie | Sign out this device, or all devices with `allDevices: true` |
| `GET /v1/auth/me` | signed in | Current user |
| `POST /v1/auth/verify-email` | public | Confirm an email address with the emailed token |
| `POST /v1/auth/resend-verification` | signed in | Send a fresh verification email |
| `POST /v1/auth/forgot-password` | public | Email a password reset link (always the same 202 reply) |
| `POST /v1/auth/reset-password` | public | Set a new password with the emailed token; ends every session |
| `PATCH /v1/me/profile` | student | Profile and onboarding (track, goal, target rank, daily goal, exam date). Setting `primaryTrackId` also keeps the enrolment below in step |
| `GET /v1/me/tracks` | student | The tracks this learner is learning in, primary first, each with its learning context |
| `POST /v1/me/tracks` | student | Enrol in a track. Re-enrolling in one you left reactivates that enrolment |
| `PATCH /v1/me/tracks/{trackId}` | student | Make a track primary, or change your goal for it |
| `DELETE /v1/me/tracks/{trackId}` | student | Leave a track. Kept as history; no progress is deleted |
| `GET /v1/admin/students`, `GET /v1/admin/students/:id` | admin | Students of your organisation (cursor-paginated, searchable) |
| `PATCH /v1/admin/users/:id/status` | admin | Enable or disable an account; disabling ends its sessions at once |
| `GET/POST /v1/admin/tenants`, `PATCH /v1/admin/tenants/:tenantId` | super admin | Organisations |
| `POST /v1/admin/tenants/:tenantId/admins`, `GET /v1/admin/tenants/:tenantId/users` | super admin | Staff and users of any organisation |
| `GET /v1/tracks`, `GET /v1/tracks/:id` | signed in | Published tracks of your organisation |
| `GET /v1/tracks/:id/tree` | signed in | Whole syllabus of a track in one call (question counts, `hasTheory`) |
| `GET /v1/subjects/:id`, `/v1/chapters/:id`, `/v1/topics/:id`, `/v1/subtopics/:id` | signed in | One node with its subtree and breadcrumbs |
| `GET /v1/subtopics/:id/theory` | signed in | Published theory blocks in reading order |
| `POST /v1/practice/sessions` | student | Start practising a sub-topic (or resume the open session); returns the ability and any decay applied |
| `GET /v1/practice/sessions/:id` | student | Session state: served and answered counts, whether it is paused |
| `GET /v1/practice/sessions/:id/next` | student | The next question, chosen by the engine. Repeating the call returns the same one; `?skip=true` moves on |
| `POST /v1/practice/attempts` | student | Submit an answer (`Idempotency-Key` required). Graded on the server; returns the answer key, the θ/level change and the new progress |
| `POST /v1/practice/sessions/:id/events` | student | Focus events (visibility, idle, breaks, explanation opened). Refused when the organisation has tracking off |
| `POST /v1/practice/sessions/:id/end` | student | Finish the session; an unanswered question is marked abandoned |
| `GET /v1/questions/:id/explanation` | student | The explanation for a question you have answered: official solution, grounded in the notes, or general knowledge with its notice |
| `POST /v1/questions/:id/report` | student | Report a question or its explanation; three distinct reporters unpublish it |
| `GET /v1/admin/questions/:id/explanation` | admin | The same explanation with its provenance: tier, grounding score and sources, retrieval trail, provider, why a student would not see it |
| `POST /v1/admin/explanations/:id/review` | admin | Approve or reject; approving releases one a mandatory-approval track was holding |
| `POST /v1/admin/subtopics/:id/theory-embeddings` | admin | Embed the sub-topic's published theory for semantic retrieval (skips unchanged blocks) |
| `GET /v1/admin/tracks`, `GET /v1/admin/tracks/:id/tree` | admin | The same, including drafts, with each node's status |
| `POST/PATCH/DELETE /v1/admin/{tracks\|subjects\|chapters\|topics\|subtopics}` | admin | Author the syllabus (soft delete; refused while a node has children) |
| `GET/POST /v1/admin/subtopics/:id/theory-blocks`, `PATCH/DELETE /v1/admin/theory-blocks/:id` | admin | Author, publish and reorder theory |
| `GET/POST /v1/admin/questions` | admin | Search the bank; create a question (draft) |
| `GET/PATCH/DELETE /v1/admin/questions/:id` | admin | Detail with the answer key; edit; soft delete |
| `GET /v1/admin/questions/:id/preview` | admin | Exactly what a student would receive |
| `POST /v1/admin/questions/:id/publish \| retire` | admin | Lifecycle |
| `PUT/DELETE /v1/admin/questions/:id/official-solution` | admin | The solution explanations prefer |
| `GET /v1/admin/engine-config`, `/versions`, `/versions/:id` | admin | Your organisation's engine parameters, with validity and version history |
| `GET/POST /v1/admin/tenants/:tenantId/engine-config` | super admin | Read or create a configuration version for an organisation (`activate: true` to switch at once) |
| `POST /v1/admin/tenants/:tenantId/engine-config/versions/:id/activate` | super admin | Activate a stored version (rollback is the same call) |
| `GET /v1/health/live`, `GET /v1/health/ready` | public | Liveness / readiness |

### How the adaptive engine is wired

- The engine is **pure TypeScript** in `src/adaptive/` — no Nest, database or network
  imports — so every rule is unit-tested directly and can be replayed against stored attempts.
- **No threshold is written in code.** Every function takes the parameters of the active
  `engine_config` version, and the parameter schema has no defaults: a version missing a key
  is rejected with that key named rather than the engine running on an invented number.
- The formulas are the ones in the brief: `E = 1/(1 + 10^((b − θ)/scale))`,
  `θ' = θ + K_s(S − E)`, `b' = b + K_q(E − S)`, and selection aims at
  `b* = θ + scale·log10(1/p − 1)` for the configured target success rate.
- Configuration versions are immutable and audited by the database; changing a parameter
  means creating a version and activating it, which takes effect on the next question served.
- The stated rules are implemented and tested: stepped K-factors (32 → 16 for the student,
  24 → 8 for the question, halved against a barely calibrated item), L2 cold start with
  parent-topic seeding, the promotion and demotion ladder with its 1.25× speed condition,
  L1 protection, probable guesses (incorrect **and** under 25% of the expected time) excluded
  from the ability update with a session pause after three, probes every 5th question half a
  level above target that skip the demotion counters, ~72% target success, the 30-day
  exclusion window, and the content-gap response under 5 eligible questions.
- A unit test fails the build if any of those thresholds ever appears as a literal in engine
  code. The handful of values the requirements do not specify are listed in
  docs/DECISIONS.md §C and flagged in the seed under `provisional_keys`.

### How a practice request flows through it

`src/practice/` is the only place the engine meets HTTP, and it owns no adaptive rules of
its own — it loads state, calls the pure functions, and writes what they return.

- `GET /practice/sessions/:id/next` loads the candidate pool for the sub-topic (every
  published question, with when this student last saw each one) and hands it to
  `selectNextQuestion`, which decides *which* and *why* — `cold_start`, `placement`, `probe`
  or `adaptive` — and reports whether the pool is thin. When it is, the service widens to the
  sibling sub-topics of the parent topic, prefers the wider pool only if it yields more
  eligible questions, and opens one `content_gap` review task. The served question goes
  through the same student-safe projection the question bank uses.
- `POST /practice/attempts` does everything else in one transaction: lock the served item and
  the session, grade the response **on the server** from the answer key, hand θ, b, the
  timings and the ladder window to `applyAttempt`, write the immutable attempt, move the
  question's own difficulty and calibration count, then write the ability projection. The
  request body has no field for correctness, and one is rejected if a client invents one.
- The ladder window is read back out of `attempts` on every submission — graded, non-guess
  attempts since the level last changed — so the promotion and demotion counters are derived,
  never accumulated in a column that could drift.
- `ability_scores` is a cache of that replay, and `AbilityRebuildService` proves it: it
  replays a student's attempts through the same engine and either reports the differences or
  writes the result back. The e2e suite tampers with a projection and rebuilds it from the
  attempts alone.

### How an explanation is kept safe

- **The answer comes from the question, never from the model.** The generated explanation's own
  conclusion is graded against the question's answer key by `src/practice/grading.ts` — the same
  code that marks students, with the same exact-decimal arithmetic. If it argues for an answer
  the question marks wrong, it is stored `rejected` with a review task and **no student ever
  sees it**, whatever its grounding score.
- Four more checks run first: tenant ownership, question identity (the right question at the
  right version), completeness, and citation integrity — a grounded explanation may only cite
  notes that were actually retrieved, and a general-knowledge one may cite none.
- **General knowledge is labelled, not disguised.** It carries the product's exact wording,
  "Not from official notes — pending review", and opens a review task. It is generated in a
  *second* call with no notes attached, so nothing the notes did not support can be implied to
  have come from them.
- Olympiad tracks hold every generated explanation until a human approves it; an official
  solution is never held, because a human wrote it.
- The student payload carries the source label and the prose. The grounding score, supporting
  blocks, retrieval trail, provider, model and the answer the model argued for stay on the row
  and on the admin route.
- A student must have answered the question first — a worked solution is the answer, so without
  that the endpoint would be an answer oracle.

### How the question bank protects answers

- Student payloads are built from an explicit column allow-list (`STUDENT_QUESTION_COLUMNS`),
  so the answer key, tolerances, matrix answer, official solution, Elo difficulty and hint
  text are never selected on that path — only `hintCount`.
- Answer shape is validated per question type before anything is stored, so publishing cannot
  fail on shape; the database validator (`AP002`) remains the backstop and answers 422.
- Questions start as drafts and are never hard-deleted: publish → retire keeps attempt
  history intact, and the version increases whenever content or the answer key changes.
- Every syllabus and question write is audited, and another organisation's ids answer 404.

### How authentication works

- **Access token:** a JWT (HS256, 15 minutes by default), sent as `Authorization: Bearer <token>`.
  On every request the API re-reads the user and organisation, so disabling a user,
  suspending an organisation or "sign out everywhere" takes effect immediately.
- **Refresh token:** opaque and random. The server stores only its SHA-256 hash, and the
  browser gets it in an HttpOnly cookie `apx_refresh` scoped to `/v1/auth`. Each refresh
  rotates it. Replaying an old one revokes the whole session family and is written to the
  audit log.
- **Organisation (tenant):** register and login use `tenantSlug`, or `DEFAULT_TENANT_SLUG`
  when it's omitted, only to decide whose user directory to check. After sign-in, the tenant
  comes solely from the token plus a database lookup. A tenant id in a request body is
  rejected, not ignored.
- **Roles and permissions:** `STUDENT`, `ADMIN` and `SUPER_ADMIN` map to permissions in
  `src/common/auth/permissions.ts`. Routes declare `@RequirePermissions(...)`, and a global
  guard enforces them. Another organisation's records answer 404, not 403.
- **Passwords:** argon2id (OWASP parameters), 8–128 characters, and not your email address.
  After 10 consecutive failures the account locks for 15 minutes (both configurable).
  Hashes made with weaker parameters are upgraded on the next login.

### Content ingestion (Phase 7, admin only)

| Route | Purpose |
| --- | --- |
| `POST /v1/admin/ingestion/assets` | Upload a source PDF as the raw body (`Content-Type: application/pdf`; `?trackId=&subjectId=&hint=`; name in `X-Filename`). Checks the size, the type from the file's own header, encryption, the page count and the SHA-256 against this organisation's assets, stores the bytes, then queues the job. |
| `GET /v1/admin/ingestion/jobs` | This organisation's jobs, newest first (`?status=&limit=`) |
| `GET /v1/admin/ingestion/jobs/:id` | One job: stage, progress, page and block counts, error code and message, review tasks |
| `POST /v1/admin/ingestion/jobs/:id/retry` | Run it again — idempotent, and a reviewer's work survives |
| `GET /v1/admin/ingestion/jobs/:id/blocks` | Every block, with its provenance, its confidences, the extracted question, and the gates blocking it |
| `POST /v1/admin/ingestion/blocks/:id/approve` \| `/reject` | Approve as it stands; reject with a required reason (the content is kept) |
| `PATCH /v1/admin/ingestion/blocks/:id` | Edit text, title, sub-topic or the extracted question. Every call is a save, so a client may PATCH as the reviewer types |
| `POST /v1/admin/ingestion/blocks/:id/reclassify` | Say what a block actually is — how an ambiguous block becomes usable |
| `POST /v1/admin/ingestion/blocks/merge` \| `/blocks/:id/split` | Join a question split across a page break; separate two questions the segmenter ran together. Both are reversible and keep provenance |
| `POST /v1/admin/ingestion/blocks/:id/publish` \| `/unpublish` | Run the quality gates and publish through the Phase 3 question service; take it back out (a published question is retired, never deleted) |

Publication is gated, never implicit: `publish` answers `422 NOT_PUBLISHABLE` with one `details`
entry per failing gate and there is no override. Two things a reviewer always supplies for an
ingested question, because a printed question does not state them: the expected solving time (it
feeds the engine's guess and promotion rules, so it is never invented — DECISIONS §B54) and the
difficulty where the source printed none.

## Database guarantees (enforced in SQL, covered by `test/sql`)

- **Tenant isolation:** composite `(tenant_id, id)` foreign keys, so no row can reference another tenant's row.
- **Attempts are immutable** and **audit_log is append-only.** `UPDATE`, `DELETE` and `TRUNCATE` raise `AP001`.
- An attempt must match the question actually served in that session item. There is one attempt per served item, and idempotency keys are unique per student.
- An attempt snapshots every engine input it was graded with — θ before, the question's `b` and label, `E`, the `calibration_n` and expected time in force (migration 0010) and the config version — so the ability projection can always be replayed from it.
- Abandoned or skipped questions never create attempts.
- A student has at most one active session per sub-topic, and a question is served at most once per session.
- **Engine config versions are immutable**, one is active per tenant, and every create, activate or deactivate writes an audit row from inside the database.
- Passwords can only be stored as argon2id hashes; plaintext is rejected by a CHECK.
- Publishing a question runs a validator (`AP002`), e.g. single-correct needs exactly one correct option.
- Focus events are rejected (`AP003`) when tracking is off, and only whitelisted event types exist. There is no free-form payload column.
- Benchmarks store nothing for cohorts below the minimum size, and never store student identifiers.
- Duplicate source PDFs (same SHA-256) are rejected per tenant; two organisations may each hold the same PDF, and a soft-deleted asset releases its hash for re-upload.
- An ingestion job that failed must carry an error code, and only a terminal job has a finished timestamp; a published job must be at 100 %; a job cannot record more OCR'd pages than the document has.
- Each page of a job is recorded once, so a re-run replaces rather than duplicates, and `char_count` is computed by the database.
- A content block from an asset must say which page of it, so provenance is never partial, and an ambiguous block cannot be approved without being reclassified.
- A review task must name something a reviewer can act on — a block, question, explanation, sub-topic, or (migration 0012) the job itself, for a page that could not be read.
- Self-registration is off by default for every organisation (migration 0008).

Custom SQLSTATEs: `AP001` immutable / append-only · `AP002` not publishable · `AP003` focus
tracking disabled · `AP004` invalid cross-row state. The API maps them to 409/422 responses.

## Layout

```
src/
  auth/          register, login, refresh rotation, logout, email verification, JWT guard
  syllabus/      tracks → subjects → chapters → topics → subtopics, tree, theory, authoring
  questions/     question bank, per-type answer rules, student-safe projection
  adaptive/      pure engine: Elo, levels, guards, guesses, decay, selection (no Nest/DB)
  practice/      the student flow: sessions, selection, server-side grading, attempts, ability
  explanations/  official → RAG → general resolution, retrieval, grounding, validation, caching
  ai/            the provider boundary: Gemini, Claude, prompts, dispatch and fallback
  storage/       the object-storage boundary, safe keys, local and in-memory adapters
  pdf/           PDF validation and text extraction, and the OCR provider boundary
  ingestion/     upload, the queue boundary, the pipeline stages, review, quality gates, publish
  engine-config/ versioned engine parameters: validation, versions, activation
  users/         profile/onboarding, admin student management
  tenants/       super-admin organisation management
  audit/         append-only audit writer (request id, IP, actor captured automatically)
  mail/          email transport interface (console / memory / none)
  common/        permissions, guards, decorators, errors, request context, pagination, validation
  database/      Drizzle schema mirror, migration runner, dev seed
  config/ health/ app.module.ts app.setup.ts main.ts
database/        migrations/*.sql (source of truth), seeds/dev/*.sql
test/unit/       Jest unit tests      test/e2e/  Jest e2e tests      test/sql/  database tests
docker/          Postgres init (creates the _test database)
docs/            architecture, frontend contract, decisions
```
