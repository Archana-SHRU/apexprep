# Phase 8 — Real Backend Integration: final report

> **Status note (2026-10-16).** This document records the state at the end of the integration phase and is kept as history. Several items it lists as not connected have since been built and wired: mock tests, Ask-AI, peer benchmarks, content ingestion with the consolidated review and single approval, and the admin console pages (`NotConnected.tsx` was removed). Read `AYUSH_CHANGES.md` for what is current, what was verified and what is not.


The ApexPrep frontend no longer contains a mock data layer. Every screen reads from the NestJS API, every
answer is graded by the server, and every figure shown to a learner is computed from rows in PostgreSQL.

This report is the record of what changed, what was verified, and what is still missing. The screen-by-screen
mapping that drove the work is in [INTEGRATION-MAP.md](./INTEGRATION-MAP.md).

---

## 1. Files changed

### Frontend — new files (8)

| File | Why it exists |
| --- | --- |
| `src/lib/http.ts` | The one place the app talks to the network: base URL, bearer token, JSON parsing, the backend's error envelope, and a single-flight 401 → refresh → replay. No component builds a URL. |
| `src/types/api.ts` | The backend's DTOs transcribed field for field, so a contract change is a compile error rather than a runtime surprise. |
| `src/lib/format.ts` | Where "no data" becomes `—` and where an L1–L5 level becomes a bar width. Two decisions, one place each. |
| `src/lib/answer.ts` | Reads the server's `revealedAnswer` into the shape the option list marks up. The only code that touches an answer key, and it runs *after* the server has graded. |
| `src/pages/admin/NotConnected.tsx` | The honest state for admin screens that this phase did not wire. |
| `src/vite-env.d.ts` | Types `import.meta.env.VITE_API_BASE_URL`, so a typo in the env var is caught by `tsc`. |
| `src/node-builtins.d.ts` | Declares the two `node:url` members `vite.config.ts` imports. Without it `npm run typecheck` — and therefore `npm run build` — failed; that failure predates this phase and is fixed here. |
| `.env.example` | `VITE_API_BASE_URL`, with a note that anything `VITE_`-prefixed is compiled into the bundle and is therefore public. |

### Frontend — rewritten (31)

*The seam and its plumbing*
`src/lib/api.ts` · `src/types/index.ts` · `src/hooks/useApi.ts` · `src/hooks/useAuth.tsx` ·
`src/hooks/usePracticeSession.ts`

*Shell and routing*
`src/App.tsx` (route guards — there were none, because there was no real session) · `src/layouts/StudentLayout.tsx`

*Components*
`src/components/AIExplanation.tsx` · `src/components/QuestionPalette.tsx`

*Learner pages*
`Dashboard` · `Learn` · `SubjectView` · `ChapterView` · `Theory` · `PracticeHub` · `Practice` · `Analytics` ·
`Reports` · `Profile` · `Login` · `SignUp` · `Onboarding` · `Tests` · `TestRunner` · `TestResult`

*Admin pages (honest unavailable states)*
`AdminDashboard` · `AdminLogin` · `ContentUpload` · `ContentProcessing` · `ContentReview` · `QuestionBank` ·
`StudentManagement` · `AdminAnalytics`

### Frontend — deleted (5)

`src/data/index.ts` · `src/data/curriculum.ts` · `src/data/questions.ts` · `src/data/student.ts` ·
`src/data/analytics.ts`

### Frontend — untouched

`src/components/ui/*` (10 primitives), `Breadcrumbs`, `EmptyState`, `Logo`, `OptionCard`, `PageHeader`,
`StatStrip`, `layouts/AdminLayout`, `layouts/AuthLayout`, `hooks/useToast`, `lib/utils.ts`, `main.tsx`,
`index.css`, `tailwind.config.ts`, `postcss.config.js`, `index.html`, `public/logo.svg`.

### Backend — new (10)

`src/analytics/analytics.math.ts` · `analytics.repository.ts` · `analytics.service.ts` · `analytics.controller.ts` ·
`analytics.module.ts` · `dto/analytics.dto.ts` · `test/unit/analytics-math.spec.ts` ·
`test/e2e/analytics.e2e-spec.ts` · `docs/INTEGRATION-MAP.md` · `docs/INTEGRATION-REPORT.md` (this file)

### Backend — modified (2)

`src/app.module.ts` (registers `AnalyticsModule`) · `test/e2e/helpers.ts` (`insertHistoricalAttempt` gained an
optional `difficultyLabel`, which was hardcoded to 2)

---

## 2. APIs connected

Every one of these is called by the shipped frontend and was exercised in the browser during verification.

| Endpoint | Where it is used |
| --- | --- |
| `POST /v1/auth/register` | Sign-up |
| `POST /v1/auth/login` | Sign-in |
| `POST /v1/auth/refresh` | `http.ts`, automatically on a 401 |
| `POST /v1/auth/logout` | Profile → Sign out |
| `GET /v1/auth/me` | Session restore, route guards, Profile |
| `PATCH /v1/me/profile` | Onboarding, Profile |
| `GET /v1/me/tracks` · `POST /v1/me/tracks` | Track switcher, Onboarding |
| `GET /v1/tracks` | Onboarding, track switcher |
| `GET /v1/tracks/:id/tree` | Learn, Practice hub, header search |
| `GET /v1/subjects/:id` · `GET /v1/chapters/:id` · `GET /v1/subtopics/:id` | Subject, Chapter, Practice breadcrumbs |
| `GET /v1/subtopics/:id/theory` | Theory |
| `POST /v1/practice/sessions` | Start a set |
| `GET /v1/practice/sessions/:id/next` | Each question |
| `POST /v1/practice/attempts` | Each answer (with `Idempotency-Key`) |
| `POST /v1/practice/sessions/:id/events` | Focus/visibility telemetry |
| `POST /v1/practice/sessions/:id/end` | Finish set |
| `GET /v1/questions/:id/explanation` | Explanation panel |
| `GET /v1/me/summary` | Dashboard tiles, header streak |
| `GET /v1/me/analytics` | Analytics, Reports, syllabus level overlay |
| `GET /v1/me/recommendations` | Dashboard |

## 3. APIs newly created

The frontend needed a learner's own figures, and the backend had no analytics surface at all. Three read-only
endpoints were added, built from existing tables (`attempts`, `ability_scores`, the syllabus tables). **No new
tables and no new migrations.**

| Endpoint | Returns |
| --- | --- |
| `GET /v1/me/summary` | `solvedToday`, `todayAccuracy`, `studyMinutesToday`, `streakDays`, `dailyQuestionGoal`, `questionsSolvedTotal`, `daysToTargetExam` |
| `GET /v1/me/analytics?range=&subjectId=` | `overallAccuracy`, `accuracyDelta`, `questionsSolved`, `paceSeconds`, `coveragePct`, `levelAccuracy[5]`, `trend[]`, `weakSubtopics[]`, `strongSubtopics[]`, `subtopicPerformance[]`, `subjectSummary[]` |
| `GET /v1/me/recommendations` | Up to three sub-topics with a stated reason each (`continue` / `practice` / `focus`) |

All three carry `@RequirePermissions('analytics:own')` — a permission the STUDENT role already had and nothing
used — and scope every query to the JWT's `tenantId` and `userId`. A `?userId=` on the request is ignored
because there is nowhere to put one.

Design rules held to, and tested:

* **No mastery percentage.** The requirements define mastery as θ mapped to an L1–L5 band, so the API returns
  `level` and nothing else. An e2e test asserts the payload contains no `mastery`/`masteryPct`/`overallMastery`.
* **`null`, never `0`.** A learner with no graded attempts has `accuracy: null`. 20 unit tests in
  `analytics-math.spec.ts` exist for this one rule.
* **Nothing recomputed.** `level` is read from `ability_scores` — the adaptive engine's own value.
* **Ranking needs evidence.** A sub-topic enters `weakSubtopics` only with ≥ 5 attempts; below that it still
  appears in `subtopicPerformance`, unranked, so the syllabus pages can label it.

## 4. Mock/static data removed

| Removed | Replaced by |
| --- | --- |
| `currentStudent` — "Arjun Verma", streak 18, solvedToday 42, accuracy 88%, peerBand "Top 5%", 105 study minutes, rank 420, 142 days to exam | `GET /v1/auth/me` + `GET /v1/me/summary` |
| `analytics` — 84.8% accuracy, 2.4 min pace, 4 440 solved, 134-day streak, 79.2% mastery, tier accuracy with invented targets, a 7-week trend, per-topic `retention` | `GET /v1/me/analytics` |
| `recommendations` — three fixed cards | `GET /v1/me/recommendations` |
| `curriculum` — six hardcoded tracks (JEE, NEET, four Olympiads) with fixed subjects, chapters, weightages and mastery percentages | `GET /v1/tracks` + `GET /v1/tracks/:id/tree` |
| `questions` / `buildQuestionSet()` — generated question sets carrying `correctKey`, `correctValue`, embedded `explanation`, `hints[]`, `positiveMarks`, `negativeMarks`, `avgPeerTimeSec`, `difficultyIndex` | `GET /v1/practice/sessions/:id/next` — a payload built from a column allow-list, with no answer key in it |
| Browser grading — `a.selectedKey === q.correctKey` in `usePracticeSession` | `POST /v1/practice/attempts`; the server grades, moves θ and returns `revealedAnswer` |
| `api.askAI()` — a fabricated physics answer after a 900 ms delay | Ask-AI disabled, labelled "not connected yet" |
| `tests` / `sampleResult` — four mock papers, a fixed score, percentile and rank | Honest "not available yet" states |
| `theories` keyed by a `theoryId` that does not exist | `GET /v1/subtopics/:id/theory` |
| Fake auth — any email accepted, password never checked, display name derived from the email, session in `localStorage` | Real credentials; access token in `sessionStorage`, refresh token in an HttpOnly cookie |
| Admin fixtures — `uploadJobs`, `reviewItems`, `adminStudents`, `platformStats` | The admin pages state they are not connected |

**Legitimate UI constants kept**, as instructed: `TIER_META` (level names and colours), difficulty labels,
question-type labels, icons, the design tokens in `tailwind.config.ts`, and the marketing copy on the auth
screens.

## 5. Any remaining mock data

**None in the learner application.** A search for `mock|dummy|sample|demo|fake|hardcoded` across `src/` returns
only prose in doc comments describing what was removed, and the phrase "Mock Tests" — the product's own name for
a feature, on the page that says the feature does not exist.

The **admin console** (9 pages) is not wired. It does not display invented data: `api.getUploadJobs`,
`getReviewItems`, `getAdminStudents` and `getPlatformStats` reject with a stated reason and the pages render an
unavailable state. Wiring it to the real `/v1/admin/...` endpoints is separate scope.

## 6. Backend capability still missing

| # | Missing | Effect on the UI today |
| --- | --- | --- |
| 1 | **Mock tests** — no test entity, timed session, marking scheme or stored results | `Tests`, `TestRunner`, `TestResult` say so plainly |
| 2 | **Ask-AI follow-ups** — no conversational endpoint | The Ask-AI box is disabled and labelled |
| 3 | **Hint text** — `hintCount` is exposed, the hint strings are not | The hint panel is hidden. Hint *usage* still travels: `hintCount` is sent with each attempt and the backend records it |
| 4 | **`matrix_match` and `long_form` input controls** | The backend serves both; the approved UI has no control for either. They are served, displayed and answerable only in the generic text/numeric form |
| 5 | **Peer benchmarks** — no percentile, rank or cohort comparison | "Top 5%", peer averages and projected rank are gone, not faked |
| 6 | **Mastery percentage** — the requirements define no such metric | Levels are shown as `L1`–`L5`; the bar is a visual encoding of the band |
| 7 | **Retention decay per topic** — the schema has no retention model | The retention column is gone; "last practised" is shown instead, which is real |
| 8 | **Admin console APIs not wired** | See §5 |

## 7. Exact commands

```bash
# ---- backend (terminal 1) ----
cd apexprep-backend
npm install
cp .env.example .env          # then fill DATABASE_URL, JWT_ACCESS_SECRET, …
npm run db:migrate
npm run db:seed               # dev content: two tracks, 17 published questions, theory
npm run build && npm start    # or: npm run dev

# ---- frontend (terminal 2) ----
cd apexprep-frontend
npm install
cp .env.example .env          # VITE_API_BASE_URL=http://localhost:3000
npm run dev
```

The backend's `CORS_ORIGINS` must list the frontend origin (`http://localhost:5173` by default), because the
refresh cookie is sent with `credentials: 'include'` and the browser will not attach it otherwise.

## 8. Browser URL

**http://localhost:5173** — sign-up at `/signup`, sign-in at `/login`.

## 9. Test results

| Gate | Result |
| --- | --- |
| Backend `npm test` | **977 passed, 40 suites, 0 failed** (75.7 s) — includes 39 new analytics tests |
| Backend `npm run test:sql` | **181 assertions passed, 11 files, 0 failed** (0007_pgvector skipped: extension unavailable on the verification server) |
| Backend `npm run typecheck` | clean |
| Backend `npm run lint` | clean |
| Backend `npm run build` | clean, `dist/main.js` produced |
| Frontend `npm run typecheck` (`tsc --noEmit`, TypeScript 5.9.3, strict) | **clean, exit 0** |
| Frontend `npm run build` | `tsc --noEmit` half passes; `vite build` **could not be executed in the verification environment** — see below |
| Frontend `npm test` / `npm run lint` | **No such scripts.** The project has no test runner and no ESLint configuration; this is pre-existing, not a regression |

**Why `vite build` did not run here.** Both sandboxes available for verification are Linux, the project's
`node_modules` is a Windows install (`@esbuild/win32-x64`, `@rollup/rollup-win32-x64-msvc`), and the npm
registry is blocked, so the Linux binaries cannot be fetched. `vite build` fails with
`Cannot find module @rollup/rollup-linux-x64-gnu`. This is an environment limit, not a code problem: on the
machine where `npm install` was run, `npm run build` uses the win32 binaries normally. To verify the code
regardless, the real source was type-checked with the project's own TypeScript (clean) and bundled with a Linux
esbuild for the browser tests below — that bundle compiled the entire application without an error.

## 10. End-to-end verification

Three independent runs, all against the NestJS API on `:3000`, PostgreSQL 16, `AI_PROVIDER=none`.

### A. HTTP chain

Register → login (wrong password rejected 401 `INVALID_CREDENTIALS`) → `/auth/me` → `/v1/tracks` →
enrol + profile → `/tracks/:id/tree` → detail routes → theory → create session → next question → submit attempt →
adaptive next → explanation → events → analytics → recommendations → end session → logout.

Evidence from the served question payload:

```
payload keys   ['difficultyLabel','expectedTimeSeconds','hintCount','id','options',
                'stem','stemJson','subtopicId','type','version']
ANSWER KEY IN PAYLOAD: none
```

Evidence from the attempt:

```
client sent    optionKeys=['D'] and nothing else
SERVER VERDICT outcome=incorrect correct=False score=0 probableGuess=False
revealedAnswer {"optionKeys": ["B"]}      <- disclosed only in this response
ENGINE UPDATED theta=987.84 level=L2 graded=1 correct=0
```

### B. A whole adaptive set, in the browser

Fifteen questions served one at a time, each graded by the server; six question types appeared
(`single_correct`, `multi_correct`, `integer`, `numeric`, `assertion_reason`, `matrix_match`); the engine
promoted twice and demoted three times, each with its rule (`consecutive_correct`, `consecutive_incorrect`);
`selectionReason` moved `cold_start → placement → adaptive → probe`.

The session then hit the backend's own guess rule and returned
`409 SESSION_PAUSED — "This session is paused after 3 rushed answers."` The frontend renders that sentence and
offers a fresh set. (This was a real defect found by the browser test: before the fix, a paused session showed
the learner nothing. `Practice.tsx` now surfaces any session error, not only a failed submission.)

### C. The AI explanation state

With `AI_PROVIDER=none`, a question that **has** an approved official solution returns the real explanation, and
one that **does not** returns 503. Both were exercised through the same frontend code path.

```
GET /v1/questions/dc8ca4af-2a79-4fb3-8a1f-6932ffab97d2/explanation

HTTP STATUS   503
Content-Type  application/json; charset=utf-8
X-Request-Id  7d2c39cf-6a85-49e8-b28c-810a07bb3510

{
  "error": {
    "code": "AI_NOT_CONFIGURED",
    "message": "This question has no official solution yet, and no AI provider is configured to write an explanation",
    "requestId": "7d2c39cf-6a85-49e8-b28c-810a07bb3510"
  }
}
```

Rendered in the approved panel style, with no invented content:

> **AI explanation is currently unavailable**
> This question has no written solution yet, and explanation generation is not switched on for this server.
> Your answer and the correct answer above are recorded as normal.

The same component rendered a real explanation (`source: official_solution`, HTTP 200) for five other questions
in the same set, so configuring a provider key requires no frontend change.

### D. The data is in the database

```
sessions | items | attempts | explanations | events | ability_scores
       2 |    17 |       16 |            1 |      1 |              2

email                              attempts correct avg_sec
verify2+1790525302@apexprep.local        15       6    40.5
ability_scores: level=1 theta=1013.86 attempts=15 correct=6 placement=completed
```

### E. Security

* The served question payload contains no answer key (asserted above and in `question-leakage.e2e-spec.ts`).
* Grading, level changes and every statistic are computed server-side; the browser sends only the response.
* The refresh token is an HttpOnly cookie — `document.cookie` returns empty in the browser, and the session
  survives a reload because the server is asked, not because a token was stored where JavaScript can read it.
* No backend secret is in the bundle: the frontend's only environment variable is `VITE_API_BASE_URL`.
* `?userId=` on an analytics request is ignored; cross-tenant and same-tenant isolation are covered by e2e tests.
* A wrong password produces exactly one `401`, with no pointless refresh attempt.

---

**The data has travelled:** Browser → Frontend → Backend API → PostgreSQL → backend/adaptive engine → Frontend.
