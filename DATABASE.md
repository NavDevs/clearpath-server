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
| type | TEXT | accident, congestion, blocked, flooding, pothole, fire, roadwork, other |
| description | TEXT | |
| status | TEXT | DEFAULT 'pending', CHECK (pending, verified, resolved, rejected) — only `pending`/`resolved`/`rejected` are written today |
| lifecycle_state | TEXT | DEFAULT 'ACTIVE', CHECK (legacy PENDING_AI/AI_ANALYZED/VERIFIED/NEEDS_REVIEW, ACTIVE, DISPATCHED, ACCEPTED, EN_ROUTE, ARRIVED, RECHECK, RESOLVED, REJECTED) |
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
| criticality | TEXT | CHECK (low, medium, high, critical) — driver's own assessment |
| travel_time | DOUBLE PRECISION | seconds |
| preemptions | INTEGER | |
| confidence | INTEGER | legacy column, no longer written (stays NULL) |
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

### driver_approval_requests
| Column | Type | Constraints |
|--------|------|-------------|
| id | TEXT | PRIMARY KEY |
| user_id | TEXT | FK → users(id) |
| status | TEXT | DEFAULT 'pending', CHECK (pending, approved, rejected) |
| created_at | TIMESTAMP | DEFAULT NOW() |

---

## Relationships

```
users (1) ──────< (N) road_reports
users (1) ──────< (N) emergency_trips
users (1) ──────< (N) reward_events
users (1) ──────< (N) dispatches (as driver)

road_reports (1) ──────< (1) dispatches
road_reports (1) ──────< (N) reward_events
road_reports (1) ──────< (N) emergency_trips

dispatches (1) ──────< (1) emergency_trips
```

---

## Lifecycle State Machine

The citizen's report type decides everything — accident and fire dispatch
immediately, every other issue stays visible for its full duration.

```
SUBMITTED
    │
    ├─ ACCIDENT / FIRE ──▶ DISPATCHED ──▶ ACCEPTED ──▶ EN_ROUTE ──▶ ARRIVED ──▶ RESOLVED
    │                          │
    │                          └─ (no driver claimed before expiry) ──▶ CANCELLED dispatch
    │
    └─ Other types ──▶ ACTIVE ──▶ (auto-expiry) ──▶ RESOLVED

Any state ──▶ REJECTED (admin decision)
```

---

## Auto-Expiry Engine (Background Job)

Runs every 2 minutes. Single phase: an incident that outlives its configured
duration moves to RESOLVED, and any still-unclaimed dispatch is cancelled.
Incidents in ACCEPTED / EN_ROUTE / ARRIVED are never expired.

| Type | Hours |
|------|-------|
| accident | 2 |
| fire | 1 |
| congestion | 3 |
| blocked | 4 |
| flooding | 6 |
| pothole | 48 |
| roadwork / other / default | 4 |

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
