# ClearPath Database Schema

**Database:** Neon PostgreSQL (primary) / SQLite (local fallback)  
**Managed by:** `database.js` with auto-migrations

---

## Tables

### users
| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PRIMARY KEY |
| role | TEXT | CHECK (citizen, emergency_driver, admin) |
| phone | TEXT | UNIQUE |
| name | TEXT | |
| password | TEXT | bcrypt hash |
| driver_id | TEXT | UNIQUE |
| vehicle_no | TEXT | |
| points | INTEGER | DEFAULT 0 |
| availability | TEXT | DEFAULT 'OFFLINE', CHECK (OFFLINE, AVAILABLE, BUSY) |
| created_at | TIMESTAMP | DEFAULT NOW() |

---

### road_reports
| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | FK → users(id) |
| type | TEXT | accident, congestion, blocked, flooding, pothole |
| description | TEXT | |
| status | TEXT | DEFAULT 'pending', CHECK (pending, verified, resolved) |
| lifecycle_state | TEXT | DEFAULT 'PENDING_AI', CHECK (PENDING_AI, AI_ANALYZED, VERIFIED, NEEDS_REVIEW, ACTIVE, RECHECK, RESOLVED) |
| latitude | DOUBLE PRECISION | |
| longitude | DOUBLE PRECISION | |
| address | TEXT | |
| photo_url | TEXT | Supabase Storage public URL |
| points | INTEGER | DEFAULT 0 |
| created_at | TIMESTAMP | DEFAULT NOW() |

**Indexes:**
- `road_reports_user_idx` on user_id
- `road_reports_status_idx` on status
- `road_reports_created_idx` on created_at DESC

---

### ai_analyses
| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PRIMARY KEY |
| report_id | TEXT | FK → road_reports(id) |
| detected_type | TEXT | ACCIDENT, FIRE, BLOCKED, CONGESTION, POTHOLE, OTHER |
| severity | TEXT | LOW, MEDIUM, HIGH, CRITICAL |
| confidence | DOUBLE PRECISION | 0.0 - 1.0 |
| people_injured | BOOLEAN | |
| road_blocked | BOOLEAN | |
| emergency_recommended | BOOLEAN | |
| raw_reasoning | TEXT | AI explanation |
| created_at | TIMESTAMP | DEFAULT NOW() |

---

### dispatches
| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PRIMARY KEY |
| report_id | TEXT | FK → road_reports(id) |
| required_vehicle | TEXT | CHECK (ambulance, fire) |
| status | TEXT | DEFAULT 'available', CHECK (available, accepted, completed, cancelled) |
| driver_id | TEXT | FK → users(id) |
| created_at | TIMESTAMP | DEFAULT NOW() |
| updated_at | TIMESTAMP | DEFAULT NOW() |

---

### emergency_trips
| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PRIMARY KEY |
| dispatch_id | TEXT | FK → dispatches(id) |
| driver_id | TEXT | FK → users(id) |
| vehicle_no | TEXT | |
| report_id | TEXT | FK → road_reports(id) |
| criticality | TEXT | CHECK (low, medium, high, critical) |
| travel_time | DOUBLE PRECISION | seconds |
| preemptions | INTEGER | |
| confidence | INTEGER | % |
| distance | DOUBLE PRECISION | km |
| status | TEXT | DEFAULT 'completed', CHECK (en_route, arrived, completed) |
| started_at | TIMESTAMP | DEFAULT NOW() |
| completed_at | TIMESTAMP | |

**Indexes:**
- `emergency_trips_driver_idx` on driver_id
- `emergency_trips_report_idx` on report_id
- `emergency_trips_started_idx` on started_at DESC

---

### reward_events
| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | FK → users(id) |
| report_id | TEXT | FK → road_reports(id) |
| points | INTEGER | |
| reason | TEXT | DEFAULT 'report_submission' |
| created_at | TIMESTAMP | DEFAULT NOW() |

**Indexes:**
- `reward_events_user_idx` on user_id

---

## Relationships

```
users (1) ──────< (N) road_reports
users (1) ──────< (N) emergency_trips
users (1) ──────< (N) reward_events
users (1) ──────< (N) dispatches (as driver)

road_reports (1) ──────< (1) ai_analyses
road_reports (1) ──────< (1) dispatches
road_reports (1) ──────< (N) reward_events
road_reports (1) ──────< (N) emergency_trips

dispatches (1) ──────< (1) emergency_trips
```

---

## Lifecycle State Machine

```
PENDING_AI
    │
    ▼ (AI analysis complete)
AI_ANALYZED
    │
    ├─ confidence < 70% ──▶ NEEDS_REVIEW
    │
    ├─ ACCIDENT/FIRE + confidence ≥ 70% ──▶ VERIFIED ──▶ Dispatch created
    │                                              │
    │                                              ▼
    │                                         ACTIVE (on Roadly map)
    │                                              │
    │                                              ▼ (auto-expiry)
    │                                         RECHECK
    │                                              │
    │                                              ▼ (30 min later)
    │                                         RESOLVED
    │
    └─ Other types (POTHOLE, BLOCKED, etc.) ──▶ ACTIVE ──▶ RECHECK ──▶ RESOLVED
```

---

## Auto-Expiry Engine (Background Job)

Runs every 10 minutes. Two-phase:

**Phase 1: ACTIVE/VERIFIED → RECHECK**
| Type | Hours to RECHECK |
|------|------------------|
| accident | 2 |
| fire | 1 |
| congestion | 3 |
| blocked | 4 |
| flooding | 6 |
| pothole | 48 |
| default | 4 |

**Phase 2: RECHECK → RESOLVED** (additional 30 minutes)

---

## Supabase Storage

**Bucket:** `report-photos` (public)

**URL Format:**
```
https://{project}.supabase.co/storage/v1/object/public/report-photos/{uuid}-{timestamp}.{ext}
```

**Constraints:**
- Max 5MB per file
- Allowed: image/jpeg, image/png, image/webp, image/heic
- 1GB free storage, 50GB/month egress

---

## Migration Safety

All schema changes use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` or `try/catch` blocks to preserve existing data during deployments.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Neon connection string with sslmode=require |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key for Storage uploads |
| `GROQ_API_KEY` | Yes | Groq API key for AI analysis |