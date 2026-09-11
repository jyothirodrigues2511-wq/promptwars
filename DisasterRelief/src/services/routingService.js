const EARTH_RADIUS_KM = 6371;
const DEFAULT_AVG_SPEED_KMH = 40;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

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

function depotsMatchingRequest(depots, requestedItems) {
  const items = (requestedItems || []).map((i) => String(i).trim().toLowerCase()).filter(Boolean);
  if (items.length === 0) return depots;

  return depots.filter((d) => {
    const inv = d.inventory || {};
    return items.every((item) => {
      const qty = Number(inv[item]) || 0;
      return qty > 0;
    });
  });
}

async function haversineRoute(victim, depots, _requestedItems, { avgSpeedKmh = DEFAULT_AVG_SPEED_KMH } = {}) {
  const target = depotsMatchingRequest(depots, _requestedItems);
  const pool = target.length > 0 ? target : depots;

  const scored = pool.map((depot) => {
    const distanceKm = haversineDistanceKm(
      victim.latitude,
      victim.longitude,
      depot.latitude,
      depot.longitude
    );
    return {
      depot,
      distanceKm,
      etaMinutes: Math.round((distanceKm / avgSpeedKmh) * 60),
    };
  });

  scored.sort((a, b) => a.distanceKm - b.distanceKm);
  const best = scored[0];

  return {
    provider: 'haversine',
    distance_km: Math.round(best.distanceKm),
    eta_minutes: best.etaMinutes,
    avg_speed_kmh: avgSpeedKmh,
    matched_depot: {
      id: best.depot.id,
      name: best.depot.name,
      latitude: best.depot.latitude,
      longitude: best.depot.longitude,
    },
    supplies_matched: best.depot.inventory || {},
    polyline: [
      [best.depot.latitude, best.depot.longitude],
      [victim.latitude, victim.longitude],
    ],
    depot_match_reasoning: `Nearest depot by straight-line (Haversine) distance (${Math.round(best.distanceKm)} km, ~${best.etaMinutes} min at ${avgSpeedKmh} km/h).`,
  };
}

async function googleRoute(victim, depots, requestedItems) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const candidates = depotsMatchingRequest(depots, requestedItems);
  const pool = candidates.length > 0 ? candidates : depots;

  const origin = `${victim.latitude},${victim.longitude}`;
  const destinations = pool.map((d) => `${d.latitude},${d.longitude}`).join('|');

  const dmUrl =
    'https://maps.googleapis.com/maps/api/distancematrix/json?units=metric' +
    `&origins=${encodeURIComponent(origin)}` +
    `&destinations=${encodeURIComponent(destinations)}` +
    `&key=${key}`;

  const dmRes = await fetch(dmUrl).then((r) => r.json());
  if (dmRes.status !== 'OK') {
    throw new Error(`Distance Matrix error: ${dmRes.status} ${dmRes.error_message || ''}`);
  }

  const row = dmRes.rows[0];
  const scored = row.elements.map((el, i) => ({
    depot: pool[i],
    distanceKm: el.distance.value / 1000,
    etaMinutes: Math.ceil(el.duration.value / 60),
  }));

  let best = scored.reduce((min, s) => (s.distanceKm < min.distanceKm ? s : min), scored[0]);
  let polyline = [
    [best.depot.latitude, best.depot.longitude],
    [victim.latitude, victim.longitude],
  ];

  try {
    const dirUrl =
      'https://maps.googleapis.com/maps/api/directions/json?mode=driving' +
      `&origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(`${best.depot.latitude},${best.depot.longitude}`)}` +
      `&key=${key}`;
    const dirRes = await fetch(dirUrl).then((r) => r.json());
    if (dirRes.status === 'OK' && dirRes.routes[0]) {
      best.distanceKm = dirRes.routes[0].legs[0].distance.value / 1000;
      best.etaMinutes = Math.ceil(dirRes.routes[0].legs[0].duration.value / 60);
      polyline = decodePolyline(dirRes.routes[0].overview_polyline.points);
    }
  } catch (_err) {
    // fall back to distance-matrix figures if directions call fails
  }

  return {
    provider: 'google',
    distance_km: Math.round(best.distanceKm),
    eta_minutes: best.etaMinutes,
    matched_depot: {
      id: best.depot.id,
      name: best.depot.name,
      latitude: best.depot.latitude,
      longitude: best.depot.longitude,
    },
    supplies_matched: best.depot.inventory || {},
    polyline,
    depot_match_reasoning: `Nearest depot by Google Distance Matrix / Directions API (${Math.round(best.distanceKm)} km, ~${best.etaMinutes} min driving).`,
  };
}

const OSRM_BASE = (process.env.OSRM_BASE_URL || 'https://router.project-osrm.org').replace(/\/$/, '');

async function osrmRoute(victim, depots, requestedItems, { avgSpeedKmh = DEFAULT_AVG_SPEED_KMH } = {}) {
  const coords = depots.map((d) => `${d.longitude.toFixed(5)},${d.latitude.toFixed(5)}`);
  // OSRM takes lon,lat; victim is the single source at index 0
  const origin = `${victim.longitude.toFixed(5)},${victim.latitude.toFixed(5)}`;
  const names = [origin, ...coords];

  const tableUrl = `${OSRM_BASE}/table/v1/driving/${names.join(';')}?annotations=distance,duration&sources=0`;
  const table = await fetch(tableUrl).then((r) => r.json());
  if (table.code !== 'Ok') {
    throw new Error(`OSRM table error: ${table.code}`);
  }

  const distRow = (table.distances || [[]])[0] || [];
  const durRow = (table.durations || [[]])[0] || [];
  const scored = depots.map((depot, i) => {
    const durSec = durRow[i];
    let distanceMeters = distRow[i];
    if (distanceMeters == null) {
      distanceMeters =
        haversineDistanceKm(victim.latitude, victim.longitude, depot.latitude, depot.longitude) * 1000;
    }
    return {
      depot,
      distanceKm: distanceMeters / 1000,
      etaMinutes: durSec == null ? Infinity : Math.ceil(durSec / 60),
    };
  });

  const target = depotsMatchingRequest(depots, requestedItems);
  const pool = target.length > 0 ? target : depots;
  let best = scored
    .filter((s) => pool.some((d) => d.id === s.depot.id))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];

  if (!best || !Number.isFinite(best.distanceKm)) {
    throw new Error('OSRM could not compute a route to any depot.');
  }

  const routeUrl =
    `${OSRM_BASE}/route/v1/driving/${origin};${best.depot.longitude.toFixed(5)},${best.depot.latitude.toFixed(5)}` +
    '?geometries=geojson&overview=full';
  const route = await fetch(routeUrl).then((r) => r.json());

  if (route.code !== 'Ok' || !route.routes || !route.routes[0]) {
    throw new Error(`OSRM route error: ${route.code}`);
  }

  const leg = route.routes[0];
  const polyline = leg.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const distanceKm = leg.distance / 1000;
  const etaMinutes = Math.ceil(leg.duration / 60);

  return {
    provider: 'osrm',
    distance_km: Math.round(distanceKm),
    eta_minutes: etaMinutes,
    avg_speed_kmh: avgSpeedKmh,
    matched_depot: {
      id: best.depot.id,
      name: best.depot.name,
      latitude: best.depot.latitude,
      longitude: best.depot.longitude,
    },
    supplies_matched: best.depot.inventory || {},
    polyline,
    depot_match_reasoning: `Nearest depot by OSRM road routing (${Math.round(distanceKm)} km, ~${etaMinutes} min driving).`,
  };
}

function decodePolyline(encoded) {
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

function resolveProvider() {
  const requested = (process.env.ROUTING_PROVIDER || '').trim().toLowerCase();
  if (requested) return requested;
  if (process.env.GOOGLE_MAPS_API_KEY) return 'google';
  return 'osrm';
}

async function findNearestRoute(victim, depots, requestedItems) {
  if (!isValidCoords(victim.latitude, victim.longitude)) {
    const err = new Error('Invalid victim coordinates.');
    err.status = 400;
    throw err;
  }

  const provider = resolveProvider();

  if (provider === 'google') {
    return googleRoute(victim, depots, requestedItems);
  }

  if (provider === 'osrm') {
    try {
      return await osrmRoute(victim, depots, requestedItems);
    } catch (err) {
      console.error('OSRM routing failed, falling back to Haversine:', err.message);
      return haversineRoute(victim, depots, requestedItems);
    }
  }

  return haversineRoute(victim, depots, requestedItems);
}

module.exports = { findNearestRoute, haversineDistanceKm, isValidCoords, decodePolyline };