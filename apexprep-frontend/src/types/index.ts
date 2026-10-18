/**
 * What the UI renders.
 *
 * These are the shapes the pages consume; `src/types/api.ts` holds the backend's shapes, and
 * `src/lib/api.ts` maps one onto the other. Keeping them separate means a page never has to know how the
 * server names a field, and the mapping is in one readable place.
 *
 * Three rules run through this file, all of them consequences of what the backend will and will not say:
 *
 * 1. **`null` means "not known yet", and the UI renders `—`.** It never means zero. A learner who has
 *    answered nothing has no accuracy, and `0%` would be a claim about them rather than about the data.
 * 2. **Mastery is a level, never a percentage.** The requirements define mastery as θ mapped to the L1–L5
 *    band, so `level: number | null` is what exists. Bars are drawn from it as a visual encoding
 *    (`levelToBar`), which is not the same thing as computing a mastery score in the browser.
 * 3. **No answer key lives in the browser.** A `Question` has no correct answer, because the server does
 *    not send one until an attempt has been submitted. Grading is the server's, always.
 */

export type Difficulty = 1 | 2 | 3 | 4 | 5

/** A UUID. Was a closed union of exam slugs; Phase 8 tracks are any learning context, so it widens. */
export type TrackId = string

export type Role = 'student' | 'admin'

/** The seven types the backend can serve. The approved UI renders the first five. */
export type QuestionKind = 'single_correct' | 'multi_correct' | 'integer' | 'numeric' | 'matrix_match' | 'assertion_reason' | 'long_form'

export interface Track {
  id: TrackId
  slug: string
  name: string
  /** Falls back to `name` when the track has no short name. */
  shortName: string
  description: string | null
  examYear: number | null
  /** The Phase 8 learning context. Null means "not stated" — never assume an exam. */
  kind: 'school' | 'competitive_exam' | 'olympiad' | 'other' | null
  gradeLabel: string | null
  examFamily: string | null
  curriculum: string | null
  subjectIds: string[]
}

export interface Subject {
  id: string
  trackId: TrackId
  name: string
  /** `colorHex` from the backend, or a neutral when the subject has none. */
  color: string
  questionCount: number
  chapterIds: string[]
  /** The learner's own standing, from their attempts. Null until they have practised here. */
  level: number | null
  accuracy: number | null
  questionsSolved: number
  strongest: string | null
  needsReview: string | null
}

export interface Chapter {
  id: string
  subjectId: string
  name: string
  weightage: number | null
  questionCount: number
  topicIds: string[]
}

export interface Topic {
  id: string
  chapterId: string
  name: string
  questionCount: number
  subTopics: SubTopic[]
}

export interface SubTopic {
  id: string
  topicId: string
  name: string
  questionCount: number
  /** Whether published theory exists, so the UI can offer the Theory button honestly. */
  hasTheory: boolean
  /** The engine's L1–L5 band for this learner here. Null before they have practised it. */
  level: number | null
  accuracy: number | null
  lastPracticedDays: number | null
}

export type TheoryBlockKind = 'heading' | 'paragraph' | 'formula' | 'callout' | 'list' | 'table' | 'figure' | 'example'

export interface TheoryBlock {
  type: TheoryBlockKind
  title: string | null
  body: string | null
  items?: string[]
  table?: { columns: string[]; rows: string[][] }
}

export interface Theory {
  subTopicId: string
  title: string
  readMinutes: number
  blocks: TheoryBlock[]
}

/** Option keys are whatever the backend sends — 'A'…'D' today, but not constrained to them. */
export interface Option {
  key: string
  text: string
}

/**
 * A question as the learner may see it.
 *
 * No `correctKey`, no `correctValue`, no `explanation`, no hint text — none of those reach the browser.
 * `index` is the served position within the session, not a property of the question.
 */
export interface Question {
  id: string
  version: number
  subTopicId: string
  index: number
  type: QuestionKind
  difficulty: Difficulty
  stem: string
  options: Option[]
  matrix?: { left: Option[]; right: Option[] }
  /** The observed median time other learners take, which is what the backend calibrates. */
  expectedTimeSec: number
  hintCount: number
}

/** The server's verdict on one attempt, stored so the UI can render the result it was given. */
export interface AttemptOutcome {
  attemptId: string
  correct: boolean | null
  outcome: 'correct' | 'incorrect' | 'partial' | 'ungraded'
  /** The answer key, which the server discloses only in its response to an attempt. */
  revealedAnswer: Record<string, unknown>
  explanationAvailable: boolean
  probableGuess: boolean
  levelChange: 'promoted' | 'demoted' | 'unchanged'
}

export interface AttemptState {
  questionId: string
  selectedKeys: string[]
  value?: string
  text?: string
  matrix?: Record<string, string[]>
  revealedHints?: string[]
  flagged: boolean
  visited: boolean
  timeSpentSec: number
  submitted: boolean
  /** Set from the server's response, never computed here. */
  outcome?: AttemptOutcome
}

/** The learner's own progress, exactly as the engine reports it. */
export interface Progress {
  theta: number
  level: number
  attemptsCount: number
  gradedCount: number
  correctCount: number
  placementStatus: 'not_started' | 'in_progress' | 'completed' | 'skipped'
}

export interface Explanation {
  id: string
  source: 'official_solution' | 'notes_only' | 'mostly_notes' | 'general_knowledge'
  /** The product's own wording, shown verbatim when present. */
  notice: string | null
  summary: string
  steps: string[]
  keyConcept: string | null
  commonMistake: string | null
  underReview: boolean
}

/** Why an explanation could not be shown. Each maps to a real backend response, never to fake content. */
export type ExplanationUnavailable =
  | { reason: 'attempt_required' }
  | { reason: 'ai_not_configured' }
  | { reason: 'under_review'; message: string }
  | { reason: 'error'; message: string }

export interface Student {
  id: string
  name: string
  email: string
  avatarInitial: string
  role: Role
  onboarded: boolean
  primaryTrackId: string | null
  goal: string | null
  targetRank: number | null
  dailyGoal: number | null
  /** From the learner's own target exam date. Null when they have not set one. */
  daysToExam: number | null
  streakDays: number
  solvedToday: number
  todayAccuracy: number | null
  studyMinutesToday: number
  questionsSolvedTotal: number
}

export interface LearnerTrack {
  trackId: string
  isPrimary: boolean
  status: 'active' | 'left'
  goalText: string | null
  track: Track
}

export interface LevelAccuracy {
  tier: Difficulty
  label: string
  attempted: number
  accuracy: number | null
}

export interface TrendPoint {
  label: string
  questions: number
  accuracy: number | null
}

export interface TopicPerformance {
  subTopicId: string
  name: string
  topic: string
  subject: string
  accuracy: number | null
  questions: number
  paceSeconds: number | null
  level: number | null
  lastPracticedDays: number | null
}

export interface Analytics {
  range: string
  overallAccuracy: number | null
  accuracyDelta: number | null
  questionsSolved: number
  paceSeconds: number | null
  /** §10 coverage: published sub-topics with at least 10 attempts. Replaces "chapters completed". */
  coveragePct: number | null
  tierAccuracy: LevelAccuracy[]
  trend: TrendPoint[]
  weakTopics: TopicPerformance[]
  strongTopics: TopicPerformance[]
  /** Every sub-topic attempted in the period, unranked — what the Reports table lists. */
  subtopicPerformance: TopicPerformance[]
  subjectSummary: Subject[]
}

export interface Recommendation {
  id: string
  kind: 'continue' | 'practice' | 'focus'
  eyebrow: string
  subjectLabel: string
  title: string
  detail: string
  level: number | null
  accuracy: number | null
  questionCount: number
  href: string
}

