# Frontend ↔ Backend Contract

Source inspected: `apexprep-frontend/src/lib/api.ts`, `src/types/index.ts`,
`src/hooks/useAuth.tsx`, `src/hooks/usePracticeSession.ts`, all student and admin pages.
The frontend is **not modified** by this project. Where the frontend's shape conflicts
with the requirements, the requirements win and the frontend change needed at
integration time is listed in §3.

## 1. `api.ts` functions → endpoints

| Frontend call | Backend endpoint | Notes |
| --- | --- | --- |
| `getTracks()` | `GET /v1/tracks` | |
| `getTrack(id)` | `GET /v1/tracks/{id}` | |
| `getSubjects(trackId)` / `getSubject` / `getChapters` / `getChapter` / `getTopics` / `getTopic` | `GET /v1/tracks/{id}/tree` (one call) plus `GET /v1/subjects/{id}`, `/v1/chapters/{id}`, `/v1/topics/{id}` | Tree carries the student's mastery per node so the Learn pages need one request. |
| `getTheory(id)` / `getTheoryBySubTopic(id)` | `GET /v1/subtopics/{id}/theory` | Theory is addressed by sub-topic (the atomic unit), not by a separate theory id. |
| `getPracticeSet(subTopicId, 15)` | `POST /v1/practice/sessions` then `GET /v1/practice/sessions/{id}/next` repeatedly | **Conflict C1.** |
| — (client-side grading in `usePracticeSession`) | `POST /v1/practice/attempts` (with `Idempotency-Key`) | **Conflict C2.** |
| `askAI(question)` | `POST /v1/questions/{id}/ask` (proposed) | Not in the requirements API list — DECISIONS.md §B5. |
| `getStudent()` | `GET /v1/me` + `GET /v1/me/summary` | Streak, solved today, today's accuracy, study time. |
| `getRecommendations()` | `GET /v1/me/recommendations` | Derived from ability + weak areas. |
| `getAnalytics(range, subject)` | `GET /v1/me/analytics?range=&subject_id=` | **Conflict C6.** |
| — | `GET /v1/me/benchmark?subtopic_id=` | Supplies the "Top 100 target" column (renamed top-10 benchmark). |
| (Reports page uses `getAnalytics`) | `GET /v1/me/reports` | |
| `getTests()` / `getTestQuestions()` / `getTestResult()` | **not in requirements** | **Conflict C4.** |
| `getUploadJobs()` | `GET /v1/admin/ingestion/jobs` | **Implemented (Phase 7).** Status mapping in §2. |
| `getReviewItems()` | `GET /v1/admin/ingestion/jobs/{id}/blocks` for one upload; `GET /v1/admin/review-tasks` (Phase 9) for the queue across uploads | The per-job route ships now and carries each block with its confidences, its extracted question and the gates currently blocking it. |
| `getAdminStudents()` | `GET /v1/admin/students` | Cursor-paginated. |
| `getPlatformStats()` | `GET /v1/admin/analytics/overview` | |
| — (upload form has no API call) | `POST /v1/admin/ingestion/assets` | **Implemented (Phase 7).** Not multipart: send the PDF as the raw body with `Content-Type: application/pdf` and the original name in `X-Filename` (DECISIONS §B53). |
| — (approve / reject / edit are local state) | `POST /v1/admin/review-tasks/{id}/approve \| reject`, `PATCH /v1/admin/content-blocks/{id}`, `PATCH /v1/admin/questions/{id}` | |
| — (login/signup are local state) | `/v1/auth/*` | **Conflict C3.** Implemented in Phase 2; see §4. |

### Screens that bypass `api.ts`

Nine files import mock data directly from `@/data` and will need to go through the API
at integration time: `Practice.tsx`, `PracticeHub.tsx`, `Onboarding.tsx`, `Profile.tsx`,
`TestRunner.tsx`, `TestResult.tsx`, `layouts/StudentLayout.tsx`,
`admin/ContentUpload.tsx`, `admin/QuestionBank.tsx`. (The frontend README's claim that
every screen reads through `api.ts` is not accurate for these.)

## 2. Value mappings

| Frontend | Backend |
| --- | --- |
| `Role = 'student' \| 'admin'` | `STUDENT \| ADMIN \| SUPER_ADMIN` |
| `TrackId = 'jee' \| 'neet' \| …` (slug union) | `id` is a UUID; every syllabus node also returns `slug`. The frontend type must widen to `string`. |
| `Difficulty = 1..5` | `difficulty_label` 1..5 (L1–L5) plus `difficulty_b` (Elo scale) |
| `Question.type = 'single' \| 'numerical'` | `single_correct \| multi_correct \| integer \| numeric \| matrix_match \| assertion_reason \| long_form` |
| `Option.key = 'A'..'D'` | `option_key` text (matrix match needs both columns) |
| `UploadJob.status` `queued / processing / review / approved / failed` | `queued` → queued; `extracting … deduplicating`, `publishing` → processing; `awaiting_review` → review; `published` → approved; `failed` / `cancelled` → failed. A duplicate PDF never becomes a job: the upload is rejected with `409 DUPLICATE` naming the existing asset. `progressPct` (0–100) is on the job for a progress bar. |
| `ReviewItem.kind` `theory / question` | `review_tasks.kind` has more values (solution match, duplicate candidate, student report, …) |

## 3. Conflicts between frontend and requirements

- **C1: fixed set vs adaptive stream.** The Practice screen loads 15 questions up
  front and lets the student jump between them in the palette. The requirements specify
  `GET /sessions/{id}/next`, where each question is chosen after the previous answer.
  A pre-built set cannot be adaptive. *Backend:* serves one question at a time. *Frontend
  change:* the palette lists questions already served in the session (review only); "Next"
  calls `/next`.
- **C2: client-side grading and answer leakage.** `Question` carries `correctKey`,
  `correctValue` and the full `explanation`, and `usePracticeSession` grades locally.
  This violates "never expose the correct answer". *Backend:* the student payload has no
  answer fields; grading happens in `POST /practice/attempts`, whose response carries the
  verdict and correct answer; the explanation comes from `/questions/{id}/explanation`.
- **C3: auth.** `useAuth` fabricates a session in `localStorage` with no password check.
  *Backend:* real JWT + refresh. *Frontend change:* call `/v1/auth/*`, keep the access
  token in memory, rely on the HttpOnly refresh cookie.
- **C4: mock tests.** The frontend has a full Tests flow (timer, sections, +4/−1 marking,
  percentile). The required table list and API list contain no tests, test items or
  marking schemes. *Default:* not built until you decide (DECISIONS.md §B1).
- **C5: percentile / peer band.** `Student.peerBand` ("Top 5%") and
  `TestResult.percentile` are rank-derived. The requirements say anonymous benchmarks
  with no student ranks and no leaderboard. *Default:* backend returns `null` for these
  (DECISIONS.md §B2).
- **C6: analytics granularity.** The frontend shows topic-level rows and a 7-point weekly
  trend. The requirements define sub-topic as the atomic unit and a 14-day trend.
  *Backend:* returns sub-topic rows (with topic rollups) and a daily 14-day series; the
  frontend chart must accept 14 points.
- **C7: fields the UI shows that the requirements don't define:** question `hints`,
  `positiveMarks/negativeMarks`, `avgPeerTimeSec`, `difficultyIndex`, subject `color`,
  chapter `weightage`. Handling for each is in DECISIONS.md §B6.

## 4. Auth integration guide (Phase 2, implemented)

What `useAuth.tsx` and the Login / SignUp / Onboarding / Profile pages need to change to.
The backend is live for all of these.

| Frontend today | Backend call | Notes |
| --- | --- | --- |
| `signup(name, email)` | `POST /v1/auth/register` `{ displayName, email, password }` → **201** `AuthResponse` | `name` → `displayName`. Password must be 8–128 chars (the form currently allows 6). |
| `login(email, role)` | `POST /v1/auth/login` `{ email, password }` → **200** `AuthResponse` | The role comes back from the server; the frontend never sends it. |
| session in `localStorage` | keep `accessToken` **in memory**; call `POST /v1/auth/refresh` on app start and on any 401 `TOKEN_EXPIRED` | Every call must use `credentials: 'include'` so the `apx_refresh` HttpOnly cookie is sent. |
| `logout()` | `POST /v1/auth/logout` → **204** | Clears the cookie; `{ "allDevices": true }` signs out everywhere. |
| session rehydration | `GET /v1/auth/me` → `UserDto` | |
| `completeOnboarding(trackId, goal)` | `PATCH /v1/me/profile` `{ primaryTrackId, goal, targetRank, dailyQuestionGoal, completeOnboarding: true }` | `primaryTrackId` must be a track UUID from `GET /v1/tracks` (Phase 3), not the slug `'jee'`. |
| — | `POST /v1/auth/verify-email` `{ token }` | Needs a small `/verify-email?token=…` page (link target in the email). |
| `/forgot-password` page | `POST /v1/auth/forgot-password` `{ email }` → **202** `{ message }` | Same reply whether or not the address has an account; never show "not found". |
| `/reset-password?token=…` page | `POST /v1/auth/reset-password` `{ token, password }` → **200** `{ passwordReset: true }` | **422** `TOKEN_INVALID` for unknown/used/expired links; **400** for password policy. Signs out every session. |

`AuthResponse`:

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "user": {
    "id": "uuid", "tenantId": "uuid", "email": "arjun@example.com", "displayName": "Arjun Verma",
    "role": "STUDENT", "status": "active", "emailVerified": false, "onboarded": false,
    "primaryTrackId": null, "goal": null, "targetRank": null, "dailyQuestionGoal": null,
    "targetExamDate": null, "focusTrackingOptOut": false,
    "createdAt": "2026-09-22T05:00:00.000Z", "lastLoginAt": null
  }
}
```

Mapping to the frontend `Session` type: `name` ← `user.displayName`, `role` ←
`user.role.toLowerCase()` (`'student' | 'admin'`; `SUPER_ADMIN` is new), `trackId` ←
`user.primaryTrackId`, `onboarded` ← `user.onboarded`.

Error handling: switch on `error.code`: `INVALID_CREDENTIALS`, `EMAIL_TAKEN`,
`VALIDATION_FAILED` (with `details[].field`), `TOO_MANY_ATTEMPTS` (with a `Retry-After`
header), `ACCOUNT_DISABLED`, `EMAIL_NOT_VERIFIED`, `TOKEN_EXPIRED`, `TOKEN_INVALID`,
`RATE_LIMITED`, `REGISTRATION_CLOSED`.

Admin screens: `getAdminStudents()` → `GET /v1/admin/students?limit=&cursor=&search=` →
`{ items: UserDto[], nextCursor }`. `mastery`, `accuracy` and `questions` (shown in the
frontend's student table) come from analytics in Phase 8.

## 5. Syllabus, theory and questions (Phase 3, implemented)

What the Learn screens and the admin Question Bank need to change to. All routes need an
access token; every id is a UUID.

| Frontend today | Backend call | Notes |
| --- | --- | --- |
| `getTracks()` | `GET /v1/tracks` → `{ items: Track[] }` | Each track carries `subjects: [{id, slug, name, colorHex}]`, replacing `Track.subjectIds`. |
| `getTrack(id)` | `GET /v1/tracks/{id}` | `year` ← `examYear`; `examDate` is new and drives `daysToExam`. |
| `getSubjects` / `getChapters` / `getTopics` | `GET /v1/tracks/{id}/tree` | **One call** instead of four. `subjects[].chapters[].topics[].subtopics[]`. |
| `getSubject(id)` / `getChapter(id)` / `getTopic(id)` | `GET /v1/subjects/{id}` · `/v1/chapters/{id}` · `/v1/topics/{id}` | Each returns `{ breadcrumbs, <node> }`, the node carrying its whole subtree. |
| `getTheory(id)` / `getTheoryBySubTopic(id)` | `GET /v1/subtopics/{id}/theory` | `{ subtopicId, title, readMinutes, blocks }`. There is no separate `theoryId`: `SubTopic.theoryId` can go. |
| `admin/QuestionBank.tsx` (mock data) | `GET /v1/admin/questions?subtopicId=&status=&type=&difficultyLabel=&search=&limit=&cursor=` | Cursor-paginated summaries; `GET /v1/admin/questions/{id}` for the full question with its answer key. |

Field mapping for tree nodes:

| Frontend | Backend | Notes |
| --- | --- | --- |
| `Subject.color` | `colorHex` | `#RRGGBB` or null. |
| `Chapter.weightage` | `weightagePct` | number or null. |
| `SubTopic.questionCount` | `questionCount` | **Published** questions by primary sub-topic; also rolled up onto topic, chapter, subject and track. |
| `mastery`, `accuracy`, `questionsSolved`, `retention`, `lastPracticedDays` | `mastery` only, always `null` | Per-student progress arrives with the engine and analytics (Phases 4-8). Render "—" until then. |
| — | `status` (`draft \| published \| archived`) | Students only ever receive `published` nodes; the field is there for the admin tree. |
| `TrackId` union (`'jee' \| 'neet' \| …`) | UUID `id` plus `slug` | The union type must widen to `string`; keep `slug` for routing if the URLs matter. |

Theory blocks: `{ id, type, title, body, items?, table? }`. `type` is one of `heading,
paragraph, formula, callout, list, table, figure, example` — a superset of the frontend's
four, so the renderer needs a default branch. `items` is present on list blocks, `table` on
table blocks (`{ columns, rows }`), and `body` carries any introductory text.

**Questions (student side).** The practice API serves exactly this shape, and
`GET /v1/admin/questions/{id}/preview` returns the same projection:

```json
{
  "id": "uuid", "version": 2, "type": "single_correct", "subtopicId": "uuid",
  "stem": "…", "stemJson": null, "difficultyLabel": 2, "expectedTimeSeconds": 60,
  "hintCount": 1,
  "options": [{ "key": "A", "text": "MR²" }],
  "matrix": { "left": [{ "key": "A", "text": "…" }], "right": [{ "key": "p", "text": "…" }] }
}
```

There is no `correctKey`, `correctValue`, `explanation`, `hints`, `positiveMarks`,
`negativeMarks`, `avgPeerTimeSec` or `difficultyIndex` (conflicts C2 and C7). Grading happens
server-side in `POST /v1/practice/attempts` and the explanation comes from its own endpoint
(section 7); `matrix` appears only for `matrix_match`. The
seven backend types replace the frontend's `'single' | 'numerical'`. `hintCount` says how many
hints exist — **revealing one is not implemented yet** (no endpoint serves hint text), so an
attempt's `hintCount` is for now whatever the client reports.

## 6. Practice (Phase 5, implemented)

This replaces `usePracticeSession`'s local state machine and its client-side grading. The
whole flow is four calls; every one needs an access token and a `STUDENT` account.

| Step | Call | Returns |
| --- | --- | --- |
| Start | `POST /v1/practice/sessions` `{ subtopicId, targetQuestionCount?, deviceType? }` | `{ session, progress, decayApplied }`. Already practising this sub-topic? You get that session back with `resumed: true`. |
| Question | `GET /v1/practice/sessions/{id}/next` (`?skip=true` to move on) | `{ item, question, session, progress, contentGap? }` |
| Answer | `POST /v1/practice/attempts` + `Idempotency-Key` header | `{ outcome, score, correct, revealedAnswer, explanationAvailable, probableGuess, expectedScore, progress, level, session, replayed }` |
| Finish | `POST /v1/practice/sessions/{id}/end` `{ status?, reason? }` | The closed session |

Plus `GET /v1/practice/sessions/{id}` for the current state and
`POST /v1/practice/sessions/{id}/events` for focus events.

**The five things that differ from the frontend's current assumptions.**

1. **There is no question set.** `getPracticeSet(subTopicId, 15)` has no equivalent: the
   engine chooses one question at a time from what the student has just done (conflict C1).
   `targetQuestionCount` is only a goal to show in the UI. Keep a running list client-side if
   the screen needs a "question 4 of 15" affordance.
2. **`GET /next` is idempotent.** While a question is unanswered it returns that same
   question, so a refresh or a second tab cannot skip one. To move on deliberately, call it
   with `?skip=true` — the question is then recorded as skipped and will not come back soon.
3. **Grading is server-side and the key arrives afterwards.** Send
   `{ sessionItemId, response, totalTimeMs, ttfiMs?, answerChanges?, hintCount? }`, where
   `response` is `{ optionKeys: ["A"] }`, `{ value: "4.2" }`, `{ matrix: { "A": ["q"] } }` or
   `{ text: "…" }`. The body has **no** field for correctness and a request that invents one
   is rejected (400). The answer key comes back in `revealedAnswer` on the response — that is
   the first and only place it appears. A `long_form` answer comes back
   `outcome: 'ungraded', score: null`: it is stored, not marked.
4. **The `Idempotency-Key` header is required.** Any stable string of 8–128 characters from
   `[A-Za-z0-9_.:-]` — a UUID per question is the obvious choice. Retrying with the same key
   returns the stored attempt with `replayed: true` and grades nothing twice; answering the
   same question under a *different* key is `409 INVALID_STATE`.
5. **Two 409s the UI has to handle.** `SESSION_PAUSED` — three rushed wrong answers in a row
   have paused this session; show the message and offer a fresh session. `NO_ELIGIBLE_QUESTIONS`
   — the sub-topic has nothing to practise; send the student elsewhere.

`explanationAvailable` on an attempt response says an approved official solution exists for
that question. The text now comes from `GET /v1/questions/{id}/explanation` (section 7) — and
that endpoint answers for questions without an official solution too, so the flag is a hint
about *which* source to expect, not a gate on showing the button.

**Progress**, on every response: `{ theta, level, attemptsCount, gradedCount, correctCount,
placementStatus }`. `level` is 1–5 and is what a "level" badge should show; `theta` is the Elo
ability behind it. **`level`** on an attempt response is the *change*:
`{ change: 'promoted' | 'demoted' | 'unchanged', rule, blockedBy }` — enough to animate a
level-up and to explain why one did not happen (`blockedBy: 'l1_protection'`).

**`item.selectionReason`** says why the engine picked this question — `cold_start`,
`placement`, `adaptive`, `probe` or `content_gap_fallback`. A `probe` is deliberately harder
than the student's usual target, which is worth saying in the UI so a wrong answer does not
read as a setback. `contentGap` is present when the sub-topic has fewer eligible questions
than the engine wants, and `widenedToParentTopic` tells you the question came from a
neighbouring sub-topic.

**Focus events** are the only telemetry, and only the types in the enum exist:
`visibility_hidden/visible`, `app_background/foreground`, `first_interaction`,
`answer_changed`, `idle_start/end`, `break_start/end`, `explanation_opened/closed`. There is
no keystroke logging, no camera, no microphone, no screen recording and no geolocation —
anything else is rejected (400). Post batches of up to 100 with a `clientEventId` each; a
replayed batch is ignored. Check `session.focusTrackingEnabled` first: when the organisation
has tracking off, posting events is `409` (and the client should not collect them at all).

## 7. Explanations (Phase 6, implemented)

This is what `Question.explanation` in the frontend's mock data becomes (conflict C2). The
explanation is a separate call, made **after** the attempt has been submitted.

| Call | Who | Returns |
| --- | --- | --- |
| `GET /v1/questions/{id}/explanation` | student | `{ id, questionId, questionVersion, source, notice, summary, steps, keyConcept, commonMistake, optionKey, underReview, generatedAt }` |
| `POST /v1/questions/{id}/report` `{ reason, comment? }` | student | `{ reportId, reason, reportCount, explanationUnpublished }` |

**`source` is the one field the UI has to branch on.** It is one of four values, and the
requirements ask that the first three be distinguishable from each other:

| `source` | Means | `notice` |
| --- | --- | --- |
| `official_solution` | The course's own approved solution | `null` |
| `notes_only` | Generated, fully supported by the course notes | `null` |
| `mostly_notes` | Generated, mostly supported by the course notes | `null` |
| `general_knowledge` | Generated from general subject knowledge | `"Not from official notes — pending review"` |

**When `notice` is not null it must be displayed with the explanation.** It is the product's
exact wording; do not reword, translate or truncate it. `underReview` is true when a reviewer
has been asked to look at the explanation — worth a quiet marker, not an alarm.

**`steps` is an array**, one reasoning step per entry; render it as an ordered list.
`keyConcept` and `commonMistake` are nullable. `optionKey` is set when the explanation was
written for the particular wrong option the student chose, in which case it also says why that
option is tempting — there is no need to request it, and no way to: the variant follows from the
student's own recorded attempt, never from a query parameter.

**Four states the UI has to handle.**

1. **403** before the question has been answered — `"Answer this question first…"`. Do not offer
   the explanation button until an attempt has been submitted.
2. **409 `EXPLANATION_UNAVAILABLE`** — it failed its safety checks, was withdrawn after reports,
   is out of date, or is waiting for a teacher. `error.details[0].message` says which
   (`failed_validation`, `unpublished_after_reports`, `superseded`, `pending_human_approval`);
   `error.message` is already written for a student to read.
3. **503 `AI_NOT_CONFIGURED` / `AI_PROVIDER_UNAVAILABLE`** — no explanation can be written right
   now. Treat as retryable later, not as an error in the question.
4. **409 on a second report** from the same student — one open report per student per question.

**Reporting.** `reason` must be one of `wrong_answer`, `wrong_solution`, `typo`, `unclear`,
`missing_diagram`, `wrong_topic`, `other` (`wrong_solution` is the one for a faulty
explanation); `comment` is optional and reaches the reviewer only. `reportCount` is how many
distinct students have reported the question, and `explanationUnpublished` is true when this
report is the one that took it out of circulation.

**Nothing about retrieval reaches the student.** There is no grounding score, no block id, no
provider or model name, and no diagnostics in this payload — the admin route
`GET /v1/admin/questions/{id}/explanation` carries all of that for reviewers.

## 8. Content ingestion (Phase 7, implemented)

Admin routes only. **Nothing in this section changes a single student-facing payload**: the student
sees ingested content through the endpoints §5 and §6 already describe, and only once a person has
published it. An unpublished, rejected, ambiguous or auto-approved-but-unpublished block is invisible
to `GET /v1/subtopics/{id}/theory` and to the practice flow.

| Route | What it does |
| --- | --- |
| `POST /v1/admin/ingestion/assets` | Upload a source PDF. Raw body, `Content-Type: application/pdf`. Optional `?trackId=&subjectId=&hint=`; original name in `X-Filename`. `201` with `{ assetId, jobId, sha256, pageCount, byteSize, storageKey, queueJobId }`. |
| `GET /v1/admin/ingestion/jobs` | This organisation's jobs, newest first. `?status=&limit=`. |
| `GET /v1/admin/ingestion/jobs/{id}` | One job with its stage, progress, page and block counts, error code and message, and its review tasks. |
| `POST /v1/admin/ingestion/jobs/{id}/retry` | Run it again. `202`. Idempotent; a reviewer's work survives. |
| `GET /v1/admin/ingestion/jobs/{id}/blocks` | Every block the job produced, with its source page and order, its confidences, the extracted question, what the machine concluded, and the gates currently blocking publication. |
| `POST /v1/admin/ingestion/blocks/{id}/approve` | Approve as it stands; resolves the tasks naming it. |
| `POST /v1/admin/ingestion/blocks/{id}/reject` | Reject. `note` is **required**. The content is kept. |
| `PATCH /v1/admin/ingestion/blocks/{id}` | Edit `text`, `title`, `subtopicId` or `question`. **Every call is a save**, so a client may PATCH as the reviewer types — there is no separate draft to lose. |
| `POST /v1/admin/ingestion/blocks/{id}/reclassify` | Say what a block actually is. How an `ambiguous` block becomes usable. |
| `POST /v1/admin/ingestion/blocks/merge` | `{ blockIds: [...] }`, merged into the first in reading order. The sources are kept and point at the survivor. |
| `POST /v1/admin/ingestion/blocks/{id}/split` | `{ pieces: [{ text, kind?, … }] }`. `201`. The original is kept as `superseded`; each piece records where it came from. |
| `POST /v1/admin/ingestion/blocks/{id}/publish` | Run the gates and publish. A question block becomes a real question through the question bank. |
| `POST /v1/admin/ingestion/blocks/{id}/unpublish` | Take it back out. A published question is **retired**, not deleted, so attempt history stays intact. |

**Upload errors, in the order they are checked.**

| Status | Code | Cause |
| --- | --- | --- |
| `400` | `VALIDATION_FAILED` | Empty body; a declared content type that is not `application/pdf`; a file whose own header is not `%PDF-`; an encrypted PDF; a PDF with no readable pages. `error.details[0].message` says which, in words a person can act on. |
| `413` | `PAYLOAD_TOO_LARGE` | Over `UPLOAD_MAX_MB`, or more pages than `UPLOAD_MAX_PAGES`. The size limit is enforced while the body is read. |
| `409` | `DUPLICATE` | The same bytes (SHA-256) already exist in this organisation. The message names the existing asset. Two organisations may each hold the same PDF. |
| `403` / `401` | `FORBIDDEN` / `UNAUTHENTICATED` | Not an admin / not signed in. |
| `429` | `RATE_LIMITED` | Uploads use the stricter rate-limit bucket. |

**A block a reviewer cannot publish tells them why.** `publish` answers `422 NOT_PUBLISHABLE` with
one `details` entry per failing gate, `field` being the gate name: `stem`, `correct_answer`,
`options`, `subtopic`, `difficulty`, `expected_time`, `diagram_asset`, `ocr_reviewed`,
`low_confidence_reviewed`, `solution_linkage`, `open_review_tasks`, `block_kind`,
`tenant_ownership`. The same list is on every block in `gateFailures`, so the UI can show what is
missing before the button is pressed. There is no override and no force parameter.

**Two things a reviewer always has to supply for a question**, because a printed question does not
state them: `expectedTimeSeconds` (see DECISIONS §B54 — it feeds the adaptive engine's guess and
promotion rules, so it is never invented) and `difficultyLabel` where the source printed no
difficulty. PATCH them under `question`.

**`embeddings` on a publish response** reports whether the published theory reached semantic
retrieval: `{ attempted, embedded, note }`. `embedded: null` with a note means the server cannot
store vectors (no pgvector, or no embedding provider); the block is published and searchable by
keyword either way.

## 9. Learning contexts and a learner's tracks (Phase 8, implemented)

Phase 8 generalises the platform from an exam-prep product to a learning platform. **No frontend file
is modified by this project**, and nothing below breaks an existing call: every change is an added
field or an added endpoint. This section says what is new, what it means, and the two places where the
existing frontend will need a change at integration time.

### 9.1 `TrackDto` gained seven fields. All may be null.

Everywhere a track is returned — `GET /v1/tracks`, `GET /v1/tracks/{id}`, the tree, the admin list,
and each entry of `GET /v1/me/tracks` — the object now carries:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"school"` · `"competitive_exam"` · `"olympiad"` · `"other"` · `null` | What sort of learning context this is |
| `educationStage` | string · null | Free text, e.g. `"primary"`. No vocabulary is imposed |
| `gradeLabel` | string · null | What the learner calls it, e.g. `"Class 5"` |
| `gradeOrdinal` | 1–20 · null | **For ordering and filtering only** |
| `examFamily` | string · null | Free text, e.g. `"JEE"`. No exam list is imposed |
| `curriculum` | string · null | Free text board/curriculum. No board list is imposed |
| `locale` | string · null | BCP-47-style tag, e.g. `"en-IN"` |

Three things to hold on to:

* **`null` means "not stated", never a default.** Every track that existed before this release has
  `kind: null`, because the migration back-fills nothing. A UI that treats null as "competitive exam"
  reintroduces the exam assumption this release removes. Show nothing, or show "Uncategorised".
* **`gradeOrdinal` is not a difficulty.** It exists so Class 5 sorts before Class 6. Difficulty is
  `difficultyLabel` (L1–L5) and is unchanged. Do not derive one from the other.
* **`kind: "olympiad"` is a safety-relevant value.** On such a track, generated explanations are held
  until a teacher approves them, so `GET /v1/questions/{id}/explanation` can answer
  `409` with `details[0].message = "pending_human_approval"`. That behaviour already existed; what
  changed is that it now follows `kind` rather than the track's name.

### 9.2 New: a learner's own tracks

Four endpoints under `me/tracks`, all requiring a signed-in **student** (`self:profile`). A learner has
**one or more** tracks; before this release they had exactly one.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/v1/me/tracks` | — | `LearnerTrackDto[]`, primary first, then most recently enrolled |
| `POST` | `/v1/me/tracks` | `{ trackId, goalText?, makePrimary? }` | `201` with the enrolment |
| `PATCH` | `/v1/me/tracks/{trackId}` | `{ isPrimary?: true, goalText? }` | `200` with the enrolment |
| `DELETE` | `/v1/me/tracks/{trackId}` | — | `200` with the enrolment, now `status: "left"` |

`LearnerTrackDto`:

```json
{
  "id": "uuid",
  "trackId": "uuid",
  "isPrimary": true,
  "status": "active",
  "goalText": "Get confident with perimeter",
  "enrolledAt": "2026-09-27T10:00:00.000Z",
  "leftAt": null,
  "track": { "id": "uuid", "name": "Class 5 Mathematics", "kind": "school", "gradeLabel": "Class 5", "...": "the full TrackDto" }
}
```

Behaviour the UI can rely on:

* **Addressed by track id, not enrolment id.** A learner has at most one enrolment per track, so the
  frontend never has to hold an enrolment id to change one.
* **The first track a learner enrols in becomes primary.** After that, a new enrolment does not take
  the primary slot unless `makePrimary: true`.
* **At most one primary track, guaranteed by the database.** Two concurrent "make this primary"
  requests cannot leave a learner with two.
* **`isPrimary: false` is refused** with `400` and `details[0].field = "isPrimary"`. There is no
  "not primary" state: make another track primary, or leave this one.
* **Leaving keeps the row** with `status: "left"` and a `leftAt`, so the UI can show and offer to
  rejoin it. Enrolling again reactivates the same enrolment — the `id` is unchanged and the goal text
  survives. **No progress is deleted**: mastery is recorded per sub-topic and is untouched.
* **Leaving your primary track leaves you with no primary track.** Nothing is promoted in its place, so
  the UI should prompt for a choice rather than assume one.
* Errors: `422 REFERENCE_NOT_FOUND` for an unknown, other-organisation or unpublished track;
  `404` for a track the learner is not enrolled in; `409 INVALID_STATE` for changing a track they have
  left; `400` for a malformed uuid.

### 9.3 `PATCH /v1/me/profile` still works, and now keeps enrolments in step

`primaryTrackId` on the profile endpoint is unchanged and still supported — it is how the existing
frontend sets a primary track. Sending it now also creates or reactivates the matching enrolment and
makes it primary, in one transaction, so `GET /v1/me` and `GET /v1/me/tracks` can never disagree.
A learner who has only ever used the profile endpoint gets their enrolment row created the first time
either endpoint is read, so nothing needs migrating client-side.

### 9.4 One field removed from the attempt result

`POST /v1/practice/attempts` no longer returns **`expectedScore`**. It was the engine's predicted
probability of a correct answer, and it inverts:
`E = 1 / (1 + 10^((b − θ)/elo_scale))` can be solved for the question's `difficulty_b`, which the
student projection deliberately withholds. Everything else in the response is unchanged, including
`progress.theta`, `progress.level` and `level.change`.

**This is the one removal in Phase 8.** The frontend does not read `expectedScore` today (checked
against `src/lib/api.ts` and `src/types/index.ts`), so no change is required — it is listed here
because it is a breaking change for any client that did.

### 9.5 Admin: describing a track

`POST /v1/admin/tracks` and `PATCH /v1/admin/tracks/{id}` accept all seven fields above. Two rules the
admin UI should enforce so the user does not meet a server error:

* `gradeOrdinal` requires `kind: "school"`. Otherwise `400` with
  `details[0].field = "gradeOrdinal"` — including when an edit moves `kind` away from `school` while a
  grade is set.
* `kind` must be one of the four values, and `locale` must look like a language tag (`en`, `en-IN`,
  `sa-Deva-IN`). Anything else is `400`.

Everything else about admin track CRUD is unchanged.

### 9.6 What the frontend will need at integration time

Two items, both additive, neither urgent:

1. **A track's learning context is available but unused.** The Learn and onboarding screens currently
   present tracks as exams. To show a Class 5 learner their class, read `kind`, `gradeLabel` and
   `curriculum` — and treat `null` as "not stated".
2. **A learner can now have several tracks.** `useAuth`/`getStudent()` exposes one `primaryTrackId`,
   which still works. A multi-track UI (a switcher, or a home screen grouped by track) needs
   `GET /v1/me/tracks`. Until then the product behaves exactly as it did, with one track per learner.

No existing frontend call changes its shape, its status codes or its meaning.
