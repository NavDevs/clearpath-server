# ⚡ ClearPath Command Server v2

Central cloud intelligence backend for **Roadly** (citizen reporting) and **Signal-Aid** (emergency response).

---

## 🌟 Features

### Core Pipeline
- **AI-Powered Verification:** Groq Llama 3.2 Vision analyzes citizen photos → 70% confidence threshold
- **Smart Decision Engine:** ACCIDENT → ambulance, FIRE → fire, Others → Roadly map only
- **Emergency Dispatch:** Atomic driver acceptance with concurrency protection (409 if taken)
- **Live Response Tracking:** GPS every 5s, signal preemption simulation, arrival/completion flow
- **Persistent History:** All trips, dispatches, AI analyses stored in Neon PostgreSQL

### Real-time (Socket.IO)
- `new_incident` — Verified/active reports → Roadly map
- `dispatch.created` — Emergency jobs → Signal-Aid drivers
- `trip.location_updated` — Live GPS → Admin dashboard
- `trip.arrived` / `trip.completed` — State transitions
- `driver.availability_updated` — Driver status changes

### Gamification
- Points per report type, leaderboard, reward events audit trail

### Auto-Expiry (2-Phase)
- ACTIVE/VERIFIED → RECHECK (type-specific hours)
- RECHECK → RESOLVED (+30 min)

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 22 (ESM-ready, CommonJS) |
| API | Express 5 |
| Real-time | Socket.IO 4 |
| Database | Neon PostgreSQL (primary) / SQLite (local fallback) |
| AI Vision | Groq Llama 3.2 11B Vision Preview |
| File Storage | Supabase Storage (CDN, public bucket) |
| Routing | OSRM (free, no API key) |
| Security | bcrypt password hashing, file type validation, restricted CORS |

---

## 🌐 Cloud Infrastructure (Free Tier)

| Service | Purpose |
|---------|---------|
| **GitHub** | Source, CI/CD, APK releases |
| **Render** | Node.js Web Service (auto-deploy on push) |
| **Neon.tech** | Serverless PostgreSQL (persistent) |
| **Supabase** | Auth, Database (migrations), Storage, Realtime |
| **cron-job.org** | Health pings every 10 min (prevents sleep) |

---

## 🚀 Deployment

**Render Auto-Deploy:** Push to `main` → builds → deploys

**Required Environment Variables (Render Dashboard):**
```bash
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxx
GROQ_API_KEY=gsk_xxx
CORS_ORIGIN=https://your-frontend-domain.com
```

**Node Version:** `.node-version` = `22.14.0`

---

## 📁 Project Structure

```
backend/
├── server.js           # Main Express + Socket.IO app
├── ai_service.js       # Groq AI analysis + Decision Engine
├── database.js         # Neon/SQLite pool + auto-migrations
├── package.json
├── .node-version
├── render.yaml
├── API.md              # Full API reference
├── DATABASE.md         # Schema + relationships
├── AI_PIPELINE.md      # AI flow + decision rules
├── SOCKET_EVENTS.md    # All Socket.IO events
├── DEMO_GUIDE.md       # End-to-end test procedures
└── SIMULATION_NOTICE.md # Signal preemption disclaimer
```

---

## 🔧 Local Development

```bash
cd backend
npm install
# Set DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY
npm start
# Server on http://localhost:3000
```

---

## 📱 Client Apps

| App | Repo Path | Purpose |
|-----|-----------|---------|
| **Roadly** | `../Roadly--main/` | Citizen: report hazards, earn points, view map |
| **Signal-Aid** | `../Signal-Aid-main/` | Driver: accept dispatches, live response, history |

---

## 📋 Documentation

- [API Reference](API.md)
- [Database Schema](DATABASE.md)
- [AI Pipeline](AI_PIPELINE.md)
- [Socket Events](SOCKET_EVENTS.md)
- [Demo Guide](DEMO_GUIDE.md)
- [Simulation Notice](SIMULATION_NOTICE.md)

---

## ⚖️ License

ISC — College Project