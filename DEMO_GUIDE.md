# ClearPath End-to-End Demo Guide

**Prerequisites:**
- Roadly installed on Phone A / laptop build (citizen)
- Signal-Aid installed on Phone B / laptop build (driver)
- Backend deployed on Render (healthy)
- Supabase project configured

---

## Test AA: Accident Flow (Full Emergency Pipeline)

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Phone A: Open Roadly → Login/Register | User logged in, sees map |
| 2 | Phone A: Tap "Report" → Select **ACCIDENT** → Add photo + description + GPS | Report submitted, returns `lifecycle_state: "ACTIVE"` |
| 3 | Backend (within ~1s) | Accident is a critical type → dispatch created immediately, lifecycle → `DISPATCHED` |
| 4 | Phone B: Signal-Aid dispatch screen shows **🚨 EMERGENCY JOBS** red section | New dispatch card: "ACCIDENT", address, 🚑 AMBULANCE badge |
| 5 | Phone B: Tap **ACCEPT JOB** | Backend: atomic check, creates trip, marks dispatch `accepted`, driver → BUSY |
| 6 | Phone B: Navigates to **Response Screen** | Shows Distance, ETA, Signal Count, Intersections |
| 7 | Phone B: GPS updates every 5s (green indicator) | Backend receives `trip.location_updated` broadcasts |
| 8 | Phone B: Intersections show **Preempted → Cleared** animation | Signal preemption simulation runs |
| 9 | Phone B: Tap **MARK ARRIVED** | Trip status → `arrived`, socket event `trip.arrived` |
| 10 | Phone B: Tap **COMPLETE RESPONSE** | Trip status → `completed`, dispatch → `completed`, driver → `AVAILABLE`, trip saved to Neon |
| 11 | Phone B: History screen shows completed trip | Persists across app restart |
| 12 | Phone A: Report eventually → **RESOLVED** | Auto-expiry engine runs (accident = 2h) |

**PASS Criteria:** All steps complete without errors, data visible in Neon DB.

---

## Test AB: Fire Flow

Same as Test AA but:
- Phone A: Report type = **FIRE**
- Dispatch: `required_vehicle: "fire"` 🔥
- Only fire-type drivers receive it (vehicle-type filtering)

---

## Test AC: Road Blockage (No Dispatch)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Phone A: Submit **BLOCKED** report with photo | Report created, `lifecycle_state: ACTIVE` |
| 2 | Backend | No dispatch created — only accident/fire dispatch |
| 3 | Phone A: Badge shows **📍 Active** | Roadly map only |
| 4 | Phone B: Signal-Aid shows **no emergency jobs** | Zero dispatches |

**PASS Criteria:** Zero rows in `dispatches` table for this report.

---

## Test AD: Admin Resolve / Reject

| Step | Action | Expected |
|------|--------|----------|
| 1 | Phone A: Submit any report | Appears in dashboard Incidents list |
| 2 | Dashboard: Open **Details** → tap **Resolve** | Lifecycle → `RESOLVED`, disappears from active views |
| 3 | Dashboard: tap **Reject** on another incident | Lifecycle → `REJECTED` |
| 4 | Phone A: Badge updates via socket | Report card shows Resolved / Rejected |

---

## Test AE: Two Drivers Concurrency

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create one ACCIDENT dispatch (via Test AA steps 1-4) | Dispatch available |
| 2 | Phone B1 & B2: Both tap **ACCEPT JOB** simultaneously | One succeeds (200), other gets 409 "REQUEST ALREADY TAKEN" |
| 3 | Winner proceeds to response | Loser sees snackbar error |

---

## Test AF: Restart Persistence

| Step | Action | Expected |
|------|--------|----------|
| 1 | Phone B: Accept dispatch → Start response (GPS sending) | Trip in `en_route` |
| 2 | Phone B: Force-close app → Reopen Signal-Aid | `fetchActiveTrip` loads trip |
| 3 | Phone B: Resume on Response Screen | GPS continues, can mark arrived/complete |

---

## Backend Verification Commands

```bash
# Check health
curl https://clearpath-server.onrender.com/health

# View reports
curl https://clearpath-server.onrender.com/api/reports

# View dispatches
curl https://clearpath-server.onrender.com/api/dispatches

# View trips
curl https://clearpath-server.onrender.com/api/trips

# View users
curl https://clearpath-server.onrender.com/api/users

# View leaderboard
curl https://clearpath-server.onrender.com/api/leaderboard
```

---

## Expected Neon DB State After Test AA

```sql
-- road_reports
id | lifecycle_state | status
---|-----------------|-------
uuid | RESOLVED        | resolved

-- dispatches
id | report_id | required_vehicle | status | driver_id
---|-----------|------------------|--------|----------
uuid | uuid      | ambulance        | completed | uuid

-- emergency_trips
id | dispatch_id | driver_id | status | travel_time | distance
---|-------------|-----------|--------|-------------|---------
uuid | uuid        | uuid      | completed | 420       | 3.2

-- users (driver)
availability: AVAILABLE (reset after completion)
```

---

## Troubleshooting

| Issue | Check |
|-------|-------|
| No dispatch created | Incident type accident/fire? Check Render logs on submit |
| Photo not uploading | Supabase Storage bucket `report-photos` public? Service role key valid? |
| Socket not connecting | Render WebSocket support? Check `wss://` |
| Driver not seeing jobs | Driver logged in? `availability = AVAILABLE`? Right vehicle type? |
| GPS not updating | Location permission granted? `Geolocator` working? |

---

## Reset Between Tests

```bash
# Clear Neon tables (run locally with DATABASE_URL set)
cd backend
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query('DELETE FROM reward_events; DELETE FROM emergency_trips; DELETE FROM dispatches; DELETE FROM road_reports; DELETE FROM users;')
  .then(() => console.log('Cleared'))
  .catch(console.error)
  .finally(() => pool.end());
"
```

Then re-register users on both apps.
