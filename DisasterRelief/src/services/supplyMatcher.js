const supplyDepots = require('../data/supplyDepots');
const sectorMatrix = require('../data/sectorMatrix');
const { gridFromText, gridFromCoords, sectorById, isExternalSector, EXTERNAL_SECTOR } = require('../services/gridService');

const ITEM_ALIASES = {
  water: ['water', 'drinking water', 'h2o'],
  food_packs: ['food', 'food_packs', 'rations', 'meal', 'canned'],
  tents: ['tent', 'tents', 'shelter'],
  blankets: ['blanket', 'blankets', 'warmth', 'thermal'],
  bandages: ['bandage', 'bandages', 'first aid', 'gauze', 'dressing', 'wound'],
  oxygen: ['oxygen', 'o2'],
  antidote: ['antidote'],
  vaccines: ['vaccine', 'vaccines'],
  surgical_kits: ['surgical', 'surgical_kits', 'surgery kit', 'kit'],
  iv_fluids: ['iv fluids', 'iv_fluids', 'iv fluid', 'fluids', 'saline'],
  fuel: ['fuel', 'gasoline', 'diesel', 'petrol'],
  boats: ['boat', 'boats', 'dinghy', 'raft', 'rescue boat'],
  first_aid_kits: ['first_aid_kits', 'aid kit', 'med kit'],
};

function normalizeRequestedItem(label) {
  const lower = String(label || '').toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(ITEM_ALIASES)) {
    if (canonical === lower || aliases.some((a) => lower.includes(a))) return canonical;
  }
  return null;
}

function availabilityFor(depot, requestedItems) {
  const matched = [];
  const unmatched = [];
  const inventory = depot.inventory || {};
  for (const item of requestedItems) {
    const canonical = normalizeRequestedItem(item);
    if (canonical && (inventory[canonical] || 0) > 0) {
      matched.push({ item, canonical, available: inventory[canonical] });
    } else {
      unmatched.push(item);
    }
  }
  return { matched, unmatched };
}

function scoreDepot(depot, targetSector, requestedItems, urgency) {
  const prox = sectorMatrix.proximityIndex(targetSector, depot);
  const avail = availabilityFor(depot, requestedItems);

  const proximityScore = (6 - prox) / 5; // 1.0 for same sector, 0.2 for far
  const availabilityScore =
    requestedItems.length === 0
      ? 1
      : avail.matched.length / requestedItems.length;

  const sameSector = depot.primary_sector === targetSector;
  const urgencyScore =
    (urgency === 'RED' && sameSector ? 1 : 0) +
    (urgency === 'RED' ? 0.4 : urgency === 'YELLOW' ? 0.2 : 0);

  const total = proximityScore * 0.45 + availabilityScore * 0.35 + urgencyScore * 0.2;
  return { prox, avail, proximityScore, availabilityScore, urgencyScore, total };
}

function manhattanPath(depot, targetSector) {
  const fromS = sectorById(depot.primary_sector);
  const toS = sectorById(targetSector);
  if (!fromS || !toS) return [];
  const path = [{ id: fromS.id, name: fromS.name, latitude: fromS.latitude, longitude: fromS.longitude }];
  let cur = { ...fromS };
  while (cur.row !== toS.row) {
    cur = { ...cur, row: cur.row + (cur.row < toS.row ? 1 : -1) };
    const seg = sectorById(`ABCD`[cur.row] + (cur.col + 1));
    path.push({ id: seg.id, name: seg.name, latitude: seg.latitude, longitude: seg.longitude });
  }
  while (cur.col !== toS.col) {
    cur = { ...cur, col: cur.col + (cur.col < toS.col ? 1 : -1) };
    const seg = sectorById(`ABCD`[cur.row] + (cur.col + 1));
    path.push({ id: seg.id, name: seg.name, latitude: seg.latitude, longitude: seg.longitude });
  }
  return path;
}

function buildDirectionsText(depot, targetSectorId, matched, estMin, extra) {
  const target = sectorById(targetSectorId);
  const isExternal = extra && extra.external;
  const lines = [];
  lines.push(`1. STAGING — Load vehicle at ${depot.name} (Sector ${depot.primary_sector}).`);
  if (matched.length > 0) {
    lines.push(`2. CARGO — ${matched.map((m) => `${m.available}× ${m.item}`).join(', ')} onboard.`);
  } else {
    lines.push('2. CARGO — verify closest available stock, request resupply if under 20%.');
  }

  if (isExternal) {
    const where = extra.external_coords
      ? ` (${extra.external_coords.latitude.toFixed(4)}, ${extra.external_coords.longitude.toFixed(4)})`
      : '';
    const region = extra.external_region ? ` toward ${extra.external_region}` : '';
    lines.push(`3. ROUTE — Proceed${region}${where}, beyond Greater Seattle grid coverage. Hand off to regional authorities at the Sector ${depot.primary_sector} boundary.`);
    lines.push(
      `4. ARRIVAL — Reach ${EXTERNAL_SECTOR.name}${estMin ? ` — ETA ≈ ${estMin} min via regional highway corridors.` : ' — ETA to be confirmed via regional liaison.'}`
    );
    return lines.join('\n');
  }

  const path = manhattanPath(depot, targetSectorId);
  const legs = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const d = sectorMatrix.haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
    legs.push(`Sector ${a.id} → ${b.id} (${d.toFixed(1)} km)`);
  }
  lines.push(`3. ROUTE — ${legs.join(', ') || `remain in Sector ${depot.primary_sector}.`}`);
  lines.push(`4. ARRIVAL — Reach ${target ? `${target.name} (Sector ${target.id})` : `Sector ${targetSectorId}`} — ETA ≈ ${estMin} min via grid lanes (avg 40 km/h).`);
  return lines.join('\n');
}

async function resolveTargetSector({ sector_id, coords, text, latitude, longitude }) {
  if (sector_id && (sectorById(sector_id) || isExternalSector(sector_id))) {
    const result = { sector_id, method: 'explicit' };
    if (isExternalSector(sector_id)) {
      const lat = typeof latitude === 'number' ? latitude : coords?.latitude;
      const lng = typeof longitude === 'number' ? longitude : coords?.longitude;
      if (typeof lat === 'number' && typeof lng === 'number') {
        result.external_latitude = lat;
        result.external_longitude = lng;
      }
    }
    return result;
  }

  const extrasFor = (g) =>
    isExternalSector(g.sector_id)
      ? { external_latitude: g.external_latitude, external_longitude: g.external_longitude, external_region: g.external_region }
      : {};

  if (typeof latitude === 'number' && typeof longitude === 'number') {
    const g = gridFromCoords(latitude, longitude);
    if (g) return { sector_id: g.sector_id, method: 'coords', ...extrasFor(g) };
  }
  if (coords && typeof coords.latitude === 'number' && typeof coords.longitude === 'number') {
    const g = gridFromCoords(coords.latitude, coords.longitude);
    if (g) return { sector_id: g.sector_id, method: 'coords', ...extrasFor(g) };
  }
  if (text) {
    const g = await gridFromText(text);
    return { sector_id: g.sector_id, method: g.method, ...extrasFor(g) };
  }
  return null;
}

async function matchSupplies({ sector_id, coords, text, latitude, longitude, requested_items = [], triage_level, urgency, depots = supplyDepots }) {
  const target = await resolveTargetSector({ sector_id, coords, text, latitude, longitude });
  if (!target) {
    const err = new Error(
      'Could not resolve a grid sector. Provide sector_id, coordinates (lat/lng), or descriptive text.'
    );
    err.status = 400;
    throw err;
  }

  const resolvedUrgency = (triage_level || urgency || 'GREEN').toUpperCase();
  const isExternal = isExternalSector(target.sector_id);

  const ranked = depots
    .map((d) => ({ depot: d, ...scoreDepot(d, target.sector_id, requested_items, resolvedUrgency) }))
    .sort((a, b) => b.total - a.total);

  const best = ranked[0];
  const targetSector = isExternal ? null : sectorById(target.sector_id);
  const targetName = isExternal ? target.external_region || EXTERNAL_SECTOR.name : targetSector.name;

  const externalCoords =
    isExternal && typeof target.external_latitude === 'number' && typeof target.external_longitude === 'number'
      ? { latitude: target.external_latitude, longitude: target.external_longitude }
      : null;

  const depDist = targetSector
    ? sectorMatrix.haversineKm(best.depot.latitude, best.depot.longitude, targetSector.latitude, targetSector.longitude)
    : externalCoords
      ? sectorMatrix.haversineKm(best.depot.latitude, best.depot.longitude, externalCoords.latitude, externalCoords.longitude)
      : null;

  const estimatedTransitTimeMins = depDist === null ? null : Math.max(2, Math.round((depDist / 40) * 60));

  const transitFor = (depot) => {
    if (targetSector) {
      return Math.max(2, Math.round((sectorMatrix.haversineKm(depot.latitude, depot.longitude, targetSector.latitude, targetSector.longitude) / 40) * 60));
    }
    if (externalCoords) {
      return Math.max(2, Math.round((sectorMatrix.haversineKm(depot.latitude, depot.longitude, externalCoords.latitude, externalCoords.longitude) / 40) * 60));
    }
    return null;
  };

  const proposal = {
    assigned_depot_name: best.depot.name,
    assigned_depot_id: best.depot.id,
    target_sector_id: target.sector_id,
    target_sector_name: targetName,
    estimated_transit_time_mins: estimatedTransitTimeMins,
    distance_km: depDist === null ? null : Number(depDist.toFixed(1)),
    priority_rank: ranked.findIndex((r) => r.depot.id === best.depot.id) + 1,
    total_candidates: ranked.length,
    proximity_index: best.prox,
    triage_level: resolvedUrgency,
    step_by_step_directions_text: buildDirectionsText(
      best.depot,
      target.sector_id,
      best.avail.matched,
      estimatedTransitTimeMins,
      isExternal ? { external: true, external_region: target.external_region, external_coords: externalCoords } : null
    ),
    matched_items: best.avail.matched.map((m) => ({ item: m.item, available: m.available })),
    unmatched_items: best.avail.unmatched,
    provider: 'sector-matrix',
    sector_method: target.method,
    candidate_depots: ranked.map((r) => ({
      id: r.depot.id,
      name: r.depot.name,
      sector: r.depot.primary_sector,
      proximity_index: r.prox,
      estimated_transit_time_mins: transitFor(r.depot),
      score: Number(r.total.toFixed(3)),
    })),
  };

  return { ...proposal, target };
}

module.exports = {
  matchSupplies,
  normalizeRequestedItem,
  availabilityFor,
  scoreDepot,
  manhattanPath,
  buildDirectionsText,
  resolveTargetSector,
  ITEM_ALIASES,
};