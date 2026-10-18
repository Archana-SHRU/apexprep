import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app-exception';
import { QuestionsRepository } from './questions.repository';
import { toStudentQuestionView, type StudentQuestionView } from './student-question.view';

/**
 * Student-facing reads of the question bank. The practice API (Phase 5) serves questions
 * through this service so that everything a student sees comes from one projection.
 */
@Injectable()
export class QuestionsService {
  constructor(private readonly repo: QuestionsRepository) {}

  /** `includeUnpublished` is for the admin preview route only; practice always passes false. */
  async studentView(tenantId: string, questionId: string, includeUnpublished = false): Promise<StudentQuestionView> {
    const found = await this.repo.studentQuestion(tenantId, questionId, !includeUnpublished);
    if (!found) throw AppException.notFound('Question not found');
    return toStudentQuestionView(found.question, found.options);
  }
}
