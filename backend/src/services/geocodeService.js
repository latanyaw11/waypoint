const axios = require('axios');

/**
 * Geocoding service. Defaults to Nominatim (OpenStreetMap, free, rate-limited
 * to ~1 req/sec — fine for dev). For production scale, swap to Google
 * Geocoding API or Mapbox Geocoding for better accuracy, POI coverage, and
 * higher throughput. Keep the same function signature so callers don't change.
 */

async function geocode(query) {
  const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q: query, format: 'json', limit: 1 },
    headers: { 'User-Agent': 'WaypointApp/1.0 (contact: support@waypoint.app)' },
    timeout: 6000,
  });
  if (!data.length) throw new Error('No geocoding match found');
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), address: data[0].display_name };
}

async function reverseGeocode(lat, lng) {
  const { data } = await axios.get('https://nominatim.openstreetmap.org/reverse', {
    params: { lat, lon: lng, format: 'json' },
    headers: { 'User-Agent': 'WaypointApp/1.0 (contact: support@waypoint.app)' },
    timeout: 6000,
  });
  return data.display_name;
}

module.exports = { geocode, reverseGeocode };
