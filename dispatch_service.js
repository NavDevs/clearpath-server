// Emergency dispatch helpers — dispatch is driven by the citizen's explicit
// accident/fire report type; nothing is inferred.
const { dbRun, dbGet } = require('./database');
const { randomUUID: uuidv4 } = require('crypto');

function normalizeUserType(type) {
  return String(type || '').trim().toLowerCase();
}

/**
 * Critical emergencies (accident / fire) go straight to Signal-Aid.
 * Everything else is a normal road issue: visible for its full duration,
 * never dispatched.
 */
function isCriticalEmergency(type) {
  const t = normalizeUserType(type);
  return t === 'accident' || t === 'fire';
}

/** Accident -> ambulance, Fire -> fire truck. Anything else -> null. */
function resolveEmergencyVehicle(userType) {
  const user = normalizeUserType(userType);
  if (user === 'accident') return 'ambulance';
  if (user === 'fire') return 'fire';
  return null;
}

/**
 * Creates the Signal-Aid emergency request and moves the incident
 * ACTIVE -> DISPATCHED. Carries the full incident evidence: id, type,
 * description, image, exact GPS, reported time and emergency priority.
 */
async function createDispatch(report, requiredVehicle, broadcastCallback) {
  if (!requiredVehicle) return null;
  console.log(`[Dispatch] Creating ${requiredVehicle} dispatch for ${report.id}.`);

  const existing = await dbGet('SELECT id, status FROM dispatches WHERE report_id = ?', [report.id]);
  let dispatchId = existing?.id;

  if (existing && (existing.status === 'cancelled' || existing.status === 'completed')) {
    // The only dispatch for this incident is dead — revive it instead of
    // leaving a DISPATCHED report nothing can be claimed from. (An 'accepted'
    // dispatch is a driver mid-response and is left alone.)
    await dbRun(
      "UPDATE dispatches SET status = 'available', driver_id = NULL, required_vehicle = ?, updated_at = ? WHERE id = ?",
      [requiredVehicle, new Date().toISOString(), existing.id]
    );
    dispatchId = existing.id;
  } else if (!dispatchId) {
    dispatchId = uuidv4();
    await dbRun(
      `INSERT INTO dispatches (id, report_id, required_vehicle, status) VALUES (?, ?, ?, 'available')`,
      [dispatchId, report.id, requiredVehicle]
    );
  }

  await dbRun("UPDATE road_reports SET lifecycle_state = 'DISPATCHED', status = 'pending' WHERE id = ?", [report.id]);

  const fullDispatch = await getDispatchPayload(dispatchId);

  const dispatchedReport = { ...report, lifecycle_state: 'DISPATCHED', status: 'pending' };
  broadcastCallback('report_updated', dispatchedReport);
  broadcastCallback('dispatch.created', fullDispatch);
  return fullDispatch;
}

/**
 * Full emergency request payload for Signal-Aid: incident id/type/description,
 * image, exact GPS, reported time and emergency priority.
 */
async function getDispatchPayload(dispatchId) {
  const fullDispatch = await dbGet(`
    SELECT d.*, r.latitude, r.longitude, r.type, r.description, r.address,
           r.photo_url, r.created_at AS reported_at, r.points
    FROM dispatches d
    JOIN road_reports r ON d.report_id = r.id
    WHERE d.id = ?`, [dispatchId]
  );
  if (!fullDispatch) return null;
  return { ...fullDispatch, priority: 'HIGH' };
}

module.exports = { createDispatch, getDispatchPayload, isCriticalEmergency, resolveEmergencyVehicle };
