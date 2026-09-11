const SECTORS = [
  { id: 'A1', name: 'Ballard & North West', description: 'Residential NW, ship canal, community centers', latitude: 47.6500, longitude: -122.3700, row: 0, col: 0 },
  { id: 'A2', name: 'Fremont & North Central', description: 'Mixed commercial, Fremont Bridge corridor', latitude: 47.6520, longitude: -122.3350, row: 0, col: 1 },
  { id: 'A3', name: 'University District', description: 'UW campus, dense student housing, hospitals', latitude: 47.6550, longitude: -122.3050, row: 0, col: 2 },
  { id: 'A4', name: 'Lake City & North East', description: 'Residential NE, parks, main arterials', latitude: 47.6560, longitude: -122.2700, row: 0, col: 3 },

  { id: 'B1', name: 'Queen Anne & Interbay', description: 'Hillside residential, rail yards, bridge access', latitude: 47.6170, longitude: -122.3700, row: 1, col: 0 },
  { id: 'B2', name: 'Downtown Core', description: 'City Hall, financial district, transit hubs', latitude: 47.6130, longitude: -122.3380, row: 1, col: 1 },
  { id: 'B3', name: 'Capitol Hill & Central', description: 'Dense residential, First Hill hospitals', latitude: 47.6150, longitude: -122.3150, row: 1, col: 2 },
  { id: 'B4', name: 'Madison Valley & East', description: 'Residential east slope, parks, arterials', latitude: 47.6140, longitude: -122.2830, row: 1, col: 3 },

  { id: 'C1', name: 'West Seattle Junction', description: 'West Seattle bridge egress, retail core', latitude: 47.5900, longitude: -122.3700, row: 2, col: 0 },
  { id: 'C2', name: 'Waterfront & Harbor', description: 'Harbor Island, seawall, ferry terminals, piers', latitude: 47.6040, longitude: -122.3400, row: 2, col: 1 },
  { id: 'C3', name: 'Beacon Hill', description: 'Residential ridge, light rail, medical facilities', latitude: 47.5830, longitude: -122.3150, row: 2, col: 2 },
  { id: 'C4', name: 'Rainier Valley', description: 'Dense corridor, light rail, mixed residential', latitude: 47.5800, longitude: -122.2830, row: 2, col: 3 },

  { id: 'D1', name: 'Fauntleroy & South West', description: 'Ferry terminal, coastal residential', latitude: 47.5400, longitude: -122.3600, row: 3, col: 0 },
  { id: 'D2', name: 'SoDo & Georgetown', description: 'Industrial, truck corridors, stadium district', latitude: 47.5400, longitude: -122.3350, row: 3, col: 1 },
  { id: 'D3', name: 'Boeing Field & South Park', description: 'Airport egress, industrial parks, river', latitude: 47.5300, longitude: -122.3050, row: 3, col: 2 },
  { id: 'D4', name: 'SeaTac Airport & South End', description: 'SeaTac International, logistics spine', latitude: 47.4502, longitude: -122.3088, row: 3, col: 3 },
];

const SECTOR_MAP = Object.fromEntries(SECTORS.map((s) => [s.id, s]));

function sectorById(id) {
  return SECTOR_MAP[id] || null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestSector(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const s of SECTORS) {
    const d = haversineKm(lat, lng, s.latitude, s.longitude);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

function gridDistance(sectorA, sectorB) {
  const a = sectorById(typeof sectorA === 'string' ? sectorA : sectorA?.id);
  const b = sectorById(typeof sectorB === 'string' ? sectorB : sectorB?.id);
  if (!a || !b) return Infinity;
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

function proximityIndex(sectorId, depot) {
  const primary = depot.primary_sector || depot.servedSectors?.[0] || null;
  if (!primary || !sectorId) return 5;
  const dist = gridDistance(primary, sectorId);
  if (dist <= 0) return 1;
  if (dist === 1) return 2;
  if (dist === 2) return 3;
  if (dist <= 4) return 4;
  return 5;
}

module.exports = {
  SECTORS,
  SECTOR_MAP,
  sectorById,
  nearestSector,
  haversineKm,
  gridDistance,
  proximityIndex,
};