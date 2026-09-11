const { extractLocationFromText, isValidCoords } = require('../services/locationService');
const { findNearestRoute } = require('../services/routingService');
const supplyDepots = require('../data/supplyDepots');

async function resolveVictimLocation(victim) {
  if (victim && isValidCoords(victim.latitude, victim.longitude)) {
    return { latitude: victim.latitude, longitude: victim.longitude };
  }
  if (victim && (victim.place || victim.address)) {
    const loc = await extractLocationFromText(victim.place || victim.address);
    if (loc && loc.confidence > 0 && isValidCoords(loc.latitude, loc.longitude)) {
      return { latitude: loc.latitude, longitude: loc.longitude, address: loc.address };
    }
  }
  if (victim && victim.text) {
    const loc = await extractLocationFromText(victim.text);
    if (loc && loc.confidence > 0 && isValidCoords(loc.latitude, loc.longitude)) {
      return { latitude: loc.latitude, longitude: loc.longitude, address: loc.address };
    }
  }
  const err = new Error(
    'Could not determine a valid victim location. Provide latitude/longitude or a text description with a place reference.'
  );
  err.status = 400;
  throw err;
}

async function routeSupplies(req, res) {
  try {
    const { victim, requested_items = [], depots = supplyDepots } = req.body || {};

    const coords = await resolveVictimLocation(victim);
    if (!Array.isArray(depots) || depots.length === 0) {
      return res.status(400).json({ error: 'At least one supply depot is required.' });
    }

    const route = await findNearestRoute(coords, depots, requested_items);

    res.json({
      victim_location: coords,
      requested_items,
      route,
    });
  } catch (err) {
    console.error('Route supplies error:', err);
    res.status(err.status || 500).json({
      error: 'Route calculation failed.',
      detail: err.message,
    });
  }
}

async function locateFromText(req, res) {
  try {
    const { text } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: 'Text field is required.' });
    }
    const loc = await extractLocationFromText(text);
    res.json(loc);
  } catch (err) {
    console.error('Locate error:', err);
    res.status(500).json({ error: 'Location extraction failed.', detail: err.message });
  }
}

async function listDepots(_req, res) {
  res.json({ depots: supplyDepots });
}

module.exports = { routeSupplies, locateFromText, listDepots };