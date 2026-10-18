import { http } from '@/lib/http'

/**
 * The admin content pipeline: the syllabus a track's content is filed under, PDF upload, ingestion jobs
 * and block review. Types mirror the backend's syllabus and ingestion DTOs. Content itself only ever
 * comes from what an admin uploads and publishes — nothing here creates learning material.
 */

export type NodeStatus = 'draft' | 'published' | 'archived'
export type NodeLevel = 'subject' | 'chapter' | 'topic' | 'subtopic'

export interface AdminTrack {
  id: string
  slug: string
  name: string
  kind: 'school' | 'competitive_exam' | 'olympiad' | 'other' | null
  gradeLabel: string | null
  examFamily: string | null
  status: NodeStatus
  subjects: { id: string; slug: string; name: string }[]
}

interface NodeBase { id: string; slug: string; name: string; status: NodeStatus; sortOrder: number }
export interface SubtopicNode extends NodeBase { topicId: string; questionCount: number; hasTheory: boolean }
export interface TopicNode extends NodeBase { chapterId: string; subtopics: SubtopicNode[] }
export interface ChapterNode extends NodeBase { subjectId: string; topics: TopicNode[] }
export interface SubjectNode extends NodeBase { trackId: string; chapters: ChapterNode[] }
export interface TrackTree { track: AdminTrack; subjects: SubjectNode[] }

export type JobStatus =
  | 'queued' | 'extracting' | 'ocr' | 'segmenting' | 'classifying' | 'tagging' | 'normalizing' | 'matching'
  | 'deduplicating' | 'awaiting_review' | 'publishing' | 'published' | 'failed' | 'cancelled'

export interface IngestionJob {
  id: string
  assetId: string
  status: JobStatus
  progressPct: number
  attemptCount: number
  pagesTotal: number
  pagesOcr: number
  blocks: Record<string, number>
  errorCode: string | null
  errorMessage: string | null
  openReviewTasks: number
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  /** What syllabus-hierarchy detection concluded for the upload; null before processing. */
  hierarchy: HierarchySummary | null
}

export interface HierarchySummary {
  /** `needs_review`: the PDF does not state its chapter/topic/sub-topic structure, so nothing was proposed. */
  status: 'detected' | 'needs_review' | 'not_applicable'
  method: 'numbered' | 'keyword' | 'title' | 'ai' | 'none'
  headings?: number
  paths?: number
  blocksFiledToExisting?: number
  blocksAwaitingApproval?: number
  notes?: string[]
  autoPublished?: number
  needsReview?: number
  failed?: number
  topicsDetected?: number
  subtopicsDetected?: number
  theoryBlocks?: number
  questions?: number
}

export interface SuggestionLevel {
  name: string | null
  state: 'existing' | 'new' | 'unresolved'
  existingId: string | null
  existingName: string | null
  existingStatus: NodeStatus | null
  createdId: string | null
  evidence: { heading?: string; page?: number; number?: string | null; confidence?: number; method?: string } | null
}

export interface SyllabusSuggestion {
  id: string
  jobId: string
  status: 'pending' | 'approved' | 'rejected'
  trackId: string
  trackName: string
  subjectId: string
  subjectName: string
  chapter: SuggestionLevel
  topic: SuggestionLevel
  subtopic: SuggestionLevel
  confidence: number
  mappingReason: string
  evidence: { method?: string | null; notes?: string[] }
  linkedBlocks: number
  needsNames: boolean
  reviewedBy: string | null
  reviewedAt: string | null
  rejectionReason: string | null
  createdAt: string
}

export interface SuggestionList { hierarchy: HierarchySummary | null; suggestions: SyllabusSuggestion[] }
export type SuggestionNames = { chapterName?: string; topicName?: string; subtopicName?: string }

export type Readiness = 'ready' | 'flagged' | 'blocked' | 'done' | 'excluded'

export interface Provenance {
  origin: 'extracted' | 'ai_assisted' | 'ai_generated'
  ai: { task: string; provider: string; model: string; at: string; textDecision?: string } | null
  inferred: string[]
  edited: boolean
  classifiedBy: string | null
}

export type QuestionKind = 'single_correct' | 'multi_correct' | 'integer' | 'numeric' | 'assertion_reason'
export type ValueSource = 'source' | 'solution' | 'ai_unverified' | 'reviewer' | null

export interface ReviewedQuestion {
  type: QuestionKind
  stem: string
  options: { key: string; text: string; isCorrect: boolean }[]
  numericAnswer: { value: number; tolerance?: number; mode?: string } | null
  difficultyLabel: number | null
  expectedTimeSeconds: number | null
  confidence: number
  gaps: string[]
  answerSource?: ValueSource
  difficultySource?: ValueSource
  expectedTimeSource?: ValueSource
  suggested?: { by: string; difficultyLabel: number | null; expectedTimeSeconds: number | null; note: string } | null
}

export interface RevisionNotes {
  title: string
  overview: string
  keyPoints: { text: string; sourceBlockIds: string[] }[]
  concepts: { term: string; explanation: string; sourceBlockIds: string[] }[]
  formulas: { expression: string; meaning: string; sourceBlockIds: string[] }[]
  commonMistakes: { text: string; sourceBlockIds: string[] }[]
  quickRevision: { text: string; sourceBlockIds: string[] }[]
}

export interface ReviewedDraft {
  notes: RevisionNotes
  groundingScore: number
  edited?: boolean
  activation?: { notesId?: string; skipped?: string } | null
}

export interface ReviewedBlock {
  id: string
  jobId: string | null
  kind: 'theory' | 'question' | 'solution' | 'ambiguous'
  format: string
  status: 'extracted' | 'needs_review' | 'approved' | 'rejected' | 'published' | 'superseded'
  title: string | null
  text: string
  sourcePage: number | null
  sortOrder: number
  subtopicId: string | null
  classificationConfidence: number | null
  taggingConfidence: number | null
  fromOcr: boolean
  openReviewTasks: number
  publishable: boolean
  gateFailures: { gate: string; detail: string }[]
  originalText: string
  reviewedBy: string | null
  contentReviewed: boolean
  readiness: Readiness
  readinessReasons: string[]
  provenance: Provenance
  question: ReviewedQuestion | null
  solution: { text: string; confirmed: boolean } | null
  draft: ReviewedDraft | null
  autoApprovalEligible: boolean
  mappingReason: string | null
  mappingConfidence: number | null
  suggestedChapter: string | null
  suggestedTopic: string | null
  suggestedSubtopic: string | null
  suggestionId: string | null
  existingChapterId: string | null
  existingTopicId: string | null
  existingSubtopicId: string | null
  alternatives: { subtopicId: string; score: number }[]
}

export interface PreviewSummary {
  readiness: Record<Readiness, number>
  questions: number
  theory: number
  solutionsAttached: number
  drafts: number
  suggestionsPending: number
  suggestionsNeedingNames: number
  questionsMissingValues: number
  answersToVerify: number
  wouldPublish: { ready: number; withFlagged: number }
  canApprove: boolean
  cannotApproveBecause: string | null
}

export interface JobPreview { job: IngestionJob; summary: PreviewSummary; syllabus: SuggestionList; blocks: ReviewedBlock[] }

export interface BlockOutcome {
  blockId: string
  sourcePage: number | null
  title: string | null
  outcome: 'published' | 'confirmed_and_published' | 'skipped' | 'blocked' | 'failed'
  reasons: string[]
  questionId: string | null
}

export interface ApprovalResult {
  dryRun: boolean
  suggestions: { id: string; outcome: string; detail: string | null }[]
  blocks: BlockOutcome[]
  totals: { published: number; confirmed: number; skipped: number; blocked: number; failed: number }
  complete: boolean
  embeddings: { attempted: number; embedded: number } | null
}

export interface BlockEdit {
  text?: string
  title?: string | null
  subtopicId?: string
  solutionText?: string
  question?: {
    type?: QuestionKind
    stem?: string
    difficultyLabel?: number
    expectedTimeSeconds?: number
    options?: { key: string; text: string; isCorrect: boolean }[]
    numericAnswer?: { value: number; tolerance?: number; mode?: string } | null
    confirmAnswer?: boolean
    acceptSuggested?: boolean
    diagramAcknowledged?: boolean
  }
  draft?: { notes: RevisionNotes }
}

export interface UploadResult { assetId: string; jobId: string; sha256: string; pageCount: number; byteSize: number }

/** A slug from a name: lowercase letters, digits and single hyphens, as the backend requires. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base.length > 0 ? base : `node-${Date.now().toString(36)}`
}

const CREATE_PATH: Record<NodeLevel, (parentId: string) => string> = {
  subject: (id) => `/v1/admin/tracks/${id}/subjects`,
  chapter: (id) => `/v1/admin/subjects/${id}/chapters`,
  topic: (id) => `/v1/admin/chapters/${id}/topics`,
  subtopic: (id) => `/v1/admin/topics/${id}/subtopics`,
}
const NODE_PATH: Record<NodeLevel | 'track', string> = {
  track: 'tracks',
  subject: 'subjects',
  chapter: 'chapters',
  topic: 'topics',
  subtopic: 'subtopics',
}

export const adminContent = {
  tracks: async () => (await http.get<{ items: AdminTrack[] }>('/v1/admin/tracks')).items,
  tree: (trackId: string) => http.get<TrackTree>(`/v1/admin/tracks/${trackId}/tree`),

  createNode: (level: NodeLevel, parentId: string, name: string, status: NodeStatus = 'published') =>
    http.post<NodeBase>(CREATE_PATH[level](parentId), { name: name.trim(), slug: slugify(name), status }),
  setStatus: (level: NodeLevel | 'track', id: string, status: NodeStatus) => http.patch<NodeBase>(`/v1/admin/${NODE_PATH[level]}/${id}`, { status }),

  upload: (file: File, hints: { trackId?: string; subjectId?: string }) =>
    http.postRaw<UploadResult>('/v1/admin/ingestion/assets', file, 'application/pdf', { trackId: hints.trackId, subjectId: hints.subjectId }, {
      // Only a label for the admin's own reference; the backend stores it as data and never as a path.
      // A header value must be Latin-1, so anything outside printable ASCII is replaced rather than encoded.
      'X-Filename': file.name.replace(/[^\x20-\x7E]/g, '_').slice(0, 200),
    }),
  jobs: async () => (await http.get<{ items: IngestionJob[] }>('/v1/admin/ingestion/jobs')).items,
  job: async (id: string) => (await http.get<{ job: IngestionJob }>(`/v1/admin/ingestion/jobs/${id}`)).job,
  retryJob: (id: string) => http.post<IngestionJob>(`/v1/admin/ingestion/jobs/${id}/retry`, {}),
  blocks: (jobId: string) => http.get<ReviewedBlock[]>(`/v1/admin/ingestion/jobs/${jobId}/blocks`),

  preview: (jobId: string) => http.get<JobPreview>(`/v1/admin/ingestion/jobs/${jobId}/preview`),
  applyDefaults: (jobId: string, body: { expectedTimeSecondsByType?: Record<string, number>; difficultyLabel?: number; acceptSuggested?: boolean }) =>
    http.post<{ updated: number; questions: number }>(`/v1/admin/ingestion/jobs/${jobId}/defaults`, body),
  approveDocument: (jobId: string, body: { confirmFlagged?: boolean; dryRun?: boolean }) =>
    http.post<ApprovalResult>(`/v1/admin/ingestion/jobs/${jobId}/approve`, body),
  edit: (id: string, body: BlockEdit) => http.patch<ReviewedBlock>(`/v1/admin/ingestion/blocks/${id}`, body),

  suggestions: (jobId: string) => http.get<SuggestionList>(`/v1/admin/ingestion/jobs/${jobId}/suggestions`),
  approveSuggestion: (jobId: string, id: string, names: SuggestionNames = {}) =>
    http.post<{ suggestion: SyllabusSuggestion; subtopicId: string; blocksMapped: number; created: string[] }>(
      `/v1/admin/ingestion/jobs/${jobId}/suggestions/${id}/approve`,
      names,
    ),
  rejectSuggestion: (jobId: string, id: string, reason?: string) =>
    http.post<SyllabusSuggestion>(`/v1/admin/ingestion/jobs/${jobId}/suggestions/${id}/reject`, reason ? { reason } : {}),

  approve: (id: string) => http.post<ReviewedBlock>(`/v1/admin/ingestion/blocks/${id}/approve`, {}),
  reject: (id: string) => http.post<ReviewedBlock>(`/v1/admin/ingestion/blocks/${id}/reject`, {}),
  reclassify: (id: string, kind: ReviewedBlock['kind']) => http.post<ReviewedBlock>(`/v1/admin/ingestion/blocks/${id}/reclassify`, { kind }),
  mapTo: (id: string, subtopicId: string) => http.patch<ReviewedBlock>(`/v1/admin/ingestion/blocks/${id}`, { subtopicId }),
  publish: (id: string) =>
    http.post<{ blockId: string; published: boolean; questionId: string | null; gateFailures: { gate: string; detail: string }[] }>(
      `/v1/admin/ingestion/blocks/${id}/publish`,
      {},
    ),
}
