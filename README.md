ApexPrep — AI Home Tutor & Adaptive Learning Platform

Project status: Core platform, adaptive practice, AI learning features, and automatic syllabus-ingestion workflow are implemented and tested. Final browser QA, admin Question Bank/Analytics completion, and production hardening remain.

1. The Problem

Students often study from fixed question banks and generic explanations. These systems do not always adapt to each learner's current understanding.

ApexPrep aims to solve these problems:

One-size-fits-all practice: Students at different ability levels may receive similar questions.

Hidden weaknesses: Scores do not always reveal the exact concepts a student struggles with.

Generic explanations: Help may not address the student's actual answer or misconception.

Fragmented learning: Theory, practice, revision, doubt-solving, and visual learning are often separate.

Manual content setup: Admins traditionally have to create Chapter → Topic → Sub-topic records before uploading useful content.

Content quality and safety: Extracted content must be reviewed before students can access it.

Content expansion: New material must be added without inventing unsupported syllabus names.

Production reliability: AI quota, real-world PDFs, email delivery, hosting, and operational controls need validation before launch.

2. The Solution

ApexPrep combines an AI Home Tutor with an adaptive learning engine.

Its core learning loop is:

Learn → Practice → Detect weakness → Explain → Practice again → Increase difficulty

The platform uses learner performance to select practice difficulty and provide contextual help. Theory, revision notes, doubt follow-up, fresh question generation, and visual explanations are connected around the learner's current syllabus location.

Main differentiators

Adaptive practice rather than only a static question bank.

A learner model that updates from server-graded attempts.

Contextual AI help based on the current topic, question, and student's answer.

Fresh AI-generated practice questions validated before being served.

Student-triggered visual explanations instead of forcing visuals on every question.

Content-grounded notes and retrieval over published learning material.

PDF-based syllabus detection with human approval before creating missing syllabus nodes.

Separate syllabus approval and content approval gates.

Tenant-aware access control and audit logging.

3. Features Implemented

Student and learning platform

Registration, login, logout, token refresh, and password-reset flows.

Role-based access and tenant isolation.

Backend-driven track selection and learner-track enrollment.

Track → Subject → Chapter → Topic → Sub-topic syllabus model.

Published theory content.

Adaptive practice sessions and server-side answer grading.

Learner ability updates, difficulty targeting, promotion/demotion rules, cold start, probes, probable-guess detection, parent-topic fallback, and question-reuse controls.

AI short revision notes grounded in published theory.

AI tutor conversations for hints, simpler explanations, why-an-answer-was-wrong guidance, step-by-step help, and examples.

AI fresh-question generation at a difficulty selected by the adaptive engine.

Structured visual explanations, including diagrams, graphs, step-by-step scenes, and supported animations.

Semantic retrieval using embeddings over published content.

Contextual explanations and reporting workflows.

Admin and content operations

Admin-only console and protected admin APIs.

Manual syllabus authoring remains available.

PDF content ingestion, extraction, segmentation, mapping, question/solution extraction, review, and publishing.

Suggested Syllabus UI with evidence, confidence, and NEW, EXISTING, or UNRESOLVED states.

Approve, Edit & Approve, and Reject actions for syllabus suggestions.

Registration-success email and forgot-password/reset email infrastructure with SMTP support; local Mailpit delivery was verified.

4. Automatic Syllabus Detection — Problem and Solution

Problem

Previously, ingestion mainly tried to map uploaded content to already-existing published sub-topics. If an admin uploaded material for a new topic, they had to manually create the Chapter, Topic, and Sub-topic before the content could be mapped.

Solution

Admin selects Track + Subject and uploads a PDF.

The system extracts and segments the PDF text.

It detects heading hierarchy from explicit numbering and other supported structural evidence.

It matches detected names only inside the uploaded Track and Subject.

Existing nodes are reused when the match is sufficiently strong.

Missing levels become a pending syllabus suggestion, not actual syllabus nodes.

The admin reviews the names, confidence, evidence, and linked blocks.

Only after approval does the system create missing syllabus nodes.

Content blocks are linked to the approved sub-topic.

Content still goes through the normal content approval and publishing workflow.

Safety rules

The pipeline does not create syllabus nodes before admin approval.

AI fallback is used only when deterministic detection is insufficient.

AI cannot introduce arbitrary syllabus names; proposed names must be grounded in uploaded PDF text.

Cross-track, cross-subject, and cross-tenant matching is prevented.

Rejecting a suggestion does not create or modify syllabus nodes.

Approving a syllabus suggestion does not automatically approve or publish its content.

Syllabus suggestion APIs

GET /v1/admin/ingestion/jobs/:id/suggestions

POST /v1/admin/ingestion/jobs/:id/suggestions/:suggestionId/approve

POST /v1/admin/ingestion/jobs/:id/suggestions/:suggestionId/reject

Migration 0016 adds the suggestion and block-association tables/relations.

5. Architecture

Frontend: React, TypeScript, Vite, Tailwind CSS

Backend: NestJS, TypeScript

Database: PostgreSQL

Vector retrieval: pgvector

AI: Gemini as the current primary provider, with a provider abstraction for future fallback support

Testing: Jest, backend integration/e2e tests, SQL assertions, frontend tests

Local infrastructure: Docker-based PostgreSQL/Redis; Mailpit can be used for local email testing

Read exact package versions and environment settings from the current project files. Never commit real API keys, database passwords, SMTP credentials, or seed passwords.

6. Testing and Verification

Latest reported results for the syllabus-detection implementation:

Check

Result

Backend full test suite

1197 / 1198 passed

Hierarchy unit tests

21 / 21 passed

Syllabus-suggestion end-to-end tests

24 / 24 passed

SQL assertions

183 / 183 passed

Frontend tests

30 / 30 passed

Backend typecheck

Clean

Backend lint

Clean

Backend build

Clean

Frontend typecheck

Clean

Frontend build

Clean

The complete syllabus flow was reported as verified against the test database:

Upload PDF → extract → detect hierarchy → create pending suggestion → fetch suggestions → approve → create/reuse nodes → map block → normal content approval → publish → student reads Theory.

Known test failure

One existing Windows ingestion test for the request-body size limit fails with a write ECANCELED error. It was reported as pre-existing and unrelated to the syllabus-detection work. Re-run the suite in the current environment before treating these figures as current.

7. Current Limitations and Remaining Work

Product and QA

The new flow has primarily been tested with generated PDFs; real textbook layouts need broader testing.

Scanned/image-only PDF OCR is not yet a complete capability.

Real Gemini hierarchy-fallback behavior still needs a controlled live-provider smoke test.

PDFs with insufficient hierarchy evidence may require admin editing.

Option A selected: approved but empty syllabus nodes should ideally remain hidden from students until at least one content block is published.

Admin Question Bank needs complete frontend connection/QA.

Admin Platform Analytics needs platform-level backend aggregation and frontend wiring.

Full browser QA is still required across admin and student flows.

Infrastructure and launch readiness

Production HTTPS, CORS, secrets management, monitoring, and deployment configuration must be finalized.

Cloud object storage and a durable ingestion queue are not yet confirmed as production-ready.

Production SMTP delivery must be tested with the chosen email provider/domain.

Gemini quota and expected production usage need planning.

Anthropic fallback live verification is deferred; do not treat it as verified until tested with a suitable workspace-scoped key.

Adaptive-engine parameters need calibration using real learner data.

Final staging and mobile/Android verification are required before release.

Current assessment: Not yet production-ready. The core product is substantially implemented, but remaining QA and production-readiness items should be completed before public launch.

8. Recommended Next Steps

Fix the current local Forgot Password CORS/backend connection issue.

Browser-test PDF upload, hierarchy detection, suggestion approval, content approval, publishing, and student Theory.

Implement Option A: keep approved but empty syllabus nodes hidden from students until content is published.

Finish the admin Question Bank connection.

Build and connect Admin Platform Analytics.

Run student/admin regression tests and verify role/tenant isolation.

Test representative real textbook PDFs; document segmentation/OCR gaps.

Verify AI hierarchy fallback against the configured provider.

Finalize production HTTPS, secrets, CORS, storage, durable queue, monitoring, CI/CD, and email provider.

Run final security, accessibility, performance, and content QA.

Complete hosted staging verification before Android packaging/release.

9. Important Product Decisions

ApexPrep is an AI Home Tutor + Adaptive Learning Platform, not just a question bank.

The adaptive engine is core infrastructure and should not be changed casually.

Student-facing AI should remain grounded in published content and learner context.

New syllabus hierarchy requires human approval.

Syllabus approval and content approval are separate gates.

The platform is designed to support Class 1 onward, but that does not mean the complete syllabus or question bank for every class already exists.

Payment/subscription is future scope and is not currently a mandatory dependency.

10. One-Line Summary

ApexPrep is an AI-powered personal home tutor that adapts what each student learns and practices based on their individual performance.
