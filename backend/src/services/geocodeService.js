const axios = require('axios');

async function geocode(query) {
  try {
    const { data } = await axios.get('https://photon.komoot.io/api/', {
      params: { q: query, limit: 1 },
      timeout: 6000,
    });
    if (data.features && data.features.length > 0) {
      const f = data.features[0];
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties;
      const address = [p.name, p.street, p.city, p.country].filter(Boolean).join(', ');
      return { lat, lng, address };
    }
  } catch (err) {
    // fall through to Nominatim
  }
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
