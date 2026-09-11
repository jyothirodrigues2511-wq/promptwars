const { generateStructuredJSON } = require('./geminiService');
const { noKeyResponse, locateFallback } = require('./keylessFallback');

const LOCATION_SCHEMA = {
  type: 'object',
  properties: {
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    address: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
  },
  required: ['latitude', 'longitude', 'address', 'confidence'],
};

function isValidCoords(lat, lon) {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

async function extractLocationFromText(text) {
  if (noKeyResponse()) {
    return locateFallback(text);
  }

  const prompt = `You are a GIS geocoding assistant for disaster response.
The following unstructured message from a disaster zone may contain a location reference — a village name, street address, neighborhood, landmark, coordinates, or GPS reading.

Text:
"""${text}"""

Extract the best-estimate location and return structured JSON with:
- latitude: decimal latitude (or use the closest known coordinate for the named place)
- longitude: decimal longitude (or use the closest known coordinate for the named place)
- address: human-readable address / place description as stated
- confidence: 0-100 estimate of how precise this location is (100 = explicit coordinates, 0 = nowhere mentioned)

If no location can be determined at all, use 0, 0 and confidence 0.`;

  const result = await generateStructuredJSON(prompt, LOCATION_SCHEMA);
  const loc = JSON.parse(result);
  return loc;
}

module.exports = { extractLocationFromText, LOCATION_SCHEMA, isValidCoords };