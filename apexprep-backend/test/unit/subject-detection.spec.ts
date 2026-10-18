import { detectSubjectFromDocument } from '../../src/ingestion/subject-detection';
import type { PageText } from '../../src/ingestion/segmentation';

describe('Subject detection from document content', () => {
  const fakeDb: any = {
    select: jest.fn(),
  };

  const fakeAi: any = {
    configured: true,
    generateJson: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses explicit subjectId hint directly when provided and valid', async () => {
    const candidate = {
      subjectId: '11111111-1111-4111-8111-111111111111',
      subjectName: 'Physics',
      trackId: '22222222-2222-4222-8222-222222222222',
      trackName: 'JEE Main',
    };

    fakeDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnValueOnce({
          where: jest.fn().mockReturnValueOnce({
            limit: jest.fn().mockResolvedValueOnce([candidate]),
          }),
        }),
      }),
    });

    const pages: PageText[] = [{ pageNumber: 1, text: 'Some physics problem' }];

    const result = await detectSubjectFromDocument({
      tenantId: '00000000-0000-4000-8000-000000000000',
      db: fakeDb,
      ai: fakeAi,
      pages,
      hints: { subjectId: candidate.subjectId },
    });

    expect(result).toEqual(candidate);
    expect(fakeAi.generateJson).not.toHaveBeenCalled();
  });

  it('detects subject via AI when subject hint is omitted', async () => {
    const candidates = [
      {
        subjectId: '11111111-1111-4111-8111-111111111111',
        subjectName: 'Physics',
        trackId: '22222222-2222-4222-8222-222222222222',
        trackName: 'JEE Main',
      },
      {
        subjectId: '33333333-3333-4333-8333-333333333333',
        subjectName: 'Chemistry',
        trackId: '22222222-2222-4222-8222-222222222222',
        trackName: 'JEE Main',
      },
    ];

    fakeDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnValueOnce({
          where: jest.fn().mockResolvedValueOnce(candidates),
        }),
      }),
    });

    fakeAi.generateJson.mockResolvedValueOnce({
      value: {
        subjectId: candidates[0]!.subjectId,
        subjectName: 'Physics',
        confidence: 0.95,
        reason: 'The document covers kinematics and forces',
      },
    });

    const pages: PageText[] = [
      { pageNumber: 1, text: 'Chapter 2: Motion in a Straight Line\nVelocity and acceleration vectors.' },
    ];

    const result = await detectSubjectFromDocument({
      tenantId: '00000000-0000-4000-8000-000000000000',
      db: fakeDb,
      ai: fakeAi,
      pages,
      hints: {},
    });

    expect(result).toEqual(candidates[0]);
    expect(fakeAi.generateJson).toHaveBeenCalled();
  });

  it('falls back to review (returns null) when AI confidence is below threshold or subject is ambiguous', async () => {
    const candidates = [
      {
        subjectId: '11111111-1111-4111-8111-111111111111',
        subjectName: 'Physics',
        trackId: '22222222-2222-4222-8222-222222222222',
        trackName: 'JEE Main',
      },
    ];

    fakeDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValueOnce({
        innerJoin: jest.fn().mockReturnValueOnce({
          where: jest.fn().mockResolvedValueOnce(candidates),
        }),
      }),
    });

    fakeAi.generateJson.mockResolvedValueOnce({
      value: {
        subjectId: null,
        subjectName: null,
        confidence: 0.4,
        reason: 'Too generic to decide',
      },
    });

    const pages: PageText[] = [{ pageNumber: 1, text: 'General aptitude test paper' }];

    const result = await detectSubjectFromDocument({
      tenantId: '00000000-0000-4000-8000-000000000000',
      db: fakeDb,
      ai: fakeAi,
      pages,
      hints: {},
    });

    expect(result).toBeNull();
  });
});
