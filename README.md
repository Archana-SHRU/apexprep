# ApexPrep — Project Structure

**Project Name:** ApexPrep
**Project Type:** AI Home Tutor + Adaptive Learning Platform
**Frontend:** React, TypeScript, Vite, Tailwind CSS
**Backend:** NestJS, TypeScript
**Database:** PostgreSQL + pgvector
**AI Provider:** Gemini (primary)

---

## 1. Project Overview

ApexPrep is an AI-powered personal home tutor and adaptive learning platform. It helps students learn concepts, practise questions, identify weaknesses, receive personalised explanations, and improve their performance through an adaptive learning engine.

The platform is designed to support school students from Class 1 onward, along with competitive exam preparation such as JEE, NEET, and Olympiads. However, the availability of a track does not mean its complete syllabus or question bank has already been populated.

The core learning cycle is:

**Learn → Practice → Detect Weakness → Explain → Practice Again → Increase Difficulty**

## 2. High-Level Repository Structure

The project is organised into two main applications:

```text
ApexPrep/
├── apexprep-frontend/
│   ├── src/
│   │   ├── components/       # Reusable UI components
│   │   ├── pages/            # Student and admin pages
│   │   ├── lib/              # API clients and helper functions
│   │   ├── hooks/            # React hooks and feature state
│   │   ├── types/            # TypeScript and API types
│   │   └── tests/            # Frontend tests
│   └── package.json
│
├── apexprep-backend/
│   ├── src/
│   │   ├── auth/             # Authentication and password flows
│   │   ├── users/            # User and profile functionality
│   │   ├── syllabus/         # Tracks and syllabus operations
│   │   ├── practice/         # Practice sessions and attempts
│   │   ├── learning-ai/      # AI notes, tutor, generation, visuals
│   │   ├── explanations/     # Explanation and grounding logic
│   │   ├── ingestion/        # PDF processing and hierarchy detection
│   │   ├── questions/        # Question-related operations
│   │   ├── analytics/        # Student analytics and recommendations
│   │   ├── mail/             # Email templates and delivery
│   │   ├── database/         # Database schema and repositories
│   │   └── common/           # Shared guards, errors and utilities
│   ├── database/
│   │   └── migrations/       # Database migrations
│   ├── test/
│   │   ├── unit/             # Unit tests
│   │   └── e2e/              # End-to-end tests
│   └── package.json
│
└── README.md
```

*Note: This is the logical high-level structure. Verify exact folder names and locations against the current repository.*

## 3. Frontend Structure

The frontend is built using React, TypeScript, Vite, and Tailwind CSS.

### Main responsibilities

* **components/** — Reusable UI components, forms, layouts, question renderers, and visual explanation components.
* **pages/** — Login, registration, onboarding, dashboard, theory, practice, and admin screens.
* **lib/** — HTTP/API helpers, formatting utilities, answer utilities, and admin/content API clients.
* **hooks/** — Authentication, API fetching, and practice-session state management.
* **types/** — TypeScript types for API requests, responses, and UI data.
* **tests/** — UI and interaction tests.

### Main student screens

* Registration and login
* Onboarding and track selection
* Dashboard
* Theory and learning content
* Adaptive practice
* AI tutor and explanations
* AI-generated fresh practice
* Visual explanations
* Revision notes

### Main admin screens

* Admin dashboard
* Syllabus management
* Content upload
* Content processing
* Content review
* Suggested syllabus review
* Question Bank
* Platform Analytics

Some admin features still require additional API integration or browser QA.

## 4. Backend Structure

The backend is built using NestJS and TypeScript. It provides APIs, business logic, database access, authentication, AI integration, and adaptive practice.

### Main modules

**auth/**
Handles registration, login, token refresh, logout, password reset, and authentication-related workflows.

**users/**
Manages user profiles and user-related operations.

**syllabus/**
Manages tracks, subjects, chapters, topics, sub-topics, and syllabus access rules.

**practice/**
Manages practice sessions, question delivery, answer submissions, server-side grading, attempts, and session events.

**Adaptive Learning Engine**
Updates learner ability, selects suitable question difficulty, handles promotion/demotion, probes, cold-start behaviour, probable-guess detection, and fallback when suitable questions are unavailable. This is core logic and should not be changed casually.

**learning-ai/**
Contains AI short notes, AI tutor conversations, fresh question generation, visual explanations, and related grounding and answer-leakage checks.

**explanations/**
Handles explanations, retrieval, source grounding, and explanation-related workflows.

**ingestion/**
Processes uploaded PDFs, extracts and segments text, detects syllabus hierarchy, matches existing nodes, and creates pending syllabus suggestions.

**questions/**
Provides question-related APIs, validation, and question-generation integration.

**analytics/**
Provides student summaries, learning analytics, and recommendations. Platform-level admin analytics still needs completion.

**mail/**
Manages welcome emails, password-reset emails, templates, and email transport configuration.

**database/**
Contains database schema definitions, repositories, and database-related integration.

**common/**
Contains shared configuration, guards, validation, error handling, and reusable utilities.

## 5. Database Structure

ApexPrep uses PostgreSQL as its primary relational database and pgvector for semantic retrieval.

The database supports:

* Users and organisations
* Authentication and refresh/reset tokens
* Tracks and learner-track enrolment
* Syllabus hierarchy
* Theory and content blocks
* Questions and solutions
* Practice sessions and attempts
* Learner ability and adaptive configuration
* AI tutor conversations and messages
* Revision notes
* Generated questions
* Visual explanations
* Ingestion jobs and review tasks
* Syllabus suggestions
* Audit records

Database schema changes are managed through migrations.

**Migration 0016** introduced the syllabus-suggestion persistence model and associations between suggestions and ingestion content blocks.

Database rules:

* Preserve tenant/organisation isolation.
* Use transactions for multi-step operations.
* Do not create syllabus nodes during ingestion before human approval.
* Do not publish content without passing the normal content-review workflow.
* Never commit passwords, API keys, or other secrets.

## 6. Main System Workflows

### 6.1 Adaptive Practice

1. The student opens a topic.
2. The backend creates or loads a practice session.
3. The adaptive engine selects a suitable question.
4. The student submits an answer.
5. The backend grades the answer.
6. The learner model is updated.
7. The next question is selected based on the updated learner state.

### 6.2 AI Tutor

1. The student requests a hint, explanation, simpler wording, or example.
2. The backend retrieves relevant published theory and question context.
3. Permitted attempt information is included when relevant.
4. The AI generates a contextual response.
5. The response is validated for grounding and answer leakage.
6. The response is returned to the student.

### 6.3 Automatic Syllabus Detection

1. The admin selects a Track and Subject.
2. The admin uploads a PDF.
3. The system extracts and segments the text.
4. The system detects Chapter, Topic, and Sub-topic headings when evidence is available.
5. Detected names are matched against the existing syllabus within the selected Track and Subject.
6. Missing levels become pending syllabus suggestions.
7. The admin reviews the evidence and approves, edits, or rejects the suggestion.
8. Missing syllabus nodes are created only after approval.
9. Content blocks are linked to the approved sub-topic.
10. Content still passes through normal content approval and publishing.
11. Published content becomes available to the existing learning and AI features.

## 7. Syllabus Suggestion APIs

The following admin APIs support syllabus suggestion review:

```http
GET /v1/admin/ingestion/jobs/:id/suggestions
```

Returns the suggestions associated with an ingestion job.

```http
POST /v1/admin/ingestion/jobs/:id/suggestions/:suggestionId/approve
```

Approves a suggestion and creates or reuses the required syllabus nodes.

```http
POST /v1/admin/ingestion/jobs/:id/suggestions/:suggestionId/reject
```

Rejects a suggestion without creating syllabus nodes.

These APIs require the appropriate content-management permission.

## 8. Security and Access Control

ApexPrep uses role-based access control, tenant isolation, and audit logging.

Important security rules:

* Students must not access the admin console.
* Backend admin APIs must enforce permissions independently of frontend routing.
* Tenant-owned data must be scoped to the authenticated organisation.
* Student APIs must not expose hidden
