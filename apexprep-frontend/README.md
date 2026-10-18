# ApexPrep — Frontend

Adaptive learning + question practice platform for JEE, NEET and the Physics,
Chemistry, Mathematics and Astronomy Olympiads.

Built from the approved Google Stitch design ("Apex Precision Academic").
No visual redesign was introduced: colours, typography, radii, spacing, chip
styles, option-card states and the question-palette legend are transcribed
directly from `DESIGN.md` and the exported screens.

## Install & run

```bash
cd apexprep-frontend
npm install
npm run dev        # http://localhost:5173
```

Other scripts: `npm run build`, `npm run preview`, `npm run typecheck`.

## Stack

React 18 · TypeScript · Vite 5 · Tailwind CSS 3 · Lucide React · Recharts ·
shadcn-style primitives (CVA + clsx + tailwind-merge, hand-written in
`src/components/ui` so there is no generator step or extra runtime).

## Structure

```
src/
  components/      shared components (StatStrip, QuestionPalette, OptionCard, AIExplanation…)
  components/ui/   primitives (Button, Card, Badge/DifficultyChip, Input, Tabs, Dialog, Table…)
  layouts/         StudentLayout, AdminLayout, AuthLayout
  pages/           student screens
  pages/admin/     admin screens
  data/            typed mock data (curriculum, questions, student, analytics, admin)
  hooks/           useAuth, useToast, useApi, usePracticeSession
  lib/             utils.ts (tokens/formatters), api.ts (THE BACKEND SEAM)
  types/           all domain types
```

## Routes

Student — `/login`, `/signup`, `/onboarding`, `/dashboard`, `/learn`,
`/learn/:subjectId`, `/learn/:subjectId/:chapterId`, `/theory/:theoryId`,
`/practice`, `/practice/:subTopicId`, `/tests`, `/tests/:testId`,
`/tests/:testId/result`, `/analytics`, `/reports`, `/profile`

Admin — `/admin/login`, `/admin`, `/admin/upload`, `/admin/processing`,
`/admin/review`, `/admin/questions`, `/admin/students`, `/admin/analytics`

## Connecting the backend

Every screen reads data through `src/lib/api.ts` only. Each method is a
one-line `Promise` over typed mock data with the exact signature and return
type the REST endpoint should have. Replace each body with `fetch(...)` and
nothing else changes:

| Method | Suggested endpoint |
| --- | --- |
| `getTracks` / `getSubjects` / `getChapters` / `getTopics` | `GET /api/curriculum/*` |
| `getTheory` / `getTheoryBySubTopic` | `GET /api/theory/:id` |
| `getPracticeSet` | `GET /api/practice/:subTopicId?count=` |
| `getTestQuestions` / `getTestResult` | `GET /api/tests/:id/*` |
| `getAnalytics` | `GET /api/analytics?range=&subject=` |
| `askAI` | `POST /api/ai/ask` |
| `getUploadJobs` / `getReviewItems` / `getAdminStudents` / `getPlatformStats` | `GET /api/admin/*` |

Auth currently persists a session object in `localStorage`
(`src/hooks/useAuth.tsx`) — swap for real tokens there.

## Responsive behaviour

Desktop-first, with purpose-built tablet and mobile layouts rather than a
shrunk desktop: a bottom navigation HUD under `lg`, a sticky thumb-reachable
action bar in Practice and Test, the question palette moved into a drawer,
touch targets of at least 56px on answer options, horizontally scrollable
tables, and stacking cards. Safe-area insets are respected on mobile.
