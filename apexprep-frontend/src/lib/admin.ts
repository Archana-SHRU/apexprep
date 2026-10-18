import { http } from './http'
import type {
  AdminQuestionDto,
  AdminQuestionPageDto,
  AdminStatsDto,
  UserDto,
  UserPageDto,
} from '@/types/api'

export interface ListQuestionsParams {
  page?: number
  pageSize?: number
  status?: string
  type?: string
  /** L1–L5. The backend's name for it is `difficultyLabel`. */
  difficultyLabel?: number
  trackId?: string
  subjectId?: string
  search?: string
}

export interface ListStudentsParams {
  search?: string
  cursor?: string
  limit?: number
}

/**
 * Administrative API client for ApexPrep console.
 * Connects directly to backend `/v1/admin/*` endpoints guarded with admin roles and permissions.
 */
export const adminApi = {
  // ------------------------------------------------ Question Bank
  getQuestions: (params?: ListQuestionsParams) =>
    http.get<AdminQuestionPageDto>('/v1/admin/questions', params as Record<string, string | number | undefined>),

  getQuestion: (id: string) =>
    http.get<AdminQuestionDto>(`/v1/admin/questions/${id}`),

  publishQuestion: (id: string) =>
    http.post<AdminQuestionDto>(`/v1/admin/questions/${id}/publish`, {}),

  retireQuestion: (id: string) =>
    http.post<AdminQuestionDto>(`/v1/admin/questions/${id}/retire`, {}),

  deleteQuestion: (id: string) =>
    http.del<void>(`/v1/admin/questions/${id}`),

  // ------------------------------------------------ Student Management
  getStudents: (params?: ListStudentsParams) =>
    http.get<UserPageDto>('/v1/admin/students', params as Record<string, string | number | undefined>),

  getStudent: (id: string) =>
    http.get<UserDto>(`/v1/admin/students/${id}`),

  changeStudentStatus: (id: string, status: 'active' | 'disabled') =>
    http.patch<UserDto>(`/v1/admin/users/${id}/status`, { status }),

  // ------------------------------------------------ Platform Stats
  getStats: () =>
    http.get<AdminStatsDto>('/v1/admin/stats'),
}
