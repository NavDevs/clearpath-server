# ClearPath Backend Architecture (Phase 1 Audit)

This document outlines the current working state of the ClearPath Node.js/Express backend, serving as the baseline for the upcoming AI/Dispatch integration.

## 1. Core Stack
*   **Runtime:** Node.js
*   **Framework:** Express.js
*   **Realtime:** Socket.IO
*   **Database:** PostgreSQL (Neon) with a dynamic fallback to SQLite for local development
*   **Storage:** Supabase Storage (for incident photos)
*   **Hosting:** Render (with cron-job.org keep-alive ping on `/health`)

## 2. File Structure
*   `server.js`: The monolithic entry point containing all Express REST routes, Socket.IO connections, Multer upload logic, Supabase SDK integration, and a simplistic auto-expiry background job.
*   `database.js`: Contains a unified data-access wrapper (`dbGet`, `dbAll`, `dbRun`) that seamlessly translates `?` parameterized queries into Postgres `$1` syntax, enabling the app to run on both SQLite and Postgres without code changes.

## 3. Existing Database Schema
The database currently consists of 4 primary tables:

1.  **users**
    *   `id` (TEXT PRIMARY KEY)
    *   `role` ('citizen', 'emergency_driver', 'admin')
    *   `phone`, `name`, `password` (For citizens)
    *   `driver_id`, `vehicle_no` (For emergency drivers)
    *   `points`, `created_at`
2.  **road_reports** (The core civilian incident model)
    *   `id`, `user_id`
    *   `type`, `description`
    *   `status` ('pending', 'verified', 'resolved')
    *   `latitude`, `longitude`, `address`
    *   `photo_url`
    *   `points`, `created_at`
3.  **emergency_trips** (The legacy Signal-Aid response model)
    *   `id`, `driver_id`, `vehicle_no`, `report_id`
    *   `criticality`, `travel_time`, `preemptions`, `confidence`, `distance`
    *   `started_at`
4.  **reward_events** (Audit trail for the leaderboard)
    *   `id`, `user_id`, `report_id`, `points`, `reason`, `created_at`

## 4. Existing REST API Endpoints
*   `POST /api/auth/register` - Registers a citizen
*   `POST /api/auth/login` - Authenticates a citizen
*   `POST /api/auth/signalaid` - Registers/authenticates an emergency driver using vehicle ID
*   `GET /api/reports` - Fetches all road reports
*   `POST /api/reports` - (Multipart form) Uploads image to Supabase, creates report, awards points, and broadcasts `new_incident`.
*   `POST /api/reports/:id/status` - Admin endpoint to mark a report verified/resolved.
*   `GET /api/trips` & `/api/trips/:driver_id` - Fetches trip history
*   `POST /api/trips` - Creates an emergency trip record
*   `GET /api/leaderboard` - Returns top 50 citizens by points
*   `GET /health` - Uptime ping endpoint

## 5. Existing Socket.IO Events
*   **Emitted by Backend:**
    *   `new_incident` (when a report is created)
    *   `report_updated` (when a report status changes or it auto-expires)
    *   `points_updated` (when a user earns points)
    *   `trip_completed` (when an emergency trip is saved)
    *   `admin_refresh` (internal UI trigger)
*   **Authentication:** Currently **NONE**. Sockets are completely open `origin: '*'`. (Identified as a gap for Phase 28).

## 6. Current Business Logic Deficiencies (To be solved by AI Integration)
1.  **No Decision Engine:** `POST /api/reports` immediately broadcasts `new_incident` to everyone. Signal-Aid currently treats all `road_reports` as active incidents, ignoring severity.
2.  **No AI:** The photo is uploaded to Supabase and immediately stored in the DB. There is no intermediary analysis.
3.  **No Dispatching:** Signal-Aid currently lacks a "Dispatch" concept. Drivers simply view all incidents and click one to create a `trip`. The backend does not route or assign jobs.
4.  **No Live Tracking:** The backend does not currently accept or broadcast live GPS coordinates from active Signal-Aid trips.

## 7. Next Steps for Database Evolution (Phase 2)
The database will need new tables/columns to support the AI and Dispatch workflow outlined in the master plan:
*   `ai_analyses` (to store the AI metadata separately from the human report)
*   `dispatches` (to manage the state machine of offering an emergency job to a driver and tracking acceptance)
*   Extensions to `emergency_trips` to support live GPS coordinate arrays or a new `driver_locations` table for the Socket.IO broadcast.
