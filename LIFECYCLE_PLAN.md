# ClearPath Database Audit & Lifecycle Strategy (Phases 2 & 3)

## 1. Existing Schema Analysis
The current Neon Postgres database is solid. We have:
*   `users` (handles both citizens and emergency drivers)
*   `road_reports` (holds the citizen's original report, coordinates, and photo)
*   `emergency_trips` (currently acting as a simple historical log of driver actions)
*   `reward_events` (gamification ledger)

## 2. The Golden Rule
**We will NOT drop or recreate these tables.** To prevent breaking the currently working `Roadly` MVP (which expects `road_reports.status` to be 'pending', 'verified', or 'resolved'), we will safely use `ALTER TABLE` to append new columns, rather than destroying existing constraints.

## 3. Required New Tables & Columns

### A. `ai_analyses` (New Table)
As per the master plan, AI data must be strictly separated from the human report.
```sql
CREATE TABLE ai_analyses (
  id TEXT PRIMARY KEY,
  report_id TEXT REFERENCES road_reports(id),
  detected_type TEXT,
  severity TEXT,
  confidence DOUBLE PRECISION,
  people_injured BOOLEAN,
  road_blocked BOOLEAN,
  emergency_recommended BOOLEAN,
  raw_reasoning TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### B. `dispatches` (New Table)
Currently, `Signal-Aid` drivers just look at the raw `road_reports` feed. We need a table to manage actual *job offers* sent by the backend.
```sql
CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  report_id TEXT REFERENCES road_reports(id),
  required_vehicle TEXT CHECK(required_vehicle IN ('ambulance', 'fire')),
  status TEXT DEFAULT 'available' CHECK(status IN ('available', 'accepted', 'completed', 'cancelled')),
  driver_id TEXT REFERENCES users(id), -- Null until accepted
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### C. Modifications to `emergency_trips` (Existing Table)
Currently, this table only tracks when a trip is finished. We need to add a status column to track the live lifecycle (En Route -> Arrived -> Completed).
```sql
ALTER TABLE emergency_trips ADD COLUMN dispatch_id TEXT;
ALTER TABLE emergency_trips ADD COLUMN status TEXT DEFAULT 'completed';
```

### D. Modifications to `road_reports` (Existing Table)
To support the new lifecycle (Phase 3) without breaking the existing UI, we will add an internal `lifecycle_state` column. The existing `status` column will remain for backward compatibility with the frontend, acting as a simplified public status.
```sql
ALTER TABLE road_reports ADD COLUMN lifecycle_state TEXT DEFAULT 'PENDING_AI';
-- States: PENDING_AI, AI_ANALYZED, NEEDS_REVIEW, VERIFIED, REJECTED, ACTIVE, RECHECK, RESOLVED
```

## 4. The New Incident Lifecycle (Phase 3 Workflow)

1.  **Citizen Submits Report**
    *   `road_reports.lifecycle_state` = `PENDING_AI`
    *   `road_reports.status` = `pending`
2.  **AI Engine Processes It**
    *   Backend creates row in `ai_analyses`.
    *   `lifecycle_state` becomes `AI_ANALYZED`.
3.  **Backend Decision Engine**
    *   If confidence > 85% and it's an Accident:
        *   `lifecycle_state` = `VERIFIED`
        *   Backend inserts row into `dispatches` for an ambulance.
        *   Fires Socket.IO event `dispatch.created`.
    *   If confidence < 50%:
        *   `lifecycle_state` = `NEEDS_REVIEW`.
4.  **Signal-Aid Response**
    *   Driver clicks "Accept" -> `dispatches.status` = `accepted`.
    *   Driver starts driving -> creates `emergency_trips` row (`status='en_route'`).
    *   Driver arrives -> `emergency_trips.status = 'arrived'`.
    *   Driver finishes -> `emergency_trips.status = 'completed'`.
5.  **Resolution Timer**
    *   Backend auto-expiry checks `lifecycle_state`. If time is up, it shifts to `RECHECK` instead of instantly deleting it.
