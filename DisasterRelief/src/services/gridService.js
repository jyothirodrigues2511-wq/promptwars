const { SECTORS, SECTOR_MAP, sectorById, nearestSector, haversineKm } = require('../data/sectorMatrix');
const { generateStructuredJSON, hasLLMBackend } = require('./geminiService');

const EXTERNAL_SECTOR = { id: 'EXT', name: 'External Regional Zone' };
const EXTERNAL_THRESHOLD_KM = 60;

function isExternalSector(id) {
  return id === EXTERNAL_SECTOR.id;
}

const GRID_SCHEMA = {
  type: 'object',
  properties: {
    sector_id: {
      type: 'string',
      enum: [...SECTORS.map((s) => s.id), EXTERNAL_SECTOR.id],
      description: 'Grid Sector ID (A1-D4) of the named location, or "EXT" when the place is clearly OUTSIDE the greater Seattle grid (e.g. "Bengaluru", "Dandeli").',
    },
    sector_name: { type: 'string' },
    matched_landmark: { type: 'string', description: 'The landmark/street/place text that was matched.' },
    confidence: { type: 'number', minimum: 0, maximum: 100, description: 'Confidence in the grid classification.' },
    external_latitude: { type: 'number', description: 'Only when sector_id is EXT: approximate latitude of the external place.' },
    external_longitude: { type: 'number', description: 'Only when sector_id is EXT: approximate longitude of the external place.' },
    external_region: { type: 'string', description: 'Only when sector_id is EXT: region/city name of the external place (e.g. "Bengaluru, India").' },
  },
  required: ['sector_id', 'sector_name', 'matched_landmark', 'confidence'],
};

const SECTOR_CONTEXT = SECTORS.map(
  (s) => `${s.id}: ${s.name} (approx. lat ${s.latitude.toFixed(3)}, lon ${s.longitude.toFixed(3)})`
).join('\n');

const KEYWORD_MAP = [
  {
    sector: 'B2',
    keywords: ['city hall', 'downtown', 'belltown', 'financial district', 'seneca', '2nd ave', 'central business'],
  },
  {
    sector: 'C2',
    keywords: ['harbor', 'waterfront', 'pier', 'pioneer square', 'ferry line', 'seawall', '4th ave', '4th avenue', 'bridge'],
  },
  {
    sector: 'A3',
    keywords: ['university district', 'uw campus', 'university of washington', 'ravenna', 'u district'],
  },
  {
    sector: 'B3',
    keywords: ['capitol hill', 'first hill', 'broadway', 'central', 'caltrain', 'hospital'],
  },
  {
    sector: 'A2',
    keywords: ['fremont', 'wallingford', 'greenlake', 'north central'],
  },
  {
    sector: 'A1',
    keywords: ['ballard', 'salmon bay', 'north west', 'market street'],
  },
  {
    sector: 'A4',
    keywords: ['lake city', 'northgate', 'north east', 'sand point', 'maple leaf'],
  },
  {
    sector: 'B1',
    keywords: ['queen anne', 'interbay', 'magnolia'],
  },
  {
    sector: 'B4',
    keywords: ['madison valley', 'central district', 'madrona', 'leschi'],
  },
  {
    sector: 'C1',
    keywords: ['west seattle', 'junction', 'junction bridge', 'delridge'],
  },
  {
    sector: 'C3',
    keywords: ['beacon hill', 'north beacon', 'light rail ridge'],
  },
  {
    sector: 'C4',
    keywords: ['rainier valley', 'rainier ave', 'columbia city'],
  },
  {
    sector: 'D2',
    keywords: ['sodo', 'georgetown', 'stadium district', 'stadiums'],
  },
  {
    sector: 'D3',
    keywords: ['boeing field', 'south park', 'industrial south', 'river south'],
  },
  {
    sector: 'D4',
    keywords: ['seattle tacoma', 'seatac', 'airport', 'international'],
  },
  {
    sector: 'D1',
    keywords: ['fauntleroy', 'alki', 'west seattle ferry', 'south west seattle'],
  },
];

function matchKeywordSector(text) {
  const lower = String(text || '').toLowerCase();
  for (const { sector, keywords } of KEYWORD_MAP) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        const s = sectorById(sector);
        return { sector_id: s.id, sector_name: s.name, matched_landmark: kw, confidence: 70, method: 'keyword' };
      }
    }
  }
  return null;
}

async function gridFromText(text, opts = { useGemini: true }) {
  const kw = matchKeywordSector(text);
  if (kw && !opts.useGemini) return kw;

  let gemini = null;
  if (opts.useGemini && hasLLMBackend()) {
    try {
      const prompt = `You are a disaster-response GIS grid classifier.
An unstructured crisis message references a place (neighborhood, street, landmark, or district).
Classify it into ONE grid sector using this fixed Sector Matrix:
${SECTOR_CONTEXT}

Rules:
- Match known Seattle-area sectors (A1 through D4) when the place belongs to that area.
- If the referenced place is CLEARLY outside this grid's coverage (another city, state, or country —
  e.g. "Bengaluru", "Dandeli", "Chennai"), return sector_id "EXT", sector_name "External Regional Zone",
  and provide external_latitude / external_longitude / external_region for that place.
- Never shoehorn an external place into a Seattle sector.

Message:
"""${text}"""

Return the matching grid sector with a confidence score. If nothing is resolvable, use sector "EXT"
with confidence 10 and matched_landmark "not detected".`;
      const result = await generateStructuredJSON(prompt, GRID_SCHEMA);
      const parsed = JSON.parse(result);
      if (isExternalSector(parsed.sector_id)) {
        gemini = {
          sector_id: EXTERNAL_SECTOR.id,
          sector_name: parsed.external_region || EXTERNAL_SECTOR.name,
          matched_landmark: parsed.matched_landmark || text.slice(0, 60),
          confidence: Math.max(parsed.confidence, 15),
          method: 'gemini',
          external_latitude: parsed.external_latitude,
          external_longitude: parsed.external_longitude,
          external_region: parsed.external_region,
        };
      } else if (sectorById(parsed.sector_id) && parsed.confidence > 10) {
        gemini = {
          sector_id: parsed.sector_id,
          sector_name: parsed.sector_name || sectorById(parsed.sector_id).name,
          matched_landmark: parsed.matched_landmark || text.slice(0, 60),
          confidence: parsed.confidence,
          method: 'gemini',
        };
      }
    } catch (err) {
      console.warn('Gemini grid parser unavailable:', err.message);
    }
  }

  return gemini || kw || { sector_id: EXTERNAL_SECTOR.id, sector_name: EXTERNAL_SECTOR.name, matched_landmark: 'not detected', confidence: 10, method: 'fallback' };
}

function gridFromCoords(lat, lng) {
  const s = nearestSector(lat, lng);
  if (!s) return null;
  const distanceKm = haversineKm(lat, lng, s.latitude, s.longitude);
  if (distanceKm > EXTERNAL_THRESHOLD_KM) {
    return {
      sector_id: EXTERNAL_SECTOR.id,
      sector_name: EXTERNAL_SECTOR.name,
      matched_landmark: 'coordinates',
      confidence: 90,
      method: 'coords',
      external_latitude: lat,
      external_longitude: lng,
    };
  }
  return {
    sector_id: s.id,
    sector_name: s.name,
    matched_landmark: 'coordinates',
    confidence: 98,
    method: 'coords',
  };
}

function proximityIndexToSectorList(sectorId, depots) {
  const { proximityIndex } = require('../data/sectorMatrix');
  return depots.map((d) => ({
    id: d.id,
    name: d.name,
    primary_sector: d.primary_sector || null,
    proximity_index: proximityIndex(sectorId, d),
  }));
}

module.exports = {
  GRID_SCHEMA,
  SECTOR_CONTEXT,
  KEYWORD_MAP,
  EXTERNAL_SECTOR,
  EXTERNAL_THRESHOLD_KM,
  isExternalSector,
  matchKeywordSector,
  gridFromText,
  gridFromCoords,
  proximityIndexToSectorList,
  SECTOR_MAP,
  sectorById,
};