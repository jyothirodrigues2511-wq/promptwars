const express = require('express');
const multer = require('multer');
const router = express.Router();
const { translateInput, translateAudio } = require('../controllers/translateController');

const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/', translateInput);
router.post('/audio', audioUpload.single('audio'), translateAudio);

module.exports = router;