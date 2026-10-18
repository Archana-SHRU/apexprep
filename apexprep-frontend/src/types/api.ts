/**
 * The backend's own shapes, transcribed field for field.
 *
 * Deliberately separate from `src/types/index.ts`, which describes what the *UI* renders. Keeping the two
 * apart means the mapping between them lives in one visible place (`src/lib/api.ts`) instead of being
 * smeared across components, and a backend field this app does not use is still written down.
 *
 * Two conventions the backend holds to, and this app relies on:
 *
 * * **`null` means "no data", not "zero".** A learner with no graded attempts has `accuracy: null`, not 0.
 *   Rendering 0% would tell them they got everything wrong.
 * * **Mastery is a band, not a percentage.** The requirements define mastery as θ mapped to L1–L5, so the
 *   API returns `level` (1-5) and no percentage exists to fetch.
 *
 * Nothing here is `any`. Where the backend returns an open object (`revealedAnswer`, `stemJson`) the type
 * is `Record<string, unknown>`, which forces a check at the point of use.
 */

// ---------------------------------------------------------------- auth & profile

export type BackendRole = 'STUDENT' | 'ADMIN' | 'SUPER_ADMIN';

export interface UserDto {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: BackendRole;
  status: 'active' | 'disabled';
  emailVerified: boolean;
  onboarded: boolean;
  primaryTrackId: string | null;
  primaryTrackName?: string | null;
  questionsSolved?: number;
  goal: string | null;
  targetRank: number | null;
  dailyQuestionGoal: number | null;
  targetExamDate: string | null;
  focusTrackingOptOut: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserPageDto {
  items: UserDto[];
  nextCursor: string | null;
}

export interface AuthResponseDto {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  /** Only present when the backend runs with REFRESH_TOKEN_IN_BODY=true; the browser uses the cookie. */
  refreshToken?: string;
  user: UserDto;
}

export interface UpdateProfileBody {
  displayName?: string;
  primaryTrackId?: string;
  goal?: string;
  targetRank?: number;
  dailyQuestionGoal?: number;
  targetExamDate?: string;
  focusTrackingOptOut?: boolean;
  completeOnboarding?: boolean;
}

// ---------------------------------------------------------------- syllabus

export type TrackKind = 'school' | 'competitive_exam' | 'olympiad' | 'other';
export type NodeStatus = 'draft' | 'published' | 'archived';

/** The Phase 8 learning context is the `kind`…`locale` block; every field of it may be null. */
export interface TrackDto {
  id: string;
  slug: string;
  name: string;
  shortName: string | null;
  description: string | null;
  examYear: number | null;
  examDate: string | null;
  kind: TrackKind | null;
  educationStage: string | null;
  gradeLabel: string | null;
  /** Ordering only. Explicitly **not** a difficulty. */
  gradeOrdinal: number | null;
  examFamily: string | null;
  curriculum: string | null;
  locale: string | null;
  sortOrder: number;
  status: NodeStatus;
}

export interface SubjectSummaryDto {
  id: string;
  slug: string;
  name: string;
  colorHex: string | null;
}

export interface TrackSummaryDto extends TrackDto {
  subjects: SubjectSummaryDto[];
}

export interface TrackListDto {
  items: TrackSummaryDto[];
}

/** `mastery` is declared by the backend but is hardcoded null at every level today. */
export interface SubtopicNodeDto {
  id: string;
  topicId: string;
  slug: string;
  name: string;
  description: string | null;
  sortOrder: number;
  status: NodeStatus;
  questionCount: number;
  hasTheory: boolean;
  mastery: number | null;
}

export interface TopicNodeDto {
  id: string;
  chapterId: string;
  slug: string;
  name: string;
  sortOrder: number;
  status: NodeStatus;
  questionCount: number;
  mastery: number | null;
  subtopics: SubtopicNodeDto[];
}

export interface ChapterNodeDto {
  id: string;
  subjectId: string;
  slug: string;
  name: string;
  weightagePct: number | null;
  sortOrder: number;
  status: NodeStatus;
  questionCount: number;
  mastery: number | null;
  topics: TopicNodeDto[];
}

export interface SubjectNodeDto {
  id: string;
  trackId: string;
  slug: string;
  name: string;
  colorHex: string | null;
  sortOrder: number;
  status: NodeStatus;
  questionCount: number;
  mastery: number | null;
  chapters: ChapterNodeDto[];
}

export interface TrackTreeDto {
  track: TrackDto;
  questionCount: number;
  subjects: SubjectNodeDto[];
}

export type SyllabusLevel = 'track' | 'subject' | 'chapter' | 'topic' | 'subtopic';

/** The ancestors of a node, so a page addressed by one id can title itself without fetching the tree. */
export interface BreadcrumbDto {
  level: SyllabusLevel;
  id: string;
  slug: string;
  name: string;
}

export interface SubjectDetailDto {
  breadcrumbs: BreadcrumbDto[];
  subject: SubjectNodeDto;
}
export interface ChapterDetailDto {
  breadcrumbs: BreadcrumbDto[];
  chapter: ChapterNodeDto;
}
export interface TopicDetailDto {
  breadcrumbs: BreadcrumbDto[];
  topic: TopicNodeDto;
}
export interface SubtopicDetailDto {
  breadcrumbs: BreadcrumbDto[];
  subtopic: SubtopicNodeDto;
}

export type TheoryBlockType = 'heading' | 'paragraph' | 'formula' | 'callout' | 'list' | 'table' | 'figure' | 'example';

export interface TheoryBlockDto {
  id: string;
  type: TheoryBlockType;
  title: string | null;
  body: string | null;
  items?: string[];
  table?: { columns: string[]; rows: string[][] };
}

export interface TheoryDto {
  subtopicId: string;
  title: string;
  readMinutes: number;
  blocks: TheoryBlockDto[];
}

// ---------------------------------------------------------------- learner tracks

export interface LearnerTrackDto {
  id: string;
  trackId: string;
  isPrimary: boolean;
  status: 'active' | 'left';
  goalText: string | null;
  enrolledAt: string;
  leftAt: string | null;
  track: TrackDto;
}

// ---------------------------------------------------------------- practice

export type QuestionType = 'single_correct' | 'multi_correct' | 'integer' | 'numeric' | 'matrix_match' | 'assertion_reason' | 'long_form';

export interface StudentOptionDto {
  key: string;
  text: string;
}

/**
 * What a learner is allowed to see of a question.
 *
 * The answer key is absent **by construction** — the backend builds this from a column allow-list, so
 * there is no `correctKey`, no `difficultyB` and no hint text to read. `hintCount` is the count only.
 */
export interface StudentQuestionDto {
  id: string;
  version: number;
  type: QuestionType;
  subtopicId: string;
  stem: string;
  stemJson: Record<string, unknown> | null;
  difficultyLabel: number;
  expectedTimeSeconds: number;
  hintCount: number;
  options: StudentOptionDto[];
  matrix?: { left: StudentOptionDto[]; right: StudentOptionDto[] };
}

export interface PracticeSessionDto {
  id: string;
  subtopicId: string;
  mode: 'adaptive' | 'placement' | 'review';
  status: 'active' | 'completed' | 'abandoned' | 'expired';
  servedCount: number;
  answeredCount: number;
  targetQuestionCount: number | null;
  focusTrackingEnabled: boolean;
  resumed: boolean;
  paused: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface StudentProgressDto {
  theta: number;
  /** The L1–L5 band the adaptive engine maintains. This is what "mastery" means. */
  level: number;
  attemptsCount: number;
  gradedCount: number;
  correctCount: number;
  placementStatus: 'not_started' | 'in_progress' | 'completed' | 'skipped';
}

export interface ServedItemDto {
  id: string;
  position: number;
  selectionReason: 'cold_start' | 'placement' | 'adaptive' | 'probe' | 'content_gap_fallback';
  servedAt: string;
}

export interface SessionStartDto {
  session: PracticeSessionDto;
  progress: StudentProgressDto;
  decayApplied: number;
}

export interface NextQuestionDto {
  item: ServedItemDto;
  question: StudentQuestionDto;
  session: PracticeSessionDto;
  progress: StudentProgressDto;
  /** Absent — not null — unless the pool was thin. */
  contentGap?: { eligibleCount: number; minEligible: number; widenedToParentTopic: boolean };
}

/** What the learner submits. One of these four shapes, matching the question's type. */
export type StudentResponseBody =
  | { optionKeys: string[] }
  | { value: string }
  | { matrix: Record<string, string[]> }
  | { text: string };

export interface SubmitAttemptBody {
  sessionItemId: string;
  response: StudentResponseBody;
  totalTimeMs: number;
  ttfiMs?: number;
  answerChanges?: number;
  hintCount?: number;
  clientSubmittedAt?: string;
}

export interface RevealHintDto {
  sessionItemId: string;
  hintIndex?: number;
}

export interface RevealedHintDto {
  hintIndex: number;
  hintText: string;
  totalHints: number;
  hintsRemaining: number;
}

export interface LevelChangeDto {
  change: 'promoted' | 'demoted' | 'unchanged';
  rule: string | null;
  blockedBy: string | null;
}

/**
 * The server's verdict on an attempt.
 *
 * `correct` and `revealedAnswer` are the **only** source of truth about whether the learner was right.
 * Nothing in this app compares an answer to a key: the key does not exist here until this response
 * arrives. Note `level` is the *change* object while `progress.level` is the numeric band.
 */
export interface AttemptResultDto {
  attemptId: string;
  questionId: string;
  questionVersion: number;
  outcome: 'correct' | 'incorrect' | 'partial' | 'ungraded';
  score: number | null;
  correct: boolean | null;
  revealedAnswer: Record<string, unknown>;
  explanationAvailable: boolean;
  probableGuess: boolean;
  progress: StudentProgressDto;
  level: LevelChangeDto;
  session: PracticeSessionDto;
  replayed: boolean;
}

export type SessionEventType =
  | 'visibility_hidden'
  | 'visibility_visible'
  | 'app_background'
  | 'app_foreground'
  | 'first_interaction'
  | 'answer_changed'
  | 'idle_start'
  | 'idle_end'
  | 'break_start'
  | 'break_end'
  | 'explanation_opened'
  | 'explanation_closed';

export interface SessionEventBody {
  clientEventId: string;
  eventType: SessionEventType;
  occurredAt: string;
  durationMs?: number;
  sessionItemId?: string;
}

export interface SessionEventsResultDto {
  accepted: number;
  received: number;
}

// ---------------------------------------------------------------- explanations

export interface ExplanationDto {
  id: string;
  questionId: string;
  questionVersion: number;
  source: 'official_solution' | 'notes_only' | 'mostly_notes' | 'general_knowledge';
  /** The product's exact wording for a general-knowledge explanation. Shown verbatim. */
  notice: string | null;
  summary: string;
  /** Plain strings, not {title, body} pairs. */
  steps: string[];
  keyConcept: string | null;
  commonMistake: string | null;
  optionKey: string | null;
  underReview: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------- analytics

export interface LearnerSummaryDto {
  solvedToday: number;
  todayAccuracy: number | null;
  studyMinutesToday: number;
  streakDays: number;
  dailyQuestionGoal: number | null;
  questionsSolvedTotal: number;
  daysToTargetExam: number | null;
}

export interface LevelAccuracyDto {
  level: number;
  attempted: number;
  correct: number;
  accuracy: number | null;
}

export interface TrendPointDto {
  weekStart: string;
  questions: number;
  accuracy: number | null;
}

export interface SubtopicPerformanceDto {
  subtopicId: string;
  subtopicName: string;
  topicName: string;
  subjectName: string;
  subjectId: string;
  questions: number;
  accuracy: number | null;
  paceSeconds: number | null;
  /** L1–L5 from the engine. Not a percentage. */
  level: number | null;
  lastPracticedDays: number | null;
}

export interface AnalyticsSubjectSummaryDto {
  subjectId: string;
  name: string;
  colorHex: string | null;
  questions: number;
  accuracy: number | null;
  /** Mean L1–L5 band across this subject's sub-topics, one decimal. */
  level: number | null;
  strongest: string | null;
  needsReview: string | null;
}

export interface LearnerAnalyticsDto {
  range: string;
  overallAccuracy: number | null;
  accuracyDelta: number | null;
  questionsSolved: number;
  paceSeconds: number | null;
  coveragePct: number | null;
  levelAccuracy: LevelAccuracyDto[];
  trend: TrendPointDto[];
  weakSubtopics: SubtopicPerformanceDto[];
  strongSubtopics: SubtopicPerformanceDto[];
  /** Every sub-topic with at least one attempt in scope, unranked. Absent from this list means no attempts. */
  subtopicPerformance: SubtopicPerformanceDto[];
  subjectSummary: AnalyticsSubjectSummaryDto[];
}

export interface RecommendationDto {
  kind: 'continue' | 'practice' | 'focus';
  subtopicId: string;
  subtopicName: string;
  topicName: string;
  subjectName: string;
  subjectId: string;
  questionCount: number;
  accuracy: number | null;
  level: number | null;
  lastPracticedDays: number | null;
  reason: string;
}

export interface RecommendationsDto {
  items: RecommendationDto[];
}

// ---------------------------------------------------------------- admin: question bank

export interface AdminQuestionSummaryDto {
  id: string;
  subtopicId: string;
  type: QuestionType;
  status: 'draft' | 'published' | 'retired';
  version: number;
  /** The first 200 characters of the stem. The full stem is on the question's detail. */
  stemPreview: string;
  difficultyLabel: number;
  difficultyB: number;
  expectedTimeSeconds: number;
  hasOfficialSolution: boolean;
  createdAt: string;
  updatedAt: string;
  subjectName?: string | null;
  trackName?: string | null;
}

/** `total`, `page` and `pageSize` are present when the list was asked for by page number. */
export interface AdminQuestionPageDto {
  items: AdminQuestionSummaryDto[];
  nextCursor: string | null;
  total?: number;
  page?: number;
  pageSize?: number;
}

export interface QuestionTaxonomyDto {
  trackId: string;
  trackName: string;
  subjectId: string;
  subjectName: string;
  chapterId: string;
  chapterName: string;
  topicId: string;
  topicName: string;
  subtopicId: string;
  subtopicName: string;
}

export interface AdminQuestionOptionDto {
  id: string;
  key: string;
  side: 'single' | 'left' | 'right';
  text: string;
  isCorrect: boolean;
  sortOrder: number;
}

export interface OfficialSolutionDto {
  id: string;
  body: string;
  bodyJson: Record<string, unknown> | null;
  finalAnswerText: string | null;
  status: 'draft' | 'approved' | 'rejected';
  createdAt: string;
}

export interface NumericAnswerDto {
  value: string;
  tolerance: string;
  mode: 'absolute' | 'relative';
}

export interface AdminQuestionDto {
  id: string;
  subtopicId: string;
  secondarySubtopicIds: string[];
  type: QuestionType;
  status: 'draft' | 'published' | 'retired';
  version: number;
  stem: string;
  stemJson: Record<string, unknown> | null;
  options: AdminQuestionOptionDto[];
  numericAnswer: NumericAnswerDto | null;
  matrixAnswer: Record<string, string[]> | null;
  difficultyLabel: number;
  difficultyB: number;
  calibrationN: number;
  expectedTimeSeconds: number;
  /** The hint texts, in the order a student is shown them. */
  hints: string[];
  officialSolution: OfficialSolutionDto | null;
  sourceAssetId: string | null;
  sourcePage: number | null;
  taxonomy?: QuestionTaxonomyDto | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- admin: platform statistics

export interface LearnersStatsDto {
  total: number;
  active: number;
  disabled: number;
  onboarded: number;
}

export interface SubjectQuestionCountDto {
  subjectId: string;
  subjectName: string;
  trackName: string;
  colorHex: string | null;
  /** Published questions under the subject. */
  publishedCount: number;
  /** All questions under the subject, drafts and retired included. */
  totalCount: number;
  /** Same figure as publishedCount; kept because the pages were first written against this name. */
  questionCount?: number;
}

export interface QuestionsStatsDto {
  total: number;
  published: number;
  draft: number;
  retired: number;
  bySubject: SubjectQuestionCountDto[];
}

export interface DailyPracticeVolumeDto {
  date: string;
  attemptsCount: number;
  uniqueLearners: number;
}

export interface PracticeStatsDto {
  dailyPracticeVolume: DailyPracticeVolumeDto[];
  totalAttempts: number;
  todayAttempts: number;
}

export interface IngestionStatsDto {
  totalJobs: number;
  publishedJobs: number;
  failedJobs: number;
  awaitingReviewJobs: number;
  successRatePct: number;
}

export interface AdminStatsDto {
  learners: LearnersStatsDto;
  questions: QuestionsStatsDto;
  practice: PracticeStatsDto;
  ingestion: IngestionStatsDto;
}

// ---------------------------------------------------------------- mock tests

export type TestKind = 'full_length' | 'sectional';
export type TestStatus = 'draft' | 'published' | 'archived';
export type TestSessionStatus = 'in_progress' | 'completed' | 'abandoned' | 'timed_out';
export type TestItemStatus = 'not_visited' | 'not_answered' | 'answered' | 'marked_for_review' | 'answered_and_marked';

export interface MockTestAttemptSummaryDto {
  sessionId: string;
  status: TestSessionStatus;
  totalScore: number;
  maxScore: number;
  accuracy: number;
  startedAt: string;
  submittedAt: string | null;
}

export interface MockTestSummaryDto {
  id: string;
  title: string;
  description: string | null;
  kind: TestKind;
  durationMinutes: number;
  totalMarks: number;
  defaultPositiveMarks: number;
  defaultNegativeMarks: number;
  status: TestStatus;
  questionCount: number;
  sectionCount: number;
  instructions: string | null;
  lastAttempt: MockTestAttemptSummaryDto | null;
}

export interface MockTestSectionDetailDto {
  id: string;
  name: string;
  subjectId: string | null;
  sortOrder: number;
  questionCount: number;
  durationMinutes: number | null;
  instructions: string | null;
}

export interface MockTestDetailDto extends MockTestSummaryDto {
  sections: MockTestSectionDetailDto[];
  pastAttempts: MockTestAttemptSummaryDto[];
}

export interface TestSessionQuestionDto {
  testItemId: string;
  sectionId: string;
  sectionName: string;
  sortOrder: number;
  positiveMarks: number;
  negativeMarks: number;
  question: StudentQuestionDto;
  currentResponse: Record<string, unknown> | null;
  status: TestItemStatus;
  timeSpentSec: number;
}

export interface TestSessionSectionDto {
  id: string;
  name: string;
  sortOrder: number;
  durationMinutes: number | null;
  questions: TestSessionQuestionDto[];
}

export interface TestSessionStateDto {
  sessionId: string;
  testId: string;
  testTitle: string;
  kind: TestKind;
  durationMinutes: number;
  totalMarks: number;
  startedAt: string;
  endsAt: string;
  remainingSeconds: number;
  status: TestSessionStatus;
  /** The question the student last had open, so a refresh resumes where they were. */
  activeTestItemId: string | null;
  sections: TestSessionSectionDto[];
}

export interface SubmitTestAnswerDto {
  testItemId: string;
  response: Record<string, unknown> | null;
  status: TestItemStatus;
}

/** What saving an answer or reporting the open question returns: the server's own clock. */
export interface SessionClockDto {
  ok: boolean;
  /** Seconds until the deadline, on the server clock. */
  remainingSeconds: number;
}

export interface SectionResultDto {
  sectionId: string;
  sectionName: string;
  score: number;
  maxScore: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
  accuracy: number;
  timeSpentSec: number;
}

export interface QuestionResultOptionDto {
  key: string;
  text: string;
  isCorrect?: boolean;
}

export interface QuestionResultMatrixDto {
  left: QuestionResultOptionDto[];
  right: QuestionResultOptionDto[];
}

export interface QuestionResultAnalysisDto {
  testItemId: string;
  questionId: string;
  sectionName: string;
  sortOrder: number;
  stem: string;
  stemJson: Record<string, unknown> | null;
  type: string;
  options: QuestionResultOptionDto[];
  matrix?: QuestionResultMatrixDto;
  correctAnswer: Record<string, unknown>;
  studentResponse: Record<string, unknown> | null;
  status: TestItemStatus;
  outcome: string;
  score: number;
  positiveMarks: number;
  negativeMarks: number;
  timeSpentSec: number;
  solution?: {
    body: string;
    finalAnswerText?: string | null;
  } | null;
}

export interface TestResultDto {
  sessionId: string;
  testId: string;
  testTitle: string;
  kind: TestKind;
  status: TestSessionStatus;
  startedAt: string;
  submittedAt: string | null;
  timeSpentSec: number;
  /** The total after the floor at 0 that mock tests apply. */
  totalScore: number;
  /** The total before that floor, so a negative paper is visible rather than hidden. */
  rawScore: number;
  maxScore: number;
  percentage: number;
  accuracy: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
  sections: SectionResultDto[];
  questions: QuestionResultAnalysisDto[];
}

// ---------------------------------------------------------------- peer benchmarks & pedagogical features

/**
 * A peer benchmark for one sub-topic. Mirrors the backend's `BenchmarkDto` exactly.
 *
 * `topAccuracy` is a fraction in [0, 1] (not a percentage) and exists only when `isPublished`; a withheld
 * benchmark carries no figures at all, only `message` saying why.
 */
export interface BenchmarkDto {
  subtopicId: string;
  isPublished: boolean;
  /** Students with qualifying attempts in the window. */
  qualifyingStudents: number;
  /** How many are needed before anything is shown (30). */
  minQualifyingStudents: number;
  topK: number;
  topAccuracy: number | null;
  topMedianTimeSeconds: number | null;
  snapshotDate: string | null;
  message?: string;
}

export type DoubtIntent = 'free' | 'why_wrong' | 'simplify' | 'explain_step' | 'concept';

export interface AskQuestionDto {
  message: string;
  intent?: DoubtIntent;
}

export interface AskQuestionResponseDto {
  questionId: string;
  answer: string;
  steps: string[];
  /** Whether the answer rests on the official solution and course notes. */
  grounded: boolean;
  source: 'official_solution' | 'notes_only' | 'mostly_notes' | 'general_knowledge' | 'canned';
  keyConcept: string | null;
  answeredAt: string;
}

// ---------------------------------------------------------------- divergence detection & retention

export interface DivergenceItemDto {
  questionId: string;
  stem: string;
  currentLabel: number;
  suggestedLabel: number;
  observedB: number;
  expectedB: number;
  delta: number;
  calibrationN: number;
  reviewTaskId: string | null;
}

export interface DivergenceCheckResultDto {
  scannedCount: number;
  divergingCount: number;
  tasksOpened: number;
  divergences: DivergenceItemDto[];
}

export interface PurgeEventsResultDto {
  purgedCount: number;
  cutoffDate: string;
  tenantId: string;
}
