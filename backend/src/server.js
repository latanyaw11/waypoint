require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const tripRoutes = require('./routes/trips');
const placeRoutes = require('./routes/places');
const routeRoutes = require('./routes/routing');
const rideRoutes = require('./routes/rides');
const celebrityRoutes = require('./routes/celebrity');
const adminRoutes = require('./routes/admin');
const shareRoutes = require('./routes/sharing');

const app = express();

// Helmet with relaxed CSP — the frontend loads Leaflet tiles and calls OSRM
// directly from the browser, not through this server, so we don't restrict that here.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS — allow any origin listed in ALLOWED_ORIGINS (comma-separated in env),
// or fall back to * for dev. The origin callback correctly handles arrays.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null;

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Render health checks, same-origin)
    if (!origin) return callback(null, true);
    if (!allowedOrigins) return callback(null, true); // dev: allow everything
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

// Global rate limit — 120 requests per minute per IP
app.use(rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'waypoint-api', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/trips/:tripId/places', placeRoutes);
app.use('/api/trips/:tripId/routing', routeRoutes);
app.use('/api/trips/:tripId/rides', rideRoutes);
app.use('/api/celebrity-picks', celebrityRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/admin', adminRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Waypoint API listening on :${PORT}`));

module.exports = app;
