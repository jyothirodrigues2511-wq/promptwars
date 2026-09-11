function errorHandler(err, _req, res, _next) {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
}

module.exports = errorHandler;
