#!/usr/bin/env bash
# ClearPath end-to-end workflow check.
#
# Drives the spec workflow against a running Command Server and prints the exact
# payloads the admin dashboard consumes, so "the dashboard works" can be verified
# rather than assumed:
#
#   citizen report -> ACTIVE -> PENDING_VERIFICATION -> HUMAN_REVIEW
#   new driver     -> registration request -> admin APPROVED
#   admin verify   -> VERIFIED -> DISPATCHED (fire dispatch created)
#   driver accepts -> dispatch ACCEPTED, trip EN_ROUTE with criticality + distance
#   driver arrives -> ARRIVED ; driver completes -> RESOLVED, driver AVAILABLE
#
# Usage: BASE=http://localhost:3200 ./scripts/e2e-admin-flow.sh

set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
STAMP="$(date +%s)"
PHONE="9${STAMP: -9}"

jq_get() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(String(eval('o'+process.argv[1])??''))}catch(e){console.log('')}})" "$1"; }

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "1. Admin login"
TOKEN=$(curl -s -X POST "$BASE/api/auth/admin/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"clearpath123"}' | jq_get '.token')
[ -n "$TOKEN" ] || { echo "admin login failed"; exit 1; }
echo "admin token acquired (${#TOKEN} chars)"

say "2. Citizen registers and reports a FIRE (must start ACTIVE)"
CITIZEN=$(curl -s -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"password\":\"testpass123\",\"name\":\"E2E Reporter\"}" | jq_get '.user.id')
REPORT=$(curl -s -X POST "$BASE/api/reports" \
  -F "user_id=$CITIZEN" -F "type=fire" -F "description=E2E: building fire near the market" \
  -F "latitude=13.0827" -F "longitude=80.2707" -F "address=E2E Test Junction")
REPORT_ID=$(echo "$REPORT" | jq_get '.id')
echo "report created: $REPORT_ID (initial lifecycle_state=$(echo "$REPORT" | jq_get '.lifecycle_state'))"
sleep 3   # let the AI verification stage resolve (falls to HUMAN_REVIEW when no AI key)

say "3. Driver registers (must stay pending, cannot self-approve)"
curl -s -X POST "$BASE/api/auth/driver/register" -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E Fire Driver\",\"phone\":\"8${STAMP: -9}\",\"driver_id\":\"E2E-FIRE-$STAMP\",\"vehicle_no\":\"FIRE-$STAMP\",\"vehicle_type\":\"fire\",\"organization\":\"E2E Fire Station\"}" \
  | jq_get '.message'
REQ_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/driver-requests" | jq_get '[0].id')
echo "pending request: $REQ_ID"
curl -s -X POST "$BASE/api/auth/driver/login" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":\"E2E-FIRE-$STAMP\",\"vehicle_no\":\"FIRE-$STAMP\"}" | jq_get '.error' | sed 's/^/  login before approval -> /'

say "4. Admin approves the driver"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/driver-requests/$REQ_ID/approve" | jq_get '.message'

say "5. Admin verifies the incident -> dispatch must be created"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/incidents/$REPORT_ID/verify" \
  | jq_get '.report.lifecycle_state' | sed 's/^/  incident lifecycle now: /'
DISPATCH_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/dispatches" | jq_get '.find(d=>d.report_id==="'"$REPORT_ID"'").id')
REQUIRED=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/dispatches" | jq_get '.find(d=>d.report_id==="'"$REPORT_ID"'").required_vehicle')
echo "  dispatch $DISPATCH_ID requires: $REQUIRED"

say "6. Driver signs in, goes AVAILABLE, reports location"
DRIVER_TOKEN=$(curl -s -X POST "$BASE/api/auth/driver/login" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":\"E2E-FIRE-$STAMP\",\"vehicle_no\":\"FIRE-$STAMP\"}" | jq_get '.token')
curl -s -X PATCH "$BASE/api/driver/availability" -H "Authorization: Bearer $DRIVER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"availability":"AVAILABLE"}' | jq_get '.availability' | sed 's/^/  availability: /'
curl -s -X PATCH "$BASE/api/driver/location" -H "Authorization: Bearer $DRIVER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"latitude":13.0500,"longitude":80.2500}' >/dev/null

say "7. Driver accepts (first-to-accept wins)"
curl -s -X POST "$BASE/api/dispatches/$DISPATCH_ID/accept" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":\"E2E-FIRE-$STAMP\",\"vehicle_no\":\"FIRE-$STAMP\",\"criticality\":\"critical\"}" \
  | jq_get '.id' | sed 's/^/  trip: /'
echo "  second accept attempt ->"
curl -s -X POST "$BASE/api/dispatches/$DISPATCH_ID/accept" -H 'Content-Type: application/json' \
  -d "{\"driver_id\":\"E2E-FIRE-$STAMP\",\"vehicle_no\":\"FIRE-$STAMP\"}" | jq_get '.error' | sed 's/^/  /'

say "8. Admin dashboard: Signal-Aid trips (criticality/time/distance must not be blank)"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/trips" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const rows=JSON.parse(d);
  if(!rows.length) return console.log('  (no trips)');
  for(const t of rows) console.log('  driver='+(t.driver_name||t.driver_id)+' vehicle='+(t.vehicle_no||'-')+' incident='+(t.incident_type||'-')+' criticality='+(t.criticality??'-')+' confidence='+(t.confidence??'-')+' distance='+(t.distance??'-')+' status='+(t.status??'-'));
});"

say "9. Admin dashboard: approvals, vehicles, incidents, dispatches, users"
for ep in driver-requests drivers incidents dispatches users stats; do
  printf '  /api/admin/%-16s -> %s\n' "$ep" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/$ep")"
done

say "10. Driver arrives, then completes -> incident RESOLVED, driver freed"
TRIP_ID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/trips" | jq_get '[0].id')
curl -s -X PATCH "$BASE/api/trips/$TRIP_ID/status" -H 'Content-Type: application/json' \
  -d "{\"status\":\"arrived\",\"driver_id\":\"E2E-FIRE-$STAMP\"}" | jq_get '.status' | sed 's/^/  trip status: /'
curl -s -X PATCH "$BASE/api/trips/$TRIP_ID/status" -H 'Content-Type: application/json' \
  -d "{\"status\":\"completed\",\"driver_id\":\"E2E-FIRE-$STAMP\"}" | jq_get '.status' | sed 's/^/  trip status: /'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/incidents" | jq_get '.find(r=>r.id==="'"$REPORT_ID"'").lifecycle_state' | sed 's/^/  incident: /'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/drivers" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d)[0];if(r)console.log('  driver '+r.driver_id+' availability='+r.availability+' approval='+r.approval_status);});"

say "11. Admin-only guard on availability + RLS-style protection"
printf '  no token  -> %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/users/whatever/availability" -H 'Content-Type: application/json' -d '{"availability":"BUSY"}')"
printf '  with token-> %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/users/$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/drivers" | jq_get '[0].id')/availability" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"availability":"AVAILABLE"}')"

say "Done"
