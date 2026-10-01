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

    await dbRun("UPDATE road_reports SET lifecycle_state = 'AI_ANALYZED' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'AI_ANALYZED' });

    const prompt = `You are a smart city traffic AI. Analyze this road incident report.
    User categorized it as: ${String(report.type || '').toUpperCase()}
    User description: ${report.description || 'None provided'}
    
    Assess the situation based on the text and the provided image (if any).
    Output ONLY a raw JSON object with the following schema:
    {
      "detectedType": "ACCIDENT | FIRE | BLOCKED | CONGESTION | POTHOLE | OTHER",
      "severity": "LOW | MEDIUM | HIGH | CRITICAL",
      "confidence": 0.0 to 1.0,
      "peoplePossiblyInjured": boolean,
      "vehiclesInvolved": boolean,
      "roadBlocked": boolean,
      "emergencyResponseRecommended": boolean,
      "reason": "Brief 1-sentence explanation of your assessment"
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
        aiResult.confidence || 0.5,
        aiResult.peoplePossiblyInjured || false,
        aiResult.roadBlocked || false,
        aiResult.emergencyResponseRecommended || false,
        aiResult.reason || 'No reasoning provided.'
      ]
    );

    console.log(`[AI Engine] Analysis complete for ${report.id}. Confidence: ${aiResult.confidence}`);
    await runDecisionEngine(report, aiResult, broadcastCallback);
  } catch (error) {
    console.error(`[AI Engine] Failed to analyze report ${report.id}:`, error);

    // Citizen explicitly chose Accident / Fire → still alert Signal-Aid
    const requiredVehicle = resolveEmergencyVehicle(report.type, null);
    if (requiredVehicle) {
      console.log(`[AI Engine] Fallback: trusting user type "${report.type}" → ${requiredVehicle}`);
      await runDecisionEngine(report, {
        detectedType: requiredVehicle === 'fire' ? 'FIRE' : 'ACCIDENT',
        severity: 'HIGH',
        confidence: 0.9,
        peoplePossiblyInjured: requiredVehicle === 'ambulance',
        roadBlocked: true,
        emergencyResponseRecommended: true,
        reason: 'AI unavailable — dispatching from citizen emergency category.'
      }, broadcastCallback);
      return;
    }

    // Non-emergency: still show on Roadly map
    await dbRun("UPDATE road_reports SET lifecycle_state = 'ACTIVE' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'ACTIVE' });
    broadcastCallback('new_incident', { ...report, lifecycle_state: 'ACTIVE' });
  }
}

/**
 * Validates the AI results and determines if an emergency dispatch should be created.
 * ONLY Accident → ambulance and Fire → fire create Signal-Aid jobs.
 */
async function runDecisionEngine(report, aiResult, broadcastCallback) {
  console.log(`[Decision Engine] Evaluating report ${report.id}...`);

  const CONFIDENCE_THRESHOLD = 0.70;
  const userType = normalizeUserType(report.type);
  const isExplicitEmergency = userType === 'accident' || userType === 'fire';

  // Explicit Accident/Fire from citizen always dispatches (planned behavior).
  // Other types need AI confidence + ACCIDENT/FIRE detection.
  if (!isExplicitEmergency && (aiResult.confidence || 0) < CONFIDENCE_THRESHOLD) {
    console.log(`[Decision Engine] Low confidence (${aiResult.confidence}). Flagging for review.`);
    await dbRun("UPDATE road_reports SET lifecycle_state = 'NEEDS_REVIEW' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'NEEDS_REVIEW' });
    return;
  }

  const requiredVehicle = resolveEmergencyVehicle(report.type, aiResult.detectedType);

  if (requiredVehicle) {
    console.log(`[Decision Engine] Verified Emergency! Creating ${requiredVehicle} dispatch.`);

    await dbRun("UPDATE road_reports SET lifecycle_state = 'VERIFIED', status = 'verified' WHERE id = ?", [report.id]);

    const existing = await dbGet('SELECT id FROM dispatches WHERE report_id = ?', [report.id]);
    let dispatchId = existing?.id;

    if (!dispatchId) {
      dispatchId = uuidv4();
      await dbRun(
        `INSERT INTO dispatches (id, report_id, required_vehicle, status) VALUES (?, ?, ?, 'available')`,
        [dispatchId, report.id, requiredVehicle]
      );
    }

    const fullDispatch = await dbGet(`
      SELECT d.*, r.latitude, r.longitude, r.type, r.description, r.address, r.photo_url
      FROM dispatches d 
      JOIN road_reports r ON d.report_id = r.id 
      WHERE d.id = ?`, [dispatchId]
    );

    broadcastCallback('report_updated', { ...report, lifecycle_state: 'VERIFIED', status: 'verified' });
    broadcastCallback('new_incident', { ...report, lifecycle_state: 'VERIFIED', status: 'verified' });
    broadcastCallback('dispatch.created', fullDispatch);
  } else {
    console.log(`[Decision Engine] Standard incident (no Signal-Aid dispatch). Marking active.`);
    await dbRun("UPDATE road_reports SET lifecycle_state = 'ACTIVE' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'ACTIVE' });
    broadcastCallback('new_incident', { ...report, lifecycle_state: 'ACTIVE' });
  }
}

module.exports = { analyzeIncident };
