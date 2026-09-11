require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const translateRoutes = require('./routes/translateRoutes');
const droneRoutes = require('./routes/droneRoutes');
const triageRoutes = require('./routes/triageRoutes');
const scamRoutes = require('./routes/scamRoutes');
const routeRoutes = require('./routes/routeRoutes');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/translate', translateRoutes);
app.use('/api/drone', droneRoutes);
app.use('/api/triage', triageRoutes);
app.use('/api/scam', scamRoutes);
app.use('/api', routeRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`DisasterRelief server running on port ${PORT}`);
});
