# SDC Job Fair — First Prototype

Scope (agreed before build): the **core loop only** — candidate self-registration → interview result — with polling instead of Socket.IO and a stubbed staff "login" (role switcher, no passwords). No Redis, BullMQ, PgBouncer, batches, or the other 4 roles yet; those are production-scale concerns from `SDC_JobFair_Architecture.md`, not needed to prove the main data flow locally. Corporate-professional palette from `SDC_JobFair_UIUX_Plan.md` §1 is wired in throughout.

## What's here

```
prototype/
  express-app/     REST API — Node/Express + PostgreSQL (pg), no ORM
  react-app/       Vite + React, react-router-dom, plain CSS (theme.css)
```

## What it does

1. **Candidate flow** (`/`, `/register`, `/schedule/:token`) — no login. Browse company tiles → fill a short form → pick up to 3 companies → get a token + schedule. Server picks the earliest open slot per company inside one transaction (`SELECT ... FOR UPDATE`), same concurrency-safety approach as the full architecture doc, just without PgBouncer session pooling in front of it.
2. **Admin panel** (`/staff/admin`) — create companies, configure rating parameters, add interview slots, see live-ish stats (polled).
3. **Company Desk** (`/staff/desk`) — pick a company (stand-in for HR login), see the pending queue in slot order, search by token, record a result with per-company star ratings + feedback. Ratings are validated server-side against that company's configured parameters before anything is written.

Real-time updates are **polling every 5s**, not Socket.IO — the architecture doc's live-broadcast design is deferred to the next iteration once this core loop is validated.

## Prerequisites

- Node 24 / npm 11 (already installed)
- PostgreSQL 16 (already running as a Windows service — confirmed via `Get-Service *postgres*`)
- `psql` is not on PATH but exists at `C:\Program Files\PostgreSQL\16\bin\psql.exe`

## One-time setup

1. **Create the database.** Using pgAdmin, or psql:
   ```
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE sdc_jobfair;"
   ```
   (enter your postgres password when prompted)

2. **Configure the API's `.env`:**
   ```
   cd prototype/express-app
   cp .env.example .env
   ```
   Edit `.env` and set `DATABASE_URL` to your actual connection string, e.g.:
   ```
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/sdc_jobfair
   ```

3. **Run the migration and seed data** (creates tables + 3 sample companies with rating parameters and a day's worth of slots):
   ```
   cd prototype/express-app
   npm run migrate
   npm run seed
   ```

## Running it

Two terminals:

```
cd prototype/express-app
npm run dev            # http://localhost:3000
```

```
cd prototype/react-app
npm run dev             # http://localhost:5173
```

Open http://localhost:5173 — you'll land on a chooser between the candidate flow and the staff app.

## Suggested first walk-through

1. Go to **Staff → Admin**, confirm the 3 seeded companies (Infosys, TCS, Wipro) show open slots. Optionally add a 4th company.
2. Go to the **candidate flow** (`/register`), pick 1–3 companies, submit the form. Note the token and schedule shown.
3. Go to **Staff → Company Desk**, select one of the companies the candidate picked. The candidate should appear in the pending queue within ~5s. Search by their token to confirm lookup works too.
4. Open the candidate, pick a result, rate the configured parameters, add feedback, save.
5. Go back to the candidate's `/schedule/:token` page (or wait for its next poll) — the status chip should update to the recorded result within ~5s.

## What's deliberately not in this prototype yet

Per the architecture doc, these are next-iteration items, not bugs:

- Auth (JWT), the other 3 roles (Registration Staff, Floor Manager, Volunteer), Floor Monitor grid
- Batches / crowd-control gates 1–4
- Socket.IO real-time push (polling stands in for it)
- Redis (rate limiting, caching, BullMQ auto-dispatch), PgBouncer, read replica
- Soft-delete, fair-day scoping (`fair_settings`/`fair_date`)
- QR token signing/scanning (registration is just a public form for now)
