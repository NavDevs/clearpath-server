# ⚡ ClearPath Command Server v2

Central cloud backend for **Roadly** (citizen road-hazard reporting) and **Signal-Aid** (emergency-driver response). Serves the REST API, the Socket.IO realtime layer, the admin command dashboard, and the time-based incident lifecycle engine.

- **Live:** https://clearpath-server.onrender.com
- **Roadly website:** https://navdevs.github.io/Roadly-/
- **Docs:** [API.md](API.md) · [DATABASE.md](DATABASE.md) · [SOCKET_EVENTS.md](SOCKET_EVENTS.md) · [DEMO_GUIDE.md](DEMO_GUIDE.md)

---

## 🌟 Features

### Core Pipeline
- **Direct Emergency Dispatch:** ACCIDENT → ambulance, FIRE → fire dispatch the moment the citizen reports it — no analysis step, no waiting
- **Human-Curated Categories:** the citizen's own report type decides the response; everything else stays visible on the Roadly map for its full duration
- **Emergency Dispatch:** Atomic driver acceptance with concurrency protection (409 if taken)
- **Live Response Tracking:** GPS every 5s, signal preemption simulation, arrival/completion flow
- **Persistent History:** All trips and dispatches stored in Neon PostgreSQL

### Time-Based Incident Lifecycle (fully automatic)
- Every incident type auto-resolves when its TTL ends: accident 2h · fire 1h · congestion 3h · blocked 4h · flooding 6h · roadwork/other 4h · pothole 48h
- Resolved incidents stay visible for a **48h retention window** (with a purge countdown for admins), then are hard-deleted by the purge engine
- No manual resolve/reject anywhere — a background sweep engine (every 2 minutes) expires, stamps, and purges rows
- Legacy status-bypass endpoints are removed so the clock cannot be skipped

### Real-time (Socket.IO)
- `new_incident` — Active reports → Roadly map
- `report_updated` — Lifecycle/TTL changes → both apps
- `dispatch.created` — Emergency jobs → Signal-Aid drivers
- `trip.location_updated` — Live GPS → Admin dashboard
- `trip.arrived` / `trip.completed` — State transitions
- `driver.availability_updated` — Driver status changes
- `data_reset` — Admin wiped the database → apps sign users out

### Gamification
- Points per report type, leaderboard, reward events audit trail

### Admin Command Dashboard (`/`)
- Dark theme by default (manual toggle to light), row-click detail cards, live socket refresh
- Split **Roadly Users** / **Signal-Aid Users** tables, incident TTL countdowns, driver approvals, dispatch/trip monitoring

---

## 🏗️ Architecture

```
 Roadly (citizen)      Signal-Aid (driver)      Admin dashboard (/)
        │                     │                        │
        └──────── REST + Socket.IO (HTTPS/WSS) ─────────┘
                             │
                 Express 5 app (server.js)
        ┌────────────┬───────┴────────┬────────────────┐
        │            │                │                │
   Auth (bcrypt,   Dispatch       TTL engine      Sweep engine
   session JWT)   service.js     (per-type       (every 2 min:
        │         (atomic accept,  durations)      expiry, purge,
        │          OSRM routing)       │           backfill, dispatch)
        └────────────┴────────┬────────┴────────────────┘
                              │
                 database.js (Neon PostgreSQL / SQLite dev fallback)
                              +
                 Supabase Storage (photo uploads) · OSRM (free routing)
```

- **Cold start:** `database.js` runs auto-migrations (~11s); routes answer immediately and gate on the init promise.
- **Sweep engine:** `runSweepsSafely()` = `backfillResolvedAt()` + `runExpiryEngine()` + `runDispatchSweeper()` + `runPurgeEngine()`, on boot and every 2 minutes.
- **Timezone safety:** naive timestamps are pinned to UTC (`fixWallClockDates` / `toMs`).

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 22 (CommonJS) |
| API | Express 5 |
| Real-time | Socket.IO 4 |
| Database | Neon PostgreSQL (primary) / SQLite (local fallback) |
| File Storage | Supabase Storage (CDN, public bucket) |
| Routing | OSRM (free, no API key) |
| Security | bcrypt password hashing, file type validation, restricted CORS |

---

## 📁 Project Structure

```
backend/
├── server.js            # Main Express + Socket.IO app, TTL engine, sweeps
├── dispatch_service.js  # Emergency dispatch helpers (no external calls)
├── database.js          # Neon/SQLite pool + auto-migrations
├── maintenance.js       # Shared data-reset / maintenance helpers
├── public/
│   ├── index.html       # Admin command dashboard (single page)
│   └── admin.html       # Legacy admin entry
├── scripts/
│   ├── reset-data.js    # CLI full data wipe
│   └── e2e-admin-flow.sh
├── package.json
├── .node-version        # 22.14.0
├── render.yaml          # Render web-service definition
├── API.md               # Full API reference
├── DATABASE.md          # Schema + relationships
├── SOCKET_EVENTS.md     # All Socket.IO events
├── DEMO_GUIDE.md        # End-to-end test procedures
└── SIMULATION_NOTICE.md # Signal preemption disclaimer
```

---

## ⚙️ Environment Variables

Create a `.env` file in `backend/` (already git-ignored — **never commit it**):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Prod: yes · Dev: no | Neon PostgreSQL connection string (`sslmode=require`). Without it, local dev falls back to SQLite. |
| `PORT` | No | HTTP port (default `3000`). |
| `ADMIN_USERNAME` | No | Admin dashboard login user (override the default defined in `server.js`). |
| `ADMIN_PASSWORD` | No | Admin dashboard login password (override the default defined in `server.js`). |
| `JWT_SECRET` | Prod: yes | Secret used to sign driver/user session tokens. |
| `CORS_ORIGIN` | No | Allowed browser origin for the dashboard/API. |
| `SUPABASE_URL` | For photos | Supabase project URL used for report-photo storage. |
| `SUPABASE_SERVICE_ROLE_KEY` | For photos | Supabase **service-role** key — server-side only, never expose to clients. |

> `server.js` loads `.env` **before** the database module initializes, so plain `node server.js` picks it up automatically (no `dotenv` dependency).

---

## 🚀 Setup & Run

### Prerequisites
- Node.js 22 (see `.node-version`)
- A Neon PostgreSQL connection string (optional for local dev — SQLite fallback)

### Local development

```bash
git clone https://github.com/NavDevs/clearpath-server.git
cd clearpath-server
npm install
# optional: create .env with DATABASE_URL (and the other vars above)
npm start
# → http://localhost:3000
```

### Verify it is alive

```bash
curl http://localhost:3000/health
# { status: "ok", uptime: ..., dataEpoch: ... }
```

- **Dashboard:** open `http://localhost:3000/` and sign in with the admin credentials:

  | Field | Value |
  |-------|-------|
  | **Username** | `admin` |
  | **Password** | `clearpath123` |

  These are the built-in defaults (`server.js`); override them with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment variables. They are intentionally **not displayed on the login page**.
- **Data wipe (dev):** `POST /api/admin/reset-data` or `node scripts/reset-data.js` — bumps `dataEpoch`, which both apps detect and use to sign users out.

### Tests / checks

```bash
node --check server.js      # syntax gate
bash scripts/e2e-admin-flow.sh   # end-to-end admin flow (running server required)
```

---

## 🔌 API Summary

Full request/response reference: **[API.md](API.md)**

| Group | Endpoints |
|-------|-----------|
| **Auth** | `POST /api/auth/register` · `POST /api/auth/login` · `POST /api/auth/roadly` · `POST /api/auth/signalaid` · `POST /api/auth/driver/register` · `POST /api/auth/driver/login` · `POST /api/auth/admin/login` |
| **Reports** | `GET /api/reports` · `POST /api/reports` (multipart photo) |
| **Dispatches** | `GET /api/dispatches` · `GET /api/dispatches/nearby` · `POST /api/dispatches/:id/accept` |
| **Trips** | `GET /api/trips` · `GET /api/trips/:driver_id` · `GET /api/trips/active/:driver_id` · `POST /api/trips` · `POST /api/trips/:id/location` · `PATCH /api/trips/:id/status` |
| **Driver** | `GET /api/driver/profile` · `PATCH /api/driver/availability` · `PATCH /api/driver/location` |
| **Leaderboard** | `GET /api/leaderboard` |
| **Users** | `GET /api/users` · `PATCH /api/users/:id/availability` |
| **Routing** | `GET /api/route` (OSRM) |
| **Admin** | `GET /api/admin/stats` · `GET/POST /api/admin/driver-requests` (+ `/approve`, `/reject`) · `GET /api/admin/drivers` · `GET /api/admin/incidents` (+ `/verify`) · `GET /api/admin/dispatches` (+ `/:id/status`) · `GET /api/admin/trips` · `GET /api/admin/users` · `POST /api/admin/reset-data` |
| **Health** | `GET /health` (uptime + `dataEpoch`) |

Errors follow a single envelope: `{ "error": "...", "code": "OPTIONAL_CODE" }`.

---

## 🗄️ Database

- **Production:** Neon serverless PostgreSQL (persistent)
- **Local dev:** SQLite file (auto-created) when `DATABASE_URL` is absent
- Schema, tables and relationships: **[DATABASE.md](DATABASE.md)**
- Migrations run automatically on boot (`database.js`)

---

## ☁️ Deployment (Render)

**Auto-deploy:** push to `main` → Render builds and deploys → verify `/health` uptime reset.

**Render dashboard environment variables:**
```bash
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxx
CORS_ORIGIN=https://your-frontend-domain.com
JWT_SECRET=...
ADMIN_USERNAME=...
ADMIN_PASSWORD=...
```

**Keep-alive:** a cron pings `/health` every 10 minutes so the free-tier service does not sleep.

| Service | Purpose |
|---------|---------|
| **GitHub** | Source, releases |
| **Render** | Node.js web service (auto-deploy on push) |
| **Neon.tech** | Serverless PostgreSQL |
| **Supabase** | Storage (report photos) |
| **cron-job.org** | Health pings every 10 min |

---

## 📱 Client Apps

| App | Repository | Purpose |
|-----|-----------|---------|
| **Roadly** | [`NavDevs/Roadly-`](https://github.com/NavDevs/Roadly-) | Citizen: report hazards, earn points, view map |
| **Signal-Aid** | [`NavDevs/Signal-Aid`](https://github.com/NavDevs/Signal-Aid) | Driver: accept dispatches, live response, history |

---

## 📋 Documentation

- [API Reference](API.md)
- [Database Schema](DATABASE.md)
- [Socket Events](SOCKET_EVENTS.md)
- [Demo Guide](DEMO_GUIDE.md)
- [Simulation Notice](SIMULATION_NOTICE.md)

---

## ⚖️ License

ISC — College Project
