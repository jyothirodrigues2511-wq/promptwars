const express = require('express');
const router = express.Router();
const { routeSupplies, locateFromText, listDepots } = require('../controllers/routeController');
const { listHazards, nearbyHazards } = require('../controllers/hazardController');
const { handleMatchSupplies, listSectors } = require('../controllers/supplyController');

router.post('/route-supplies', routeSupplies);
router.post('/locate', locateFromText);
router.get('/route-supplies/depots', listDepots);
router.get('/hazards', listHazards);
router.get('/hazards/nearby', nearbyHazards);
router.post('/match-supplies', handleMatchSupplies);
router.get('/sectors', listSectors);

module.exports = router;