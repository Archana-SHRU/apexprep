import { http } from '@/lib/http'

/**
 * The learning-AI endpoints: revision notes, fresh practice questions, the AI tutor and visual
 * explanations. Every type mirrors a backend DTO in `src/learning-ai/dto/learning-ai.dto.ts`; nothing here
 * composes content — each screen renders what the server validated and sent.
 */

export type NoteScopeLevel = 'track' | 'subject' | 'chapter' | 'topic' | 'subtopic'

export interface NoteItem { text: string; sourceBlockIds: string[] }

export interface RevisionNotes {
  state: 'ready' | 'outdated' | 'not_generated' | 'no_source'
  scope: { level: NoteScopeLevel; id: string; name: string; path: string }
  cached: boolean
  sourceBlockCount: number
  notes: {
    id: string
    title: string
    overview: string
    keyPoints: NoteItem[]
    concepts: { term: string; explanation: string; sourceBlockIds: string[] }[]
    formulas: { expression: string; meaning: string; sourceBlockIds: string[] }[]
    commonMistakes: NoteItem[]
    quickRevision: NoteItem[]
    sources: { blockId: string; title: string | null }[]
    generatedAt: string
  } | null
}

export type GeneratableType = 'single_correct' | 'multi_correct' | 'integer' | 'numeric' | 'assertion_reason'

export interface GeneratedQuestionsResult {
  targetLevel: number
  generated: { questionId: string; type: string; difficultyLabel: number; status: 'published' | 'in_review' }[]
  rejected: number
  message: string
}

export type TutorIntent = 'free' | 'hint' | 'why_wrong' | 'simplify' | 'explain_step' | 'another_example' | 'concept'

export interface TutorMessage {
  id: string
  role: 'student' | 'tutor'
  intent: TutorIntent
  body: string
  steps: string[]
  grounded: boolean
  createdAt: string
}

export interface TutorConversation {
  id: string
  subtopicId: string
  questionId: string | null
  answered: boolean
  messages: TutorMessage[]
}

export type VisualType = 'diagram' | 'graph' | 'step_by_step' | 'animation' | 'illustration' | 'image' | 'none'
export type SceneColor = 'ink' | 'primary' | 'accent' | 'muted' | 'success' | 'warning'
type Pt = [number, number]
interface Base { id: string; color?: SceneColor; emphasis?: boolean }

/** The scene the backend validated. The renderer draws exactly these element kinds and nothing else. */
export type SceneElement =
  | (Base & { kind: 'line'; x1: number; y1: number; x2: number; y2: number; dashed?: boolean; arrow?: 'none' | 'end' | 'both' })
  | (Base & { kind: 'rect'; x: number; y: number; w: number; h: number; fill?: boolean })
  | (Base & { kind: 'circle'; cx: number; cy: number; r: number; fill?: boolean })
  | (Base & { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill?: boolean })
  | (Base & { kind: 'polygon'; points: Pt[]; fill?: boolean })
  | (Base & { kind: 'polyline'; points: Pt[]; arrow?: 'none' | 'end'; dashed?: boolean })
  | (Base & { kind: 'arc'; cx: number; cy: number; r: number; startDeg: number; endDeg: number; arrow?: boolean })
  | (Base & { kind: 'text'; x: number; y: number; text: string; size?: 'sm' | 'md' | 'lg'; anchor?: 'start' | 'middle' | 'end' })
  | (Base & { kind: 'axes'; x: number; y: number; w: number; h: number; xMin: number; xMax: number; yMin: number; yMax: number; xLabel?: string; yLabel?: string; grid?: boolean })
  | (Base & { kind: 'plot'; axesId: string; segments: Pt[][]; dashed?: boolean; label?: string })
  | (Base & { kind: 'point'; axesId?: string; x: number; y: number; label?: string })
  | (Base & { kind: 'motion'; targetId: string; path: Pt[]; durationMs: number })

export interface Scene {
  width: number
  height: number
  elements: SceneElement[]
  steps?: { caption: string; show: string[] }[]
  loop?: boolean
}

export interface VisualExplanation {
  id: string
  questionId: string
  visualType: VisualType
  title: string
  caption: string
  concept: string
  reason: string
  scene: Scene | null
  imageUrl: string | null
  cached: boolean
}

export const learningAi = {
  readNotes: (level: NoteScopeLevel, id: string) => http.get<RevisionNotes>('/v1/revision-notes', { level, id }),
  createNotes: (level: NoteScopeLevel, id: string) => http.post<RevisionNotes>('/v1/revision-notes', { level, id }),

  generateQuestions: (subtopicId: string, count = 1, type?: GeneratableType) =>
    http.post<GeneratedQuestionsResult>('/v1/practice/generated-questions', { subtopicId, count, ...(type ? { type } : {}) }),

  startTutor: (subtopicId: string, questionId?: string) =>
    http.post<TutorConversation>('/v1/tutor/conversations', { subtopicId, ...(questionId ? { questionId } : {}) }),
  askTutor: (conversationId: string, message: string, intent: TutorIntent = 'free') =>
    http.post<{ student: TutorMessage; tutor: TutorMessage }>(`/v1/tutor/conversations/${conversationId}/messages`, { message, intent }),

  explainVisually: (questionId: string) => http.post<VisualExplanation>(`/v1/questions/${questionId}/visual`, {}),
  visualImage: (imageUrl: string) => http.getBlob(imageUrl),
}
