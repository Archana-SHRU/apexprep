# Frontend ↔ Backend integration map

> **Status note (2026-10-16).** This document records the state at the end of the integration phase and is kept as history. Several items it lists as not connected have since been built and wired: mock tests, Ask-AI, peer benchmarks, content ingestion with the consolidated review and single approval, and the admin console pages (`NotConnected.tsx` was removed). Read `AYUSH_CHANGES.md` for what is current, what was verified and what is not.


Produced by inspecting both trees before writing any integration code:

* `apexprep-frontend/src` — 71 files (18 mock API functions, 25 pages, 8 places that read mock data directly)
* `apexprep-backend/src` — 13 controllers, every student-reachable route and DTO

The live project is `C:\project folder\apexprep-phase8-final\apexprep\` (backend has `.env`, `node_modules`
and `dist`; frontend has `node_modules`). That is the copy being changed.

---

## 0. The one thing that makes this tractable

`apexprep-frontend/src/lib/api.ts` is a **single seam**. Its own header says:

> MOCK API LAYER — the single seam between the UI and the backend. Every screen reads data through
> these functions only. When the REST API is ready, replace each body with a `fetch(...)` call against
> the same signature and return type; no component or page needs to change.

So the integration strategy is: **keep the seam, replace what is behind it.** Pages and components stay
as they are wherever a real API can satisfy the existing signature and return type. The UI freeze is
achievable because of how this frontend was built.

Three things break that ideal, and they are the substance of this document:

1. Eight places read `@/data` **directly**, bypassing the seam (`StudentLayout`, `Profile`,
   `Onboarding`, `PracticeHub`, `Practice`, `TestRunner`, `TestResult`).
2. Practice is written as a **fixed batch with client-side grading**; the backend is **adaptive,
   one question at a time, graded on the server**. This is the deepest change.
3. Analytics, the dashboard metrics and Tests have **no backend behind them at all**.

---

## 1. Screen-by-screen map

Format: **screen → current mock → real API → response shape → frontend change**.

### 1.1 Authentication

| | |
|---|---|
| **Screens** | `Login.tsx`, `SignUp.tsx`, `Onboarding.tsx`, `hooks/useAuth.tsx` |
| **Current mock** | `useAuth.login(email)` fabricates `{name: email.split('@')[0], role, trackId:'jee', onboarded:true}` into `localStorage`. No password is ever checked. `Login.tsx` pre-fills `arjun.v@example.com` / `demo1234`. `SignUp` fabricates a session without contacting anything. |
| **Real API** | `POST /v1/auth/register` · `POST /v1/auth/login` · `POST /v1/auth/refresh` · `POST /v1/auth/logout` · `GET /v1/auth/me` |
| **Response shape** | `AuthResponseDto { accessToken, tokenType:'Bearer', expiresIn, refreshToken?, user: UserDto }`. `UserDto { id, tenantId, email, displayName, role:'STUDENT'|'ADMIN'|'SUPER_ADMIN', status, emailVerified, onboarded, primaryTrackId, goal, targetRank, dailyQuestionGoal, targetExamDate, focusTrackingOptOut, createdAt, lastLoginAt }` |
| **Frontend change** | `useAuth` becomes real: `login()` posts credentials, stores the access token **in memory + sessionStorage** (not the refresh token — that is an HttpOnly `apx_refresh` cookie the browser holds), then reads `GET /v1/auth/me`. `signup()` posts `displayName/email/password`. Role maps `STUDENT→'student'`, `ADMIN|SUPER_ADMIN→'admin'`. `completeOnboarding()` calls `PATCH /v1/me/profile` with `{primaryTrackId, goal, completeOnboarding:true}`. Login's pre-filled demo credentials are removed. |

**Notes that change the code.** There is **no `GET /v1/me`** — the user object comes from
`GET /v1/auth/me` (`docs/FRONTEND-CONTRACT.md` lists `/v1/me`, which does not exist). Refresh uses the
cookie, so the API client must send `credentials: 'include'` and the backend's `CORS_ORIGINS` must
contain the Vite origin. A 401 on any call triggers one refresh attempt, then a redirect to `/login`.

### 1.2 Learner / profile

| | |
|---|---|
| **Screens** | `StudentLayout.tsx` (header, avatar, streak, "Target: AIR < N", track switcher), `Profile.tsx`, `Dashboard.tsx` greeting |
| **Current mock** | `currentStudent` — **"Arjun Verma"**, `targetRank: 420`, `streakDays: 18`, `avatarInitial:'A'`, `goal:'IIT Bombay CSE'`, `daysToExam: 142`, `peerBand:'Top 5%'`. `tracks` (six hardcoded JEE/NEET/Olympiad tracks). |
| **Real API** | `GET /v1/auth/me` · `PATCH /v1/me/profile` · `GET /v1/me/tracks` |
| **Response shape** | `UserDto` (above) · `LearnerTrackDto[] { id, trackId, isPrimary, status, goalText, enrolledAt, leftAt, track: TrackDto }` |
| **Frontend change** | `StudentLayout` and `Profile` stop importing `@/data`; they read the session user and `GET /v1/me/tracks`. `avatarInitial` is derived from `displayName[0]`. The track switcher lists the learner's **enrolled** tracks. `daysToExam` is computed from `targetExamDate`. |

**Unsupported, and handled honestly:** `peerBand` ("Top 5%") is a benchmark. FR-10.2 forbids showing one
below 30 qualifying students and no benchmark service exists → the note is hidden rather than faked.

### 1.3 Track / syllabus

| | |
|---|---|
| **Screens** | `Learn.tsx`, `SubjectView.tsx`, `ChapterView.tsx`, `PracticeHub.tsx` |
| **Current mock** | `tracks`/`subjects`/`chapters`/`topics` from `data/curriculum.ts`, with `mastery`, `accuracy`, `questionsSolved`, `weightage`, `retention`, `lastPracticedDays` on every node. `TrackId` is a **closed union** `'jee'|'neet'|'phy-olympiad'|…`. |
| **Real API** | `GET /v1/tracks` · `GET /v1/tracks/:id` · `GET /v1/tracks/:id/tree` (one call for the whole hierarchy) · `GET /v1/subjects/:id` · `GET /v1/chapters/:id` · `GET /v1/topics/:id` · `GET /v1/subtopics/:id` |
| **Response shape** | `TrackListDto { items: TrackSummaryDto[] }`; `TrackTreeDto { track: TrackDto, questionCount, subjects: SubjectNodeDto[] }`; each node carries `questionCount: number` and `mastery: number \| null`; `SubtopicNodeDto` adds `hasTheory: boolean`. `TrackDto` carries the Phase 8 learning context: `kind`, `educationStage`, `gradeLabel`, `gradeOrdinal`, `examFamily`, `curriculum`, `locale` — all nullable. |
| **Frontend change** | `TrackId` widens from the closed union to `string` (UUIDs). `api.getSubjects/getChapters/getTopics` are served from one `…/tree` call, cached per track, preserving their signatures. Phase 8 generality: nothing keys off a JEE/NEET/Olympiad literal; `kind` and `gradeLabel` are displayed when present. |

**Unsupported:** `mastery` is **hardcoded `null` at every level** in
`syllabus.mappers.ts:110-128`. `accuracy`, `questionsSolved`, `retention` and `lastPracticedDays` do not
exist on syllabus nodes at all. `weightage` maps to `weightagePct` (nullable). §1.7 adds the one endpoint
that can supply real per-sub-topic progress; where a value still has no source, the UI renders `—`, which
is what `FRONTEND-CONTRACT.md:151` already prescribes.

### 1.4 Theory

| | |
|---|---|
| **Screen** | `Theory.tsx` |
| **Current mock** | `api.getTheory(theoryId)` → `theories` with `{id, subTopicId, title, readMinutes, blocks:[{type:'paragraph'|'formula'|'callout'|'list', title?, body?, items?}]}` |
| **Real API** | `GET /v1/subtopics/:id/theory` |
| **Response shape** | `TheoryDto { subtopicId, title, readMinutes, blocks: TheoryBlockDto[] }`; `TheoryBlockDto { id, type:'heading'\|'paragraph'\|'formula'\|'callout'\|'list'\|'table'\|'figure'\|'example', title, body, items?, table? }` |
| **Frontend change** | Theory is addressed **by sub-topic**, not by a separate theory id, so the route parameter is a sub-topic UUID and `getTheoryBySubTopic` becomes the single accessor. Three backend block types the mock never had (`heading`, `table`, `figure`, `example`) are mapped onto the existing renderers rather than adding new visual components: `heading`→`callout` styling is **not** used; they render as `paragraph` with the title shown, which the component already supports. Only **published** theory is returned; visibility is the backend's. |

### 1.5 Practice — the deepest change

| | |
|---|---|
| **Screens** | `Practice.tsx`, `hooks/usePracticeSession.ts`, `components/QuestionPalette.tsx`, `components/OptionCard.tsx`, `components/AIExplanation.tsx` |
| **Current mock** | `api.getPracticeSet(subTopicId, 15)` returns **15 fully-formed questions at once**, each carrying `correctKey`/`correctValue`, `explanation` (embedded), `hints: string[]`, `positiveMarks`, `negativeMarks`, `avgPeerTimeSec`, `difficultyIndex`. `usePracticeSession.submitCurrent()` grades **in the browser**: `a.selectedKey === q.correctKey`. `score` is computed client-side over the whole set. |
| **Real API** | `POST /v1/practice/sessions` → `GET /v1/practice/sessions/:id/next` → `POST /v1/practice/attempts` (loop) → `POST /v1/practice/sessions/:id/events` → `POST /v1/practice/sessions/:id/end` |
| **Response shape** | `SessionStartDto { session: PracticeSessionDto, progress: StudentProgressDto, decayApplied }`. `NextQuestionDto { item {id, position, selectionReason, servedAt}, question: StudentQuestionDto, session, progress, contentGap? }`. `StudentQuestionDto { id, version, type, subtopicId, stem, stemJson, difficultyLabel, expectedTimeSeconds, hintCount, options:[{key,text}], matrix? }`. `AttemptResultDto { attemptId, questionId, questionVersion, outcome, score, correct, revealedAnswer, explanationAvailable, probableGuess, progress, level:{change,rule,blockedBy}, session, replayed }`. |

**The five conflicts, and how each is resolved:**

1. **Batch → adaptive.** `CreatePracticeSessionDto` accepts `targetQuestionCount` (1-200), so the session
   is created with **15** and the UI's "Question 3 of 15", progress bar and "Finish set" keep their exact
   meaning. Questions accumulate in an array as they are served; the palette shows what has been served,
   which is the honest count. Backwards navigation becomes **read-only review** of answered questions —
   the adaptive engine decides what comes next, so a learner cannot jump forward to an unserved question.

2. **Client-side grading → server grading.** `usePracticeSession` keeps its exact public interface
   (`current, attempts, elapsed, attempt, select, setValue, clear, toggleFlag, submitCurrent, go, next,
   score`) so `Practice.tsx` barely changes — but `submitCurrent` now `POST`s the attempt and stores the
   **returned** `outcome`/`correct`. `score` is derived from `progress.correctCount`/`gradedCount`, not
   recomputed. No comparison against a correct answer happens anywhere in the frontend.

3. **`correctKey` does not exist.** The student projection excludes `correct_numeric`,
   `numeric_tolerance`, `tolerance_mode`, `matrix_answer`, `difficulty_b`, `calibration_n`, `hints` and
   `is_correct` by construction. The correct answer arrives **only after submitting**, as
   `AttemptResultDto.revealedAnswer`. `optionState()` and `AIExplanation`'s "Correct" line read that.

4. **Embedded `explanation` → separate endpoint.** See §1.6.

5. **Seven question types, not two.** `type` maps: `single_correct`/`assertion_reason`/`multi_correct`
   → the option UI; `integer`/`numeric` → the numeric input; `matrix_match` and `long_form` have no UI in
   the approved design and are **reported, not invented** (see §4).

**Fields with no backend source:** `positiveMarks`/`negativeMarks` (marks are a *test* concept; practice
has none), `difficultyIndex`, and **hint text** — the backend deliberately returns `hintCount` only.
`avgPeerTimeSec` maps honestly to `expectedTimeSeconds`, which after §6.4 calibration *is* the observed
median time across peers. Timing (`totalTimeMs`, `ttfiMs`, `answerChanges`) is measured by the existing
hook and sent with the attempt. Focus events are sent to `…/events` (only when
`session.focusTrackingEnabled`; the endpoint answers **202**, not 200).

### 1.6 Explanations

| | |
|---|---|
| **Screen** | `components/AIExplanation.tsx` |
| **Current mock** | `question.explanation` — an object embedded in every question: `{summary, steps:[{title,body}], keyConcept, commonMistake, relatedTheoryId?}`. Plus `api.askAI(question)` which **fabricates a plausible physics answer** after a 900 ms delay. |
| **Real API** | `GET /v1/questions/:id/explanation` |
| **Response shape** | `ExplanationDto { id, questionId, questionVersion, source:'official_solution'\|'notes_only'\|'mostly_notes'\|'general_knowledge', notice, summary, steps: string[], keyConcept, commonMistake, optionKey, underReview, generatedAt }` |
| **Frontend change** | Fetched after submitting, keyed by question id, and only when `AttemptResultDto.explanationAvailable` is true. `steps` is `string[]` (not `{title,body}[]`), so the step list renders the string with its existing number badge. `keyConcept`/`commonMistake` are nullable → their cards are hidden when absent. `source` and `notice` are surfaced, and `underReview` shows the pending-review state — these are the product's own labels and must not be dropped. |

**States that must be real, not faked:** `403` = "answer this question first" (note: it carries **no
distinct error code**, so this route's 403 is treated as the attempt-required state); `409
EXPLANATION_UNAVAILABLE` = held for review; **`503 AI_NOT_CONFIGURED`** when `AI_PROVIDER=none` —
which is the current `.env` state, so **this is the path most learners will hit today**. It renders a
plain "explanations are not configured" panel. No fabricated explanation is ever shown.

**`askAI` has no backend.** `POST /v1/questions/:id/ask` is *proposed* in the docs and does not exist
(DECISIONS.md §B5). The Ask-AI box keeps its place in the layout but is disabled with an honest note.

### 1.7 Dashboard, analytics and reports — needs new backend endpoints

| | |
|---|---|
| **Screens** | `Dashboard.tsx`, `Analytics.tsx`, `Reports.tsx` |
| **Current mock** | Everything the brief lists: `84.8%` accuracy, `4440` questions, `79.2%` mastery, `112/142` chapters, L1-L5 percentages, `Top 5%`, projected rank movement, `streakDays: 18`, `solvedToday: 42`, `todayAccuracy: 88`, `studyMinutesToday: 105`, three hardcoded recommendations, and a 7-week trend series. |
| **Real API** | **None exists.** Verified exhaustively: no `/me/summary`, `/me/analytics`, `/me/reports`, `/me/recommendations`, `/me/benchmark`, no analytics directory, no controller declaring `analytics:own` or `reports:own` — although STUDENT is granted both permissions. |

Every number above is computable from tables that already hold real data — `attempts` (immutable, one row
per answer, with `outcome`, `score`, `total_time_ms`, `difficulty_label_at_attempt`, `created_at`) and
`ability_scores` (θ, level, counts per sub-topic). So this is the case the brief describes: implement the
**smallest** endpoints that serve the existing screens, from existing tables, with tenant isolation and
`analytics:own`.

**Three new endpoints (no new tables, no new migration):**

* **`GET /v1/me/summary`** → `{ solvedToday, todayAccuracy: number|null, studyMinutesToday, streakDays, dailyQuestionGoal: number|null, questionsSolvedTotal, daysToTargetExam: number|null }`
* **`GET /v1/me/analytics?range=&subjectId=`** → `{ overallAccuracy: number|null, accuracyDelta: number|null, questionsSolved, avgPaceSeconds: number|null, coveragePct, tierAccuracy: [{level, attempted, correct, accuracy: number|null}], trend: [{weekStart, questions, accuracy: number|null}], weakSubtopics: [...], strongSubtopics: [...], subjectSummary: [{subjectId, name, colorHex, accuracy: number|null, level: number|null, strongest, needsReview}] }`
* **`GET /v1/me/recommendations`** → up to three items `{ kind:'continue'|'practice'|'focus', subtopicId, subtopicName, subjectName, questionCount, accuracy: number|null, level: number|null }`

Each figure is a count, a ratio of counts, or a median over real rows. **Nothing is fabricated and nothing
is estimated.**

**What these endpoints deliberately do NOT return**, because the requirements do not define it and
inventing it is forbidden:

| Frontend field | Why it has no honest source |
|---|---|
| `overallMastery` / `subject.mastery` / node `mastery` as a **percentage** | The requirements define mastery as "current θ mapped to the L1–L5 band" — a band, not a percentage. A 0-100 number would be invented. **Resolution:** the endpoints return `level` (1-5); the UI shows the level band where a mastery % stood, and a bar encoding `level/5`. |
| `peerBand` ("Top 5%"), `percentile`, projected rank movement | Benchmarks. FR-10.1/10.2 require a nightly anonymised snapshot with ≥30 qualifying students; `benchmark_snapshots` exists as a table with no service. |
| `retention`, `lastPracticedDays` on topics | No spaced-repetition or retention model exists. `lastPracticedDays` *is* computable and is included; `retention` is not. |
| `chaptersCompleted / chaptersTotal` | "Completed" is undefined for a chapter. **Resolution:** `coveragePct` — the stated §10 metric (% of published sub-topics with ≥10 attempts) — replaces it. |
| `accuracyDelta` target lines, `tierAccuracy.target` | Per-tier targets are a product decision, not data. The real `accuracy` is returned; the target line is dropped. |
| `avgPeerTimeSec` per question | `expectedTimeSeconds` is used, which after §6.4 *is* the observed peer median. |

### 1.8 Tests — reported, not built

| | |
|---|---|
| **Screens** | `Tests.tsx`, `TestRunner.tsx`, `TestResult.tsx` |
| **Current mock** | `tests` (4 mock papers with `durationMin`, `totalMarks`), `api.getTestQuestions(testId, 20)` (a fabricated 20-question paper), `sampleResult` (score 46/60, percentile 93.4, per-subject breakdown). |
| **Real API** | **None. There is no test, exam or mock-test capability in the backend at all** — no controller, no table, no service. The only assessment flow is a practice session, and it is always scoped to exactly one sub-topic. |

Per the brief's instruction for this case, this is **reported rather than silently faked or built**. A
timed multi-subject paper with marks, negative marking, a percentile and a section breakdown is a
substantial new subsystem (schema, marking scheme, submission model, results) — not an integration task.
See §4 for exactly what it would take. Until it exists, the Tests screens show an honest
"not available yet" state instead of mock papers.

---

## 2. What changes in the frontend

**New:** `src/lib/http.ts` (base URL from `VITE_API_BASE_URL`, auth header, JSON parsing, one-shot
refresh on 401, typed `ApiError` carrying status + backend `code` + `details`), `src/types/api.ts`
(types mirroring the backend DTOs exactly), `.env.example`.

**Rewritten behind the seam:** `src/lib/api.ts` (every body becomes a real call + a mapper to the
existing frontend type), `src/hooks/useAuth.tsx`, `src/hooks/usePracticeSession.ts`, `src/hooks/useApi.ts`
(gains error/refetch surface for real error states).

**Minimally edited for real data:** `Practice.tsx` (revealed answer, per-question explanation fetch,
session-driven totals), `AIExplanation.tsx` (`steps: string[]`, nullable fields, source/notice/underReview,
disabled Ask-AI), `StudentLayout.tsx` + `Profile.tsx` + `Onboarding.tsx` + `PracticeHub.tsx` (stop
importing `@/data`), `Dashboard.tsx` + `Analytics.tsx` + `Reports.tsx` (real fields; `—` where a metric
has no source), `Login.tsx` + `SignUp.tsx` (real auth, no demo credentials), `Theory.tsx` (by sub-topic),
`Tests.tsx` + `TestRunner.tsx` + `TestResult.tsx` (honest unavailable state).

**Deleted:** `src/data/student.ts`, `src/data/analytics.ts`, `src/data/questions.ts`,
`src/data/curriculum.ts` — runtime product data. `src/data/admin.ts` is kept for now: the admin console is
outside this brief's scope and is flagged in §4.

**Untouched:** every file under `src/components/ui/`, `index.css`, `tailwind.config.ts`, all layout and
spacing. No colour, type scale, spacing value, component shape or navigation path changes.

---

## 3. New backend work

Three read-only endpoints in one new module (`src/analytics/`), plus tests:

* `GET /v1/me/summary`, `GET /v1/me/analytics`, `GET /v1/me/recommendations`
* Permission `analytics:own` — already granted to STUDENT, never previously used by a controller
* Every query filtered by `tenant_id` **and** `user_id` from the JWT, never from the request
* No new table, no new migration; `attempts` and `ability_scores` already carry everything
* Unit tests for the pure aggregation helpers, e2e tests for isolation (one learner cannot see another's
  figures) and for the empty-state (a new learner gets `null`, not `0%`)

---

## 4. Backend capability still missing after this work

Each item is a gap the frontend now *reports* rather than papers over. The screen that hits it shows an honest
state; nothing invents a substitute.

| # | Missing capability | Where the frontend meets it | What it shows instead |
|---|---|---|---|
| 1 | **Tests / mock exams** — no test entity, no fixed paper, no countdown, no exam marking, no stored result | `Tests.tsx`, `TestRunner.tsx`, `TestResult.tsx` | "Mock tests are not available yet", with what is missing and a link to adaptive practice |
| 2 | **Ask-AI** (`POST /v1/questions/:id/ask` — proposed, never built) | the Ask-AI card in `AIExplanation.tsx` | the card keeps its place; the input and button are disabled and say why |
| 3 | **Hint text** — `hintCount` is exposed, the hint strings are not | `Practice.tsx` | the hint panel is hidden. Hint *usage* still travels: `hintCount` is accepted on an attempt |
| 4 | **`matrix_match` and `long_form` answer UI** — the backend serves and grades both | `Practice.tsx` | a line saying this screen cannot answer that type yet, and the question can be skipped |
| 5 | **Benchmarks / percentile / peer band** — `benchmark_snapshots` exists, no service; FR-10.2 gates display on ≥30 qualifying learners | Dashboard and Analytics | removed. No cohort claim is made anywhere |
| 6 | **Mastery as a percentage** — undefined by the requirements, which define mastery as θ mapped to L1–L5 | every progress bar | the real level (`L3`), with the bar as a visual encoding of it (L1→20% … L5→100%) |
| 7 | **Retention** — no spaced-repetition model exists | ChapterView, Reports | dropped; "last practised", which is real, took its place |
| 8 | **Report export** — no export endpoint | the Export PDF button on Reports | a toast saying nothing was generated, because nothing can be |
| 9 | **Notifications** — no mail or scheduling service | Profile → Preferences | the three invented toggles are gone; only the focus-tracking opt-out, which is a real column, remains |
| 10 | **Content ingestion** — no upload endpoint, no extractor, no job store, no extraction review queue | four admin pages | each says it is not connected, and what would be needed |
| 11 | **Admin console wiring** — real admin APIs *do* exist for questions, students, syllabus and explanation review; connecting eight admin pages to them is separate scope | the remaining admin pages | each names the endpoint that exists and says the console is not wired in this phase |
| 12 | **Editing your own email** — no verification flow for a change of address | Profile | the field is read-only and says so |

### Two smaller notes from the live run

* **`REDIS_URL` — resolved.** It was required by config validation although nothing in `src/` reads it. It is now optional
  (validated only when present); background work runs on PostgreSQL.
* **The frontend had no `@types/node`,** while `tsconfig.json` includes `vite.config.ts`, which imports
  `node:url`. `npm run typecheck` — and therefore `npm run build` — failed on the delivered tree before this
  phase. Fixed with a local declaration for the two members that file uses, rather than by adding a Node-wide
  type dependency to a browser project.
