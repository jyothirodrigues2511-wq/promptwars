const express = require('express');
const multer = require('multer');
const router = express.Router();
const { triagePatient } = require('../controllers/triageController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/', upload.single('image'), triagePatient);

module.exports = router;