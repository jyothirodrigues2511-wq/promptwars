const supplyDepots = require('../data/supplyDepots');
const { SECTORS, sectorById } = require('../data/sectorMatrix');
const { matchSupplies } = require('../services/supplyMatcher');

async function handleMatchSupplies(req, res) {
  try {
    const { body } = req;
    const result = await matchSupplies(body);
    res.json(result);
  } catch (err) {
    console.error('Match supplies error:', err);
    res.status(err.status || 500).json({ error: 'Supply matching failed.', detail: err.message });
  }
}

function listSectors(_req, res) {
  const sectors = SECTORS.map((s) => {
    const depot = supplyDepots.find((d) => d.primary_sector === s.id) || null;
    const serving = supplyDepots
      .filter((d) => d.servedSectors && d.servedSectors.includes(s.id))
      .map((d) => ({ id: d.id, name: d.name }));
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      latitude: s.latitude,
      longitude: s.longitude,
      row: s.row,
      col: s.col,
      primary_hub: depot ? { id: depot.id, name: depot.name } : null,
      serving_hubs: serving,
    };
  });
  res.json({ sectors });
}

module.exports = { handleMatchSupplies, listSectors };