const { dbRun, dbGet } = require('./database');
const { randomUUID: uuidv4 } = require('crypto');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

function normalizeUserType(type) {
  return String(type || '').trim().toLowerCase();
}

/**
 * Emergency dispatch is ONLY for explicit Accident / Fire reports
 * (or AI detecting those when the citizen picked a non-emergency type).
 * Accident → ambulance, Fire → fire truck.
 */
function resolveEmergencyVehicle(userType, detectedType) {
  const user = normalizeUserType(userType);
  const detected = String(detectedType || '').trim().toUpperCase();

  if (user === 'accident') return 'ambulance';
  if (user === 'fire') return 'fire';

  if (detected === 'ACCIDENT') return 'ambulance';
  if (detected === 'FIRE') return 'fire';

  return null;
}

/**
 * Analyzes a newly submitted road report using Groq vision,
 * then passes it to the decision engine.
 */
async function analyzeIncident(report, broadcastCallback) {
  try {
    console.log(`[AI Engine] Starting analysis for report ${report.id} (${report.type})...`);

    // Spec: ACTIVE -> PENDING_VERIFICATION during AI analysis.
    await dbRun("UPDATE road_reports SET lifecycle_state = 'PENDING_VERIFICATION', status = 'pending' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'PENDING_VERIFICATION', status: 'pending' });

    const prompt = `You are an emergency incident verification AI. Analyze this road incident report.
    User categorized it as: ${String(report.type || '').toUpperCase()}
    User description: ${report.description || 'None provided'}

    Use ONLY evidence present in the image (if any) and the description. Do NOT invent details that are not visible or stated.
    Assess whether this appears to be a genuine emergency.
    Output ONLY a raw JSON object with the following schema:
    {
      "detectedType": "ACCIDENT | FIRE | BLOCKED | CONGESTION | POTHOLE | OTHER",
      "severity": "LOW | MEDIUM | HIGH | CRITICAL",
      "confidence": 0.0 to 1.0,
      "verdict": "likely genuine | insufficient evidence | likely invalid",
      "peoplePossiblyInjured": boolean,
      "vehiclesInvolved": boolean,
      "roadBlocked": boolean,
      "emergencyResponseRecommended": boolean,
      "reason": "Brief 1-sentence explanation grounded ONLY in visible/stated evidence"
    }`;

    const content = [{ type: 'text', text: prompt }];

    if (report.photo_url) {
      content.push({
        type: 'image_url',
        image_url: { url: report.photo_url }
      });
    }

    const requestBody = {
      model: GROQ_MODEL,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      temperature: 0.1
    };

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API Error: ${response.status} - ${errText}`);
    }

    const jsonResponse = await response.json();
    const aiResult = JSON.parse(jsonResponse.choices[0].message.content);

    const analysisId = uuidv4();
    await dbRun(`INSERT INTO ai_analyses
      (id, report_id, detected_type, severity, confidence, people_injured, road_blocked, emergency_recommended, raw_reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        analysisId,
        report.id,
        aiResult.detectedType || report.type,
        aiResult.severity || 'LOW',
        aiResult.confidence ?? 0.5,
        aiResult.peoplePossiblyInjured || false,
        aiResult.roadBlocked || false,
        aiResult.emergencyResponseRecommended || false,
        `verdict=${aiResult.verdict || 'insufficient evidence'} | ${aiResult.reason || 'No reasoning provided.'}`
      ]
    );

    console.log(`[AI Engine] Analysis complete for ${report.id}. Confidence: ${aiResult.confidence}, verdict: ${aiResult.verdict}`);
    await runDecisionEngine(report, aiResult, broadcastCallback);
  } catch (error) {
    console.error(`[AI Engine] Failed to analyze report ${report.id}:`, error);

    // Critical emergencies NEVER wait: AI outage still dispatches from the
    // citizen's explicit accident/fire category. Normal issues go to review.
    if (isCriticalEmergency(report.type)) {
      console.log(`[AI Engine] AI unavailable — immediate ${report.type} dispatch from user category.`);
      await runDecisionEngine(report, {
        detectedType: normalizeUserType(report.type) === 'fire' ? 'FIRE' : 'ACCIDENT',
        severity: 'HIGH',
        confidence: 0.9,
        verdict: 'likely genuine',
        peoplePossiblyInjured: normalizeUserType(report.type) === 'accident',
        roadBlocked: true,
        emergencyResponseRecommended: true,
        reason: 'AI unavailable — dispatching from citizen emergency category.'
      }, broadcastCallback);
      return;
    }

    // Spec: do NOT pretend unverified incidents are genuine when AI is unavailable.
    // Route to human review so an admin can verify or reject.
    await dbRun("UPDATE road_reports SET lifecycle_state = 'HUMAN_REVIEW', status = 'pending' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'HUMAN_REVIEW', status: 'pending' });
  }
}

/**
 * Critical emergencies (accident / fire) bypass human review entirely:
 * REPORT -> AI ANALYSIS -> IMMEDIATE SIGNAL AID DISPATCH.
 */
function isCriticalEmergency(type) {
  const t = normalizeUserType(type);
  return t === 'accident' || t === 'fire';
}

/**
 * Spec decision engine:
 * - CRITICAL (accident/fire): REPORT -> AI ANALYSIS -> IMMEDIATE DISPATCH.
 *   Never waits for human approval. AI output only enriches priority.
 * - NORMAL issues: PENDING_VERIFICATION -> VERIFIED | HUMAN_REVIEW | REJECTED.
 *   Never create Signal-Aid dispatches.
 */
async function runDecisionEngine(report, aiResult, broadcastCallback) {
  console.log(`[Decision Engine] Evaluating report ${report.id}...`);

  const confidence = Number(aiResult.confidence ?? 0);
  const verdict = String(aiResult.verdict || 'insufficient evidence').toLowerCase();

  // ── Critical emergencies: dispatch immediately, no human gate. ──
  if (isCriticalEmergency(report.type)) {
    const requiredVehicle = resolveEmergencyVehicle(report.type, aiResult.detectedType);
    console.log(`[Decision Engine] Critical ${report.type} (confidence ${confidence}) -> immediate ${requiredVehicle} dispatch.`);
    await dbRun("UPDATE road_reports SET lifecycle_state = 'VERIFIED', status = 'verified' WHERE id = ?", [report.id]);
    const verifiedReport = { ...report, lifecycle_state: 'VERIFIED', status: 'verified' };
    broadcastCallback('report_updated', verifiedReport);
    broadcastCallback('new_incident', verifiedReport);
    await createDispatch(report, requiredVehicle, broadcastCallback);
    return;
  }

  // ── Normal road issues: confidence-gated, never dispatched. ──
  // Clearly invalid evidence -> REJECTED (do not broadcast as emergency).
  if (verdict.includes('invalid') || confidence < 0.40) {
    console.log(`[Decision Engine] Rejecting ${report.id}: verdict=${verdict}, confidence=${confidence}`);
    await dbRun("UPDATE road_reports SET lifecycle_state = 'REJECTED', status = 'rejected' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'REJECTED', status: 'rejected' });
    return;
  }

  // Unclear evidence -> HUMAN_REVIEW (admin verifies or rejects).
  if (verdict.includes('insufficient') || confidence < 0.70) {
    console.log(`[Decision Engine] Human review ${report.id}: verdict=${verdict}, confidence=${confidence}`);
    await dbRun("UPDATE road_reports SET lifecycle_state = 'HUMAN_REVIEW', status = 'pending' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'HUMAN_REVIEW', status: 'pending' });
    return;
  }

  // Genuine non-critical issue -> VERIFIED (visible on Roadly, no dispatch).
  console.log(`[Decision Engine] Verified ${report.id}: type=${report.type}, detected=${aiResult.detectedType}, confidence=${confidence}`);
  await dbRun("UPDATE road_reports SET lifecycle_state = 'VERIFIED', status = 'verified' WHERE id = ?", [report.id]);
  const verifiedReport = { ...report, lifecycle_state: 'VERIFIED', status: 'verified' };
  broadcastCallback('report_updated', verifiedReport);
  broadcastCallback('new_incident', verifiedReport);
}

/**
 * Creates the Signal-Aid emergency request for a verified critical incident
 * and moves it VERIFIED -> DISPATCHED. Carries the full incident evidence:
 * id, type, description, image, exact GPS, reported time and AI priority.
 */
async function createDispatch(report, requiredVehicle, broadcastCallback) {
  if (!requiredVehicle) return null;
  console.log(`[Decision Engine] Creating ${requiredVehicle} dispatch for ${report.id}.`);

  const existing = await dbGet('SELECT id FROM dispatches WHERE report_id = ?', [report.id]);
  let dispatchId = existing?.id;

  if (!dispatchId) {
    dispatchId = uuidv4();
    await dbRun(
      `INSERT INTO dispatches (id, report_id, required_vehicle, status) VALUES (?, ?, ?, 'available')`,
      [dispatchId, report.id, requiredVehicle]
    );
  }

  await dbRun("UPDATE road_reports SET lifecycle_state = 'DISPATCHED', status = 'verified' WHERE id = ?", [report.id]);

  const fullDispatch = await getDispatchPayload(dispatchId);

  const dispatchedReport = { ...report, lifecycle_state: 'DISPATCHED', status: 'verified' };
  broadcastCallback('report_updated', dispatchedReport);
  broadcastCallback('dispatch.created', fullDispatch);
  return fullDispatch;
}

/**
 * Full emergency request payload for Signal-Aid: incident id/type/description,
 * image, exact GPS, reported time, emergency priority and AI analysis result.
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
  const analysis = await dbGet(
    `SELECT detected_type, severity, confidence, emergency_recommended, raw_reasoning
     FROM ai_analyses WHERE report_id = ? ORDER BY created_at DESC LIMIT 1`,
    [fullDispatch.report_id]
  );
  return {
    ...fullDispatch,
    priority: analysis?.severity || 'HIGH',
    ai_detected_type: analysis?.detected_type || null,
    ai_confidence: analysis?.confidence ?? null,
    ai_severity: analysis?.severity || null,
    ai_emergency_recommended: analysis?.emergency_recommended ?? null,
    ai_reasoning: analysis?.raw_reasoning || null,
  };
}

module.exports = { analyzeIncident, createDispatch, getDispatchPayload, isCriticalEmergency, resolveEmergencyVehicle };
