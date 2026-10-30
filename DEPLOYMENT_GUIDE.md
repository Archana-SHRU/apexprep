# ApexPrep Deployment Guide: Render (Backend + Database) & Vercel (Frontend)

This guide walks you through deploying the complete ApexPrep platform:
- **Backend & PostgreSQL Database** on **Render**
- **Frontend SPA** on **Vercel**

---

## Architecture Overview

```
                      +-----------------------------+
                      |       User Browser          |
                      +--------------+--------------+
                                     |
              +----------------------+----------------------+
              | (HTTPS, HTML/CSS/JS)                        | (HTTPS API with Cookies)
              v                                             v
     +-----------------+                           +-------------------+
     |     Vercel      |                           |      Render       |
     | (Frontend SPA)  |                           |   (NestJS API)    |
     +-----------------+                           +---------+---------+
                                                             | (Internal VPC)
                                                             v
                                                   +-------------------+
                                                   |  Render Postgres  |
                                                   |   (PostgreSQL 16) |
                                                   +-------------------+
```

---

## Key Configurations Already Prepared in Your Repository

1. **[render.yaml](file:///render.yaml)**: Complete Blueprint that automatically provisions:
   - `apexprep-db`: PostgreSQL 16 database.
   - `apexprep-backend`: Node Web Service running NestJS with automated startup database migrations (`npm run db:migrate:prod && npm run start:prod`) and health checks (`/v1/health/live`).
   - Internal secure database connection (`?sslmode=disable` automatically handled).
2. **[vercel.json](file:///apexprep-frontend/vercel.json)**: Single Page Application rewrite rules so direct URLs and page refreshes (e.g. `/practice`, `/tests`, `/login`) never return 404 errors.
3. **[seed-remote.ts](file:///apexprep-backend/scripts/seed-remote.ts)**: Cloud database seeder (`npm run db:seed:remote`) to safely populate your live Render database with the JEE Advanced syllabus, sample questions, and test accounts.
4. **Git ignores & security**: Secrets (`.env`), build artifacts (`dist/`), and `node_modules` are properly ignored.

---

## Step 1: Push Latest Changes to GitHub

Run this command in your terminal to ensure GitHub has all the latest deployment configs:

```powershell
git push origin main
```

---

## Step 2: Deploy Backend & Database on Render (One-Click Blueprint)

1. Log in to your [Render Dashboard](https://dashboard.render.com/).
2. Click the **New +** button at the top right and select **Blueprint**.
3. Connect your GitHub repository: `Archana-SHRU/apexprep` (or select it from your connected repositories).
4. Render will read `render.yaml` and display the two resources to be created:
   - **PostgreSQL Database**: `apexprep-db` (Free plan, Postgres 16)
   - **Web Service**: `apexprep-backend` (Free plan, Node runtime)
5. Click **Apply**.
6. Render will now:
   - Provision the PostgreSQL 16 database.
   - Link the internal database URL to the web service automatically.
   - Run `npm ci && npm run build`.
   - Run `npm run db:migrate:prod` to apply all database migrations automatically (including migration `0022`, which provisions the active adaptive engine configuration, syllabus catalogue, sample questions, and mock tests).
   - Start the API with `npm run start:prod`.
7. Once deployed, note your **Backend URL** from the Render dashboard (e.g., `https://apexprep-backend-xxxx.onrender.com`).

> [!TIP]
> You can verify the backend is running by opening:
> `https://<YOUR-RENDER-BACKEND>.onrender.com/v1/health/live` (should return `{ "status": "ok" }`)
> `https://<YOUR-RENDER-BACKEND>.onrender.com/docs` (interactive Swagger API docs)

---

## Step 3: Deploy Frontend on Vercel

1. Log in to your [Vercel Dashboard](https://vercel.com/dashboard).
2. Click **Add New...** $\rightarrow$ **Project**.
3. Import your GitHub repository: `Archana-SHRU/apexprep`.
4. Configure the project settings:
   - **Framework Preset**: `Vite`
   - **Root Directory**: Click **Edit** and choose `apexprep-frontend` *(CRITICAL: do not leave it at project root)*.
   - **Build Command**: `npm run build` *(default)*
   - **Output Directory**: `dist` *(default)*
5. Expand the **Environment Variables** section:
   - **Key**: `VITE_API_BASE_URL`
   - **Value**: `https://<YOUR-RENDER-BACKEND>.onrender.com` *(your Render backend URL from Step 2, with NO trailing slash)*
6. Click **Deploy**.
7. Once the build finishes (usually ~30-45 seconds), copy your live **Vercel Frontend URL** (e.g. `https://apexprep-frontend-xxxx.vercel.app` or `https://apexprep.vercel.app`).

---

## Step 4: Link Vercel Domain in Render CORS Settings

To allow the browser to securely send cookies between your Vercel frontend and Render backend:

1. Go back to your [Render Dashboard](https://dashboard.render.com/).
2. Click on your `apexprep-backend` Web Service $\rightarrow$ **Environment** tab.
3. Update the following variables with your actual Vercel URL (e.g. `https://apexprep-dpdhyvhg1-archana-shrus-projects.vercel.app`):
   - `CORS_ORIGINS`: `https://apexprep-dpdhyvhg1-archana-shrus-projects.vercel.app,https://apexprep.vercel.app` *(exact URLs with https://, comma-separated if multiple, no trailing slash)*
   - `FRONTEND_URL`: `https://apexprep-dpdhyvhg1-archana-shrus-projects.vercel.app`
   - `APP_PUBLIC_URL`: `https://apexprep-dpdhyvhg1-archana-shrus-projects.vercel.app`
4. Click **Save Changes**. Render will automatically trigger a zero-downtime redeploy with the updated origins.

---

## Step 5: (Optional) Seed Additional Content & Demo Accounts

> [!NOTE]
> **Automatic Baseline Provisioning**: As of migration `0022_default_engine_config_and_content.sql`, Render automatically provisions the active adaptive engine configuration v1, track catalogue, syllabus, practice questions, and demo student during startup! You do **not** need to manually run this script for standard operation.

If you ever wish to re-seed or override demo accounts from your local terminal:

1. Open your [Render Dashboard](https://dashboard.render.com/) $\rightarrow$ click on `apexprep-db` (your PostgreSQL service).
2. In the **Info** tab, locate **External Database URL** and copy it (it looks like `postgres://apexprep:<password>@dpg-xxxxxx-a.oregon-postgres.render.com/apexprep`).
3. Run the following command in PowerShell from the `apexprep-backend` directory:

```powershell
cd c:\Users\ayush\Downloads\apexprep\apexprep-backend

npm run db:seed:remote -- "<YOUR_RENDER_EXTERNAL_DATABASE_URL>"
```

*Example:*
```powershell
npm run db:seed:remote -- "postgres://apexprep:secret123@dpg-cxxxxxxxx-a.oregon-postgres.render.com/apexprep"
```

The script will securely connect over SSL, create the initial tenant, apply the JEE syllabus and practice questions, and output:

```text
  [OK] Applied 001_dev_content.sql
  [OK] Applied 002_dev_learning_contexts.sql
  [OK] Applied 003_dev_mock_tests.sql
  [OK] ADMIN       admin@apexprep.dev (password: AdminPassword123!)
  [OK] STUDENT     student@apexprep.dev (password: StudentPassword123!)
Remote seed complete!
```

---

## Step 6: Test Your Live Deployment

Open your live Vercel URL in your browser:

1. **Student Practice**:
   - Log in with:
     - **Email**: `student@apexprep.dev`
     - **Password**: `StudentPassword123!`
   - Try the adaptive practice ladder, view hints, and submit answers.
2. **Admin Dashboard**:
   - Navigate to `/admin/login` or sign in with:
     - **Email**: `admin@apexprep.dev`
     - **Password**: `AdminPassword123!`
   - Review syllabus structure, question banks, and student analytics.
3. **Public API Documentation**:
   - Visit `https://<YOUR-RENDER-BACKEND>.onrender.com/docs` to test endpoints via Swagger UI.

---

## Summary of Environment Variables

| Variable | Service | Value / Description |
| :--- | :--- | :--- |
| `VITE_API_BASE_URL` | **Vercel** (Frontend) | `https://<YOUR-RENDER-BACKEND>.onrender.com` |
| `NODE_ENV` | **Render** (Backend) | `production` |
| `DATABASE_URL` | **Render** (Backend) | Auto-linked from `apexprep-db` (`render.yaml`) |
| `CORS_ORIGINS` | **Render** (Backend) | `https://<YOUR-VERCEL-FRONTEND>.vercel.app` |
| `FRONTEND_URL` | **Render** (Backend) | `https://<YOUR-VERCEL-FRONTEND>.vercel.app` |
| `REFRESH_COOKIE_SAMESITE` | **Render** (Backend) | `none` (Cross-domain cookies) |
| `REFRESH_COOKIE_SECURE` | **Render** (Backend) | `true` (HTTPS only) |
| `TRUST_PROXY_HOPS` | **Render** (Backend) | `1` (Trusts Render TLS termination) |
| `DEFAULT_TENANT_SLUG` | **Render** (Backend) | `dev-sandbox` |
| `MAIL_PROVIDER` | **Render** (Backend) | `none` (or `smtp` if you add SMTP credentials) |
| `AI_PROVIDER` | **Render** (Backend) | `none` (or `gemini` if you add `GEMINI_API_KEY`) |
