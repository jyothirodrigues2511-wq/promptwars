const hazards = require('../data/hazards');
const { haversineDistanceKm } = require('../services/routingService');

function listHazards(_req, res) {
  res.json({ hazards });
}

function nearbyHazards(req, res) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radiusKm = parseFloat(req.query.radius_km) || 10;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Query params lat and lng are required.' });
  }

  const ranked = hazards
    .map((h) => ({
      ...h,
      distance_km: Math.round(haversineDistanceKm(lat, lng, h.latitude, h.longitude) * 10) / 10,
    }))
    .filter((h) => h.distance_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km);

  res.json({ center: { latitude: lat, longitude: lng }, radius_km: radiusKm, nearby: ranked });
}

module.exports = { listHazards, nearbyHazards };