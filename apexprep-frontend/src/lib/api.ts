/**
 * The seam between the UI and the backend — now real.
 *
 * Every screen still reads data through these functions only, and the signatures are the ones the pages
 * already call. What changed is inside: each body performs an HTTP request through `src/lib/http.ts` and
 * maps the backend's DTO (`src/types/api.ts`) onto the shape the UI renders (`src/types/index.ts`).
 *
 * Three things this layer deliberately does **not** do:
 *
 * * **It does not invent data.** Where the backend has no figure, the mapped value is `null` and the screen
 *   renders `—`. There is no fallback to sample content when a request fails: the error propagates so the
 *   page can say what went wrong.
 * * **It does not compute mastery.** `level` is the adaptive engine's L1–L5 band, read from the API. Nothing
 *   here derives a percentage from it; `levelToBar` in `src/lib/format.ts` turns a level into a bar width,
 *   which is a drawing decision, not a score.
 * * **It does not grade.** Practice lives in `src/hooks/usePracticeSession.ts` and submits every answer to
 *   the server. No answer key passes through this file.
 *
 * The learner's own performance arrives from one place — `GET /v1/me/analytics?range=all` — and is cached for
 * the length of a page's visit (`PERFORMANCE_TTL_MS`) so that opening Learn → Subject → Chapter does not
 * re-request it three times. `invalidatePerformance()` clears it after a practice session, which is the only
 * thing in the app that changes those numbers.
 */
import { http } from './http'
import type {
  Analytics, Chapter, Explanation, LearnerTrack, Question, Recommendation,
  Student, Subject, SubTopic, Theory, Topic, Track, TrackId, TopicPerformance,
} from '@/types'
import type {
  AdminStatsDto,
  AnalyticsSubjectSummaryDto, ChapterDetailDto, ChapterNodeDto, ExplanationDto, LearnerAnalyticsDto,
  LearnerSummaryDto, LearnerTrackDto, RecommendationDto, RecommendationsDto, StudentQuestionDto,
  SubjectDetailDto, SubjectNodeDto, SubtopicDetailDto, SubtopicNodeDto, SubtopicPerformanceDto, TheoryDto, TopicDetailDto,
  TopicNodeDto, TrackDto, TrackListDto, TrackSummaryDto, TrackTreeDto, UserDto, UserPageDto,
  MockTestSummaryDto, MockTestDetailDto, TestSessionStateDto, SubmitTestAnswerDto, SessionClockDto, TestResultDto, TestKind,
  BenchmarkDto, AskQuestionResponseDto, DoubtIntent, DivergenceCheckResultDto, PurgeEventsResultDto,
} from '@/types/api'

/** One searchable place in the syllabus. */
export interface SyllabusIndexEntry {
  label: string
  /** Where it sits, shown under the label so two same-named sub-topics are distinguishable. */
  context: string
  to: string
}

/** A sub-topic plus the names of its ancestors, which is what a page addressed only by sub-topic id needs. */
export interface SubTopicContext extends SubTopic {
  topicName: string | null
  chapterId: string | null
  chapterName: string | null
  subjectId: string | null
  subjectName: string | null
}

/** A sub-topic that has questions to practise, with where it sits. */
export interface PractisableSubtopic extends SubTopic {
  topicName: string
  chapterId: string
  chapterName: string
  subjectId: string
  subjectName: string
}

/** Subjects carry a colour in the database, but it is nullable; this is the fallback, not a fake value. */
const NEUTRAL = '#64748b'

const LEVEL_LABELS = ['Very easy', 'Easy', 'Moderate', 'Hard', 'Very hard'] as const

// ---------------------------------------------------------------- mappers

function mapTrack(t: TrackDto, subjectIds: string[] = []): Track {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    // A track without a short name shows its full name rather than an abbreviation invented here.
    shortName: t.shortName ?? t.name,
    description: t.description,
    examYear: t.examYear,
    kind: t.kind,
    gradeLabel: t.gradeLabel,
    examFamily: t.examFamily,
    curriculum: t.curriculum,
    subjectIds,
  }
}

function mapSubjectNode(s: SubjectNodeDto, perf: PerformanceIndex): Subject {
  const summary = perf.subjects.get(s.id)
  return {
    id: s.id,
    trackId: s.trackId,
    name: s.name,
    color: s.colorHex ?? NEUTRAL,
    questionCount: s.questionCount,
    chapterIds: s.chapters.map((c) => c.id),
    level: summary?.level ?? null,
    accuracy: summary?.accuracy ?? null,
    questionsSolved: summary?.questions ?? 0,
    strongest: summary?.strongest ?? null,
    needsReview: summary?.needsReview ?? null,
  }
}

function mapChapterNode(c: ChapterNodeDto): Chapter {
  return {
    id: c.id,
    subjectId: c.subjectId,
    name: c.name,
    weightage: c.weightagePct,
    questionCount: c.questionCount,
    topicIds: c.topics.map((t) => t.id),
  }
}

function mapTopicNode(t: TopicNodeDto, perf: PerformanceIndex): Topic {
  return {
    id: t.id,
    chapterId: t.chapterId,
    name: t.name,
    questionCount: t.questionCount,
    subTopics: t.subtopics.map((s) => mapSubtopicNode(s, perf)),
  }
}

function mapSubtopicNode(s: SubtopicNodeDto, perf: PerformanceIndex): SubTopic {
  const mine = perf.subtopics.get(s.id)
  return {
    id: s.id,
    topicId: s.topicId,
    name: s.name,
    questionCount: s.questionCount,
    hasTheory: s.hasTheory,
    // From the learner's own attempts. `undefined` (never practised) becomes null, which renders as "—".
    level: mine?.level ?? null,
    accuracy: mine?.accuracy ?? null,
    lastPracticedDays: mine?.lastPracticedDays ?? null,
  }
}

function mapTheory(t: TheoryDto): Theory {
  return {
    subTopicId: t.subtopicId,
    title: t.title,
    readMinutes: t.readMinutes,
    blocks: t.blocks.map((b) => ({ type: b.type, title: b.title, body: b.body, items: b.items, table: b.table })),
  }
}

/** Index in the served order; the caller supplies the position because it belongs to the session, not the question. */
export function mapQuestion(q: StudentQuestionDto, index: number): Question {
  return {
    id: q.id,
    version: q.version,
    subTopicId: q.subtopicId,
    index,
    type: q.type,
    // The backend guarantees 1–5; the cast documents that rather than widening the UI type.
    difficulty: Math.min(5, Math.max(1, q.difficultyLabel)) as Question['difficulty'],
    stem: q.stem,
    options: q.options,
    matrix: q.matrix,
    expectedTimeSec: q.expectedTimeSeconds,
    hintCount: q.hintCount,
  }
}

export function mapExplanation(e: ExplanationDto): Explanation {
  return {
    id: e.id,
    source: e.source,
    notice: e.notice,
    summary: e.summary,
    steps: e.steps,
    keyConcept: e.keyConcept,
    commonMistake: e.commonMistake,
    underReview: e.underReview,
  }
}

function mapPerformance(p: SubtopicPerformanceDto): TopicPerformance {
  return {
    subTopicId: p.subtopicId,
    name: p.subtopicName,
    topic: p.topicName,
    subject: p.subjectName,
    accuracy: p.accuracy,
    questions: p.questions,
    paceSeconds: p.paceSeconds,
    level: p.level,
    lastPracticedDays: p.lastPracticedDays,
  }
}

function mapAnalyticsSubject(s: AnalyticsSubjectSummaryDto): Subject {
  return {
    id: s.subjectId,
    trackId: '',
    name: s.name,
    color: s.colorHex ?? NEUTRAL,
    questionCount: 0,
    chapterIds: [],
    level: s.level,
    accuracy: s.accuracy,
    questionsSolved: s.questions,
    strongest: s.strongest,
    needsReview: s.needsReview,
  }
}

function mapAnalytics(a: LearnerAnalyticsDto): Analytics {
  return {
    range: a.range,
    overallAccuracy: a.overallAccuracy,
    accuracyDelta: a.accuracyDelta,
    questionsSolved: a.questionsSolved,
    paceSeconds: a.paceSeconds,
    coveragePct: a.coveragePct,
    tierAccuracy: a.levelAccuracy.map((l) => ({
      tier: l.level as 1 | 2 | 3 | 4 | 5,
      label: LEVEL_LABELS[l.level - 1] ?? `L${l.level}`,
      attempted: l.attempted,
      accuracy: l.accuracy,
    })),
    // `weekStart` is an ISO date; the chart axis wants something short, and this is a formatting choice.
    trend: a.trend.map((t) => ({
      label: new Date(`${t.weekStart}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      questions: t.questions,
      accuracy: t.accuracy,
    })),
    weakTopics: a.weakSubtopics.map(mapPerformance),
    strongTopics: a.strongSubtopics.map(mapPerformance),
    subtopicPerformance: a.subtopicPerformance.map(mapPerformance),
    subjectSummary: a.subjectSummary.map(mapAnalyticsSubject),
  }
}

function mapRecommendation(r: RecommendationDto): Recommendation {
  const eyebrow = r.kind === 'continue' ? 'Continue' : r.kind === 'practice' ? 'Practise' : 'Revisit'
  return {
    id: r.subtopicId,
    kind: r.kind,
    eyebrow,
    subjectLabel: r.subjectName,
    title: r.subtopicName,
    // The backend's own sentence, shown as written. Nothing is composed here.
    detail: r.reason,
    level: r.level,
    accuracy: r.accuracy,
    questionCount: r.questionCount,
    href: `/practice/${r.subtopicId}`,
  }
}

function mapStudent(user: UserDto, summary: LearnerSummaryDto): Student {
  const name = user.displayName.trim()
  return {
    id: user.id,
    name,
    email: user.email,
    avatarInitial: (name.charAt(0) || user.email.charAt(0) || '?').toUpperCase(),
    role: user.role === 'STUDENT' ? 'student' : 'admin',
    onboarded: user.onboarded,
    primaryTrackId: user.primaryTrackId,
    goal: user.goal,
    targetRank: user.targetRank,
    dailyGoal: summary.dailyQuestionGoal,
    daysToExam: summary.daysToTargetExam,
    streakDays: summary.streakDays,
    solvedToday: summary.solvedToday,
    todayAccuracy: summary.todayAccuracy,
    studyMinutesToday: summary.studyMinutesToday,
    questionsSolvedTotal: summary.questionsSolvedTotal,
  }
}

function mapLearnerTrack(t: LearnerTrackDto): LearnerTrack {
  return { trackId: t.trackId, isPrimary: t.isPrimary, status: t.status, goalText: t.goalText, track: mapTrack(t.track) }
}

// ---------------------------------------------------------------- the learner's performance overlay

interface PerformanceIndex {
  subtopics: Map<string, SubtopicPerformanceDto>
  subjects: Map<string, AnalyticsSubjectSummaryDto>
}

const EMPTY_INDEX: PerformanceIndex = { subtopics: new Map(), subjects: new Map() }

/**
 * Short enough that a learner who practises and navigates back sees fresh figures, long enough that one
 * page's cascade of syllabus requests does not re-fetch the same analytics.
 */
const PERFORMANCE_TTL_MS = 30_000

let performanceCache: { at: number; value: PerformanceIndex } | null = null
let performanceInFlight: Promise<PerformanceIndex> | null = null

/** Called when a practice session ends, since that is what changes these numbers. */
export function invalidatePerformance(): void {
  performanceCache = null
}

/**
 * The learner's own standing on every sub-topic they have attempted, keyed for lookup.
 *
 * A failure here must not take a syllabus page down with it: the syllabus is the page's subject, and the
 * learner's levels are an annotation on it. So a failed analytics request degrades to an empty index, and
 * every level renders as "—" — which is the honest reading of "we could not load your progress". It is not a
 * fallback to invented data; nothing is filled in.
 */
async function performanceIndex(): Promise<PerformanceIndex> {
  if (performanceCache && Date.now() - performanceCache.at < PERFORMANCE_TTL_MS) return performanceCache.value
  performanceInFlight ??= (async () => {
    try {
      const dto = await http.get<LearnerAnalyticsDto>('/v1/me/analytics', { range: 'all' })
      const value: PerformanceIndex = {
        subtopics: new Map(dto.subtopicPerformance.map((p) => [p.subtopicId, p])),
        subjects: new Map(dto.subjectSummary.map((s) => [s.subjectId, s])),
      }
      performanceCache = { at: Date.now(), value }
      return value
    } catch {
      return EMPTY_INDEX
    } finally {
      performanceInFlight = null
    }
  })()
  return performanceInFlight
}

// ---------------------------------------------------------------- the track tree

/**
 * `GET /v1/tracks/:id/tree` is one request for a whole track, which is what the Learn pages need. It is
 * cached per track for the same reason the performance index is: three navigations should not re-fetch a
 * syllabus that changes when an admin publishes something, not while a learner reads it.
 */
const treeCache = new Map<string, { at: number; value: TrackTreeDto }>()
const TREE_TTL_MS = 5 * 60_000

async function tree(trackId: TrackId): Promise<TrackTreeDto> {
  const hit = treeCache.get(trackId)
  if (hit && Date.now() - hit.at < TREE_TTL_MS) return hit.value
  const value = await http.get<TrackTreeDto>(`/v1/tracks/${trackId}/tree`)
  treeCache.set(trackId, { at: Date.now(), value })
  return value
}

// ---------------------------------------------------------------- the API

export const api = {
  // -------------------------------------------------------------- syllabus

  async getTracks(): Promise<Track[]> {
    const { items } = await http.get<TrackListDto>('/v1/tracks')
    return items.map((t: TrackSummaryDto) => mapTrack(t, t.subjects.map((s) => s.id)))
  },

  async getTrack(id: TrackId): Promise<Track | undefined> {
    const { items } = await http.get<TrackListDto>('/v1/tracks')
    const found = items.find((t) => t.id === id || t.slug === id)
    return found ? mapTrack(found, found.subjects.map((s) => s.id)) : undefined
  },

  /**
   * The subjects of one track, annotated with the learner's own level and accuracy.
   *
   * `trackId` is required now: "all subjects everywhere" was a property of a fixed mock dataset and is not
   * something the API offers, nor something a learner screen wants.
   */
  async getSubjects(trackId?: TrackId): Promise<Subject[]> {
    if (!trackId) return []
    const [t, perf] = await Promise.all([tree(trackId), performanceIndex()])
    return t.subjects.map((s) => mapSubjectNode(s, perf))
  },

  async getSubject(id: string): Promise<Subject | undefined> {
    const [detail, perf] = await Promise.all([http.get<SubjectDetailDto>(`/v1/subjects/${id}`), performanceIndex()])
    return mapSubjectNode(detail.subject, perf)
  },

  async getChapters(subjectId: string): Promise<Chapter[]> {
    const detail = await http.get<SubjectDetailDto>(`/v1/subjects/${subjectId}`)
    return detail.subject.chapters.map(mapChapterNode)
  },

  async getChapter(id: string): Promise<Chapter | undefined> {
    const detail = await http.get<ChapterDetailDto>(`/v1/chapters/${id}`)
    return mapChapterNode(detail.chapter)
  },

  async getTopics(chapterId: string): Promise<Topic[]> {
    const [detail, perf] = await Promise.all([http.get<ChapterDetailDto>(`/v1/chapters/${chapterId}`), performanceIndex()])
    return detail.chapter.topics.map((t) => mapTopicNode(t, perf))
  },

  async getTopic(id: string): Promise<Topic | undefined> {
    const [detail, perf] = await Promise.all([http.get<TopicDetailDto>(`/v1/topics/${id}`), performanceIndex()])
    return mapTopicNode(detail.topic, perf)
  },

  /**
   * Every sub-topic in a track that has published questions, with the learner's level on each.
   *
   * What the Practice hub lists. Derived from the same cached tree plus the analytics overlay, so a sub-topic's
   * level is the engine's and its question count is the published count — no new endpoint, and nothing computed.
   */
  async getPractisableSubtopics(trackId: TrackId): Promise<PractisableSubtopic[]> {
    const [t, perf] = await Promise.all([tree(trackId), performanceIndex()])
    const out: PractisableSubtopic[] = []
    for (const subject of t.subjects) {
      for (const chapter of subject.chapters) {
        for (const topic of chapter.topics) {
          for (const sub of topic.subtopics) {
            if (sub.questionCount === 0) continue
            out.push({
              ...mapSubtopicNode(sub, perf),
              topicName: topic.name,
              chapterId: chapter.id,
              chapterName: chapter.name,
              subjectId: subject.id,
              subjectName: subject.name,
            })
          }
        }
      }
    }
    return out
  },

  /**
   * A flat, searchable index of one track's published syllabus.
   *
   * Built from the same cached tree the Learn pages use, so the header search matches what the learner can
   * actually open — real sub-topic ids, real theory links — rather than a fixed list of suggestions. There is no
   * search endpoint in the backend, and this needs none: the tree is one request and the filtering is local.
   */
  async getSyllabusIndex(trackId: TrackId): Promise<SyllabusIndexEntry[]> {
    const t = await tree(trackId)
    const entries: SyllabusIndexEntry[] = []
    for (const subject of t.subjects) {
      entries.push({ label: subject.name, context: 'Subject', to: `/learn/${subject.id}` })
      for (const chapter of subject.chapters) {
        entries.push({ label: chapter.name, context: subject.name, to: `/learn/${subject.id}/${chapter.id}` })
        for (const topic of chapter.topics) {
          for (const sub of topic.subtopics) {
            if (sub.questionCount > 0) {
              entries.push({ label: sub.name, context: `${topic.name} · Practice`, to: `/practice/${sub.id}` })
            }
            if (sub.hasTheory) {
              entries.push({ label: sub.name, context: `${topic.name} · Theory`, to: `/theory/${sub.id}` })
            }
          }
        }
      }
    }
    return entries
  },

  /**
   * One sub-topic with the names above it, for breadcrumbs and headings.
   *
   * `GET /v1/subtopics/:id` returns the node plus its ancestors, so a page that only has a sub-topic id in its
   * URL — Practice, Theory — can title itself without walking the whole tree.
   */
  async getSubtopicContext(id: string): Promise<SubTopicContext> {
    const [detail, perf] = await Promise.all([http.get<SubtopicDetailDto>(`/v1/subtopics/${id}`), performanceIndex()])
    const crumb = (level: string) => detail.breadcrumbs.find((b) => b.level === level)
    return {
      ...mapSubtopicNode(detail.subtopic, perf),
      topicName: crumb('topic')?.name ?? null,
      chapterId: crumb('chapter')?.id ?? null,
      chapterName: crumb('chapter')?.name ?? null,
      subjectId: crumb('subject')?.id ?? null,
      subjectName: crumb('subject')?.name ?? null,
    }
  },

  /**
   * Theory is addressed by sub-topic, which is how the backend stores it.
   *
   * The mock had a separate `theoryId`; there is no such thing. Returns `undefined` when nothing is
   * published, which the page renders as an empty state rather than as a missing page.
   */
  async getTheoryBySubTopic(subTopicId: string): Promise<Theory | undefined> {
    const dto = await http.get<TheoryDto>(`/v1/subtopics/${subTopicId}/theory`)
    return dto.blocks.length === 0 ? undefined : mapTheory(dto)
  },

  // -------------------------------------------------------------- the learner

  /** The signed-in learner plus today's figures: `/v1/auth/me` for identity, `/v1/me/summary` for counts. */
  async getStudent(): Promise<Student> {
    const [user, summary] = await Promise.all([
      http.get<UserDto>('/v1/auth/me'),
      http.get<LearnerSummaryDto>('/v1/me/summary'),
    ])
    return mapStudent(user, summary)
  },

  /** Returns a bare array, not an `{ items }` envelope — unlike `/v1/tracks`, which does wrap. */
  async getLearnerTracks(): Promise<LearnerTrack[]> {
    const rows = await http.get<LearnerTrackDto[]>('/v1/me/tracks')
    return rows.map(mapLearnerTrack)
  },

  async getRecommendations(): Promise<Recommendation[]> {
    const { items } = await http.get<RecommendationsDto>('/v1/me/recommendations')
    return items.map(mapRecommendation)
  },

  async getAnalytics(range?: string, subjectId?: string): Promise<Analytics> {
    const dto = await http.get<LearnerAnalyticsDto>('/v1/me/analytics', { range, subjectId })
    return mapAnalytics(dto)
  },

  // -------------------------------------------------------------- mock tests
  getMockTests: (kind?: TestKind): Promise<MockTestSummaryDto[]> =>
    http.get<MockTestSummaryDto[]>('/v1/tests', kind ? { kind } : undefined),

  getMockTest: (testId: string): Promise<MockTestDetailDto> =>
    http.get<MockTestDetailDto>(`/v1/tests/${testId}`),

  startMockTest: (testId: string): Promise<TestSessionStateDto> =>
    http.post<TestSessionStateDto>(`/v1/tests/${testId}/start`),

  getMockTestSession: (sessionId: string): Promise<TestSessionStateDto> =>
    http.get<TestSessionStateDto>(`/v1/tests/sessions/${sessionId}`),

  saveMockTestAnswer: (sessionId: string, payload: SubmitTestAnswerDto): Promise<SessionClockDto> =>
    http.post<SessionClockDto>(`/v1/tests/sessions/${sessionId}/answer`, payload),

  /**
   * Tells the server which question is open now (or `null` when none is). The server measures the time spent on
   * each question from these calls; the browser never reports a duration.
   */
  focusMockTestItem: (sessionId: string, testItemId: string | null): Promise<SessionClockDto> =>
    http.post<SessionClockDto>(`/v1/tests/sessions/${sessionId}/focus`, { testItemId }),

  submitMockTest: (sessionId: string): Promise<TestResultDto> =>
    http.post<TestResultDto>(`/v1/tests/sessions/${sessionId}/submit`),

  getMockTestResult: (sessionId: string): Promise<TestResultDto> =>
    http.get<TestResultDto>(`/v1/tests/sessions/${sessionId}/result`),

  // -------------------------------------------------------------- peer benchmarks & pedagogical features
  /** A benchmark is per sub-topic: the backend refuses the request without one. */
  getBenchmark: (subtopicId: string): Promise<BenchmarkDto> =>
    http.get<BenchmarkDto>('/v1/me/benchmark', { subtopicId }),

  askQuestion: (questionId: string, message: string, intent?: DoubtIntent): Promise<AskQuestionResponseDto> =>
    http.post<AskQuestionResponseDto>(`/v1/questions/${questionId}/ask`, { message, intent }),

  // -------------------------------------------------------------- divergence & retention
  /** `threshold` is in Elo points (the backend default is 250); `minCalibrations` is the attempts needed first. */
  checkDivergence: (threshold?: number, minCalibrations?: number): Promise<DivergenceCheckResultDto> =>
    http.post<DivergenceCheckResultDto>('/v1/admin/questions/check-divergence', { threshold, minCalibrations }),

  /** Removes raw session events older than `olderThanDays` (30–1825, default 365). Aggregates are untouched. */
  purgeEvents: (olderThanDays?: number): Promise<PurgeEventsResultDto> =>
    http.post<PurgeEventsResultDto>('/v1/admin/maintenance/purge-events', { olderThanDays }),
}
