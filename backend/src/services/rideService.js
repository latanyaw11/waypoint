/**
 * Ride-handoff service.
 * Generates Uber Universal Links (no API key required, works in any browser
 * or in-app webview and opens the native Uber app if installed).
 * A future upgrade path is the authenticated Uber Rides API (OAuth) for
 * server-side price estimates and ride status webhooks — see README.
 */

function uberDeepLink({ from, to, clientId }) {
  const params = new URLSearchParams({
    action: 'setPickup',
    'pickup[latitude]': from.lat,
    'pickup[longitude]': from.lng,
    'pickup[formatted_address]': from.address || from.name || '',
    'dropoff[latitude]': to.lat,
    'dropoff[longitude]': to.lng,
    'dropoff[formatted_address]': to.address || to.name || '',
  });
  if (clientId) params.set('client_id', clientId); // required for fare estimate + attribution in production
  return `https://m.uber.com/ul/?${params.toString()}`;
}

function lyftDeepLink({ from, to }) {
  const params = new URLSearchParams({
    id: 'lyft',
    'pickup[latitude]': from.lat,
    'pickup[longitude]': from.lng,
    'destination[latitude]': to.lat,
    'destination[longitude]': to.lng,
  });
  return `https://lyft.com/ride?${params.toString()}`;
}

module.exports = { uberDeepLink, lyftDeepLink };
