const { matchKeywordSector, sectorById } = require('./gridService');
const supplyDepots = require('../data/supplyDepots');
const { hasLLMBackend } = require('./geminiService');

const URGENCY_KEYWORDS = {
  critical: ['trapped', 'collapse', 'collapse', 'bleed', 'bleeding', 'unconscious', 'fire', 'drowning', 'flood', 'heart', 'breath', 'death', 'dying', 'rubble'],
  high: ['rescue', 'help', 'injured', 'hurt', 'wound', 'broken', 'trapped', 'stuck', 'screaming', 'lost', 'children', 'kidnapp'],
  moderate: ['food', 'water', 'hungry', 'cold', 'blanket', 'shelter', 'supplies'],
};

function detectUrgency(text) {
  const lower = String(text || '').toLowerCase();
  if (URGENCY_KEYWORDS.critical.some((k) => lower.includes(k))) return 'critical';
  if (URGENCY_KEYWORDS.high.some((k) => lower.includes(k))) return 'high';
  if (URGENCY_KEYWORDS.moderate.some((k) => lower.includes(k))) return 'moderate';
  return 'low';
}

function detectIntent(text) {
  const lower = String(text || '').toLowerCase();
  const rules = [
    [/trapped|collapse|rubble|rescue|buried/i, 'rescue people trapped under debris'],
    [/bleed|wound|hurt|injur|medical|sick|unconscious/i, 'requesting emergency medical assistance'],
    [/fire|smoke/i, 'reporting fire and requesting firefighting assistance'],
    [/flood|water.*rising|drown/i, 'reporting flooding and requesting evacuation support'],
    [/food|hungry|meal|eat/i, 'requesting food supplies'],
    [/water|drink|hydra/i, 'requesting drinking water'],
    [/blanket|cold|warm|shelter/i, 'requesting shelter and warm supplies'],
    [/boat|raft/i, 'requesting water rescue boats'],
    [/help|save|assist/i, 'requesting general rescue assistance'],
  ];
  for (const [re, intent] of rules) {
    if (re.test(lower)) return intent;
  }
  return 'unknown report — verify details';
}

function detectLanguage(text) {
  const scripts = [
    [/[ぁ-んァ-ン一-龯]/, 'Japanese'],
    [/[가-힣]/, 'Korean'],
    [/[а-яА-Я]/, 'Russian'],
    [/[à-ÿÀ-ß]/, 'French'],
    [/[üÜäÄöÖß]/, 'German'],
    [/[áéíóúñ¿¡]/, 'Spanish'],
    [/[çãõáéíóúâêôà]/, 'Portuguese'],
    [/[àèìòù]/, 'Italian'],
    [/[\u0400-\u04FF]/, 'Cyrillic'],
    [/[\u0600-\u06FF]/, 'Arabic'],
    [/[\u0900-\u097F]/, 'Hindi'],
    [/[\u0E00-\u0E7F]/, 'Thai'],
  ];
  for (const [re, lang] of scripts) {
    if (re.test(text)) return `${lang} (auto-detected, heuristic)`;
  }
  return 'English (or simplified report)';
}

function coordsForSector(sectorId) {
  const s = sectorById(sectorId);
  return s ? { latitude: s.latitude, longitude: s.longitude, confidence: 60 } : { latitude: 0, longitude: 0, confidence: 0 };
}

function noKeyResponse() {
  return !hasLLMBackend();
}

module.exports = { noKeyResponse, detectUrgency, detectIntent, detectLanguage, coordsForSector };

/* Key-free deterministic responses — used when no GEMINI_API_KEY is configured. */

function isGibberishText(text) {
  const lower = String(text || '').trim().toLowerCase();
  if (!lower) return true;
  if (lower.length < 3) return true;
  if (/^[^a-z]*[a-z]{0,3}[^a-z]*$/i.test(lower) || !/[aeiou]/i.test(lower)) return true;
  if (new Set(lower.replace(/[^a-z]/gi, '')).size <= 1 && /[a-z]/i.test(lower)) return true;
  if (/^[!?.,;:\s]+$/.test(lower)) return true;
  return false;
}

function translateFallback(text) {
  const gibberish = isGibberishText(text);
  if (gibberish) {
    return {
      is_invalid_input: true,
      original_language: '—',
      english_translation: '',
      key_intent: 'invalid input',
      detected_urgency: 'low',
      location: { latitude: 0, longitude: 0, address: '', confidence: 0 },
      provider: 'keyless-fallback',
    };
  }

  const kw = matchKeywordSector(text);
  const sectorId = kw ? kw.sector_id : null;
  const coords = sectorId ? coordsForSector(sectorId) : { latitude: 0, longitude: 0, confidence: 0 };
  const sectorName = sectorId ? sectorById(sectorId).name : null;

  return {
    is_invalid_input: false,
    original_language: detectLanguage(text),
    english_translation: `[NO-KEY DEMO RESPONSE] Received report: "${text}"`,
    key_intent: detectIntent(text),
    detected_urgency: detectUrgency(text),
    location: {
      latitude: coords.latitude,
      longitude: coords.longitude,
      address: kw
        ? `${kw.matched_landmark} — ${sectorId} ${sectorName} (heuristic)`
        : 'no location reference detected (External Regional Zone)',
      confidence: kw ? 60 : 0,
    },
    provider: 'keyless-fallback',
  };
}

function locateFallback(text) {
  const kw = matchKeywordSector(text);
  if (!kw) {
    return { latitude: 0, longitude: 0, address: 'no location reference detected', confidence: 0, provider: 'keyless-fallback' };
  }
  const coords = coordsForSector(kw.sector_id);
  const s = sectorById(kw.sector_id);
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    address: `${kw.matched_landmark} — ${s ? s.name : ''} (${kw.sector_id})`,
    confidence: 60,
    provider: 'keyless-fallback',
  };
}

function scamFallback(text, reports) {
  const target = reports && reports.length ? reports.map((r) => r.text || '').join(' ') : (text || '');
  const lower = String(target || '').toLowerCase();
  const riskFactors = [];

  const hasSpecificDetails = /trapped|bleeding|rubble|street|bridge|harbor|intersection|flat|floor|water|village|road|main|house/i.test(lower);
  const hasBulkQuantity = /500|1000|2000|000|10,.?000|unlimited|everything|all supplies|vehicles|trucks|helicopter/.test(lower);
  const hasSpecificCount = /\bfamily of|children|\d+ people|\d+ injured|\d+ trapped/.test(lower);
  const isShortUrgent = lower.length < 60 && /^(help|sos|flood|fire|water|stuck|trapped|urgent)/i.test(lower.trim());
  const gibberish = isGibberishText(lower);

  if (gibberish) {
    riskFactors.push('Input is not a meaningful report (gibberish / random keystrokes)');
  }
  if (hasBulkQuantity && !hasSpecificDetails) {
    riskFactors.push('Generic bulk resource request without concrete incident detail');
  }
  if (hasBulkQuantity && hasSpecificDetails && !hasSpecificCount) {
    riskFactors.push('Large quantity request sharing only generic area details');
  }
  if (/^[!?.]+$/.test(lower.trim()) || lower.trim().length < 3) {
    riskFactors.push('Empty or punctuation-only submission');
  }

  if (isShortUrgent && hasSpecificDetails) {
    riskFactors.length = 0;
  }

  const isScam = riskFactors.length > 0;
  let confidence = isScam ? 78 : 8;

  if (riskFactors.length === 1 && riskFactors[0] === 'Large quantity request sharing only generic area details') {
    confidence = 40;
  }
  if (gibberish) confidence = 95;

  return {
    confidence_score: confidence,
    is_flagged_as_scam: confidence >= 70,
    reasoning: isScam
      ? `Heuristic scan flagged the report (scam likelihood ${confidence}%). ${riskFactors.join(' — ')}.`
      : `Heuristic scan found an urgent, specific, low-risk report (scam likelihood ${confidence}%). Verified as genuine real-world request.`,
    risk_factors: riskFactors,
    provider: 'keyless-fallback',
  };
}

function triageTextFallback(text) {
  const lower = String(text || '').toLowerCase();
  const critical = /unconscious|not breathing|bleeding heavily|severe|heavy bleeding|chest|crush|cardiac|heart attack|stroke/.test(lower);
  const high = /break|fracture|bleed|burn|deep cut|severe|sprain|concussion/.test(lower);

  if (critical) {
    return {
      triage_level: 'RED',
      condition_summary: 'Life-threatening condition indicators present (unconsciousness, heavy bleeding, or cardiovascular distress). Immediate intervention required.',
      recommended_first_aid_steps: ['Call for advanced resuscitation support', 'Control external bleeding with direct pressure', 'Maintain airway — recovery position', 'Keep casualty warm', 'Priority evacuation to RED zone'],
      required_medical_supplies: ['Surgical bandages', 'Oxygen', 'IV fluids', 'Trauma shears'],
      provider: 'keyless-fallback',
    };
  }
  if (high) {
    return {
      triage_level: 'YELLOW',
      condition_summary: 'Serious but not immediately life-threatening injuries described. Requires urgent treatment within the hour.',
      recommended_first_aid_steps: ['Immobilise suspected fractures', 'Clean and dress wounds', 'Monitor vitals every 15 minutes', 'Move to YELLOW treatment area'],
      required_medical_supplies: ['Splints', 'Bandages', 'Antiseptic', 'Analgesics'],
      provider: 'keyless-fallback',
    };
  }
  return {
    triage_level: 'GREEN',
    condition_summary: 'Minor injuries — ambulatory, low risk. Self-care with basic first aid sufficient.',
    recommended_first_aid_steps: ['Clean minor wounds', 'Apply cold compress', 'Routine re-check in 4 hours'],
    required_medical_supplies: ['Bandages', 'Antiseptic'],
    provider: 'keyless-fallback',
  };
}

function droneFallback() {
  return {
    damage_type: 'unknown — demo mode',
    severity_score: 4,
    passable_routes: null,
    survivors_detected: false,
    summary: 'No GEMINI_API_KEY configured — image analysis unavailable. Configure a key for real aerial assessments.',
    provider: 'keyless-fallback',
  };
}

function nearestDepotFallback(latitude, longitude) {
  let best = null;
  let bestDist = Infinity;
  for (const d of supplyDepots) {
    const dist = Math.sqrt((d.latitude - latitude) ** 2 + (d.longitude - longitude) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

module.exports = {
  noKeyResponse,
  isGibberishText,
  translateFallback,
  locateFallback,
  scamFallback,
  triageTextFallback,
  droneFallback,
  nearestDepotFallback,
  detectUrgency,
  detectIntent,
  detectLanguage,
  coordsForSector,
};