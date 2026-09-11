const express = require('express');
const router = express.Router();
const { verifyReport } = require('../controllers/scamController');

router.post('/', verifyReport);

module.exports = router;