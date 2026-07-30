const router = require('express').Router({ mergeParams: true });
const { supabase } = require('../db/client');
const { requireAuth } = require('../middleware/auth');
const { uberDeepLink, lyftDeepLink } = require('../services/rideService');

router.use(requireAuth);

// Resolve a fromPlaceId / toPlaceId which can be:
//   'base'        → the trip's primary hotel/home base
//   a place UUID  → a saved place on this trip
async function resolvePoint(id, tripId) {
  if (id === 'base') {
    const { data, error } = await supabase
      .from('bases').select('*').eq('trip_id', tripId).eq('is_primary', true).limit(1);     
    if (error || !data) throw new Error('Home base not set — add a hotel in Setup first');    
    return data[0];
  }
  const { data, error } = await supabase.from('places').select('*').eq('id', id).single();
  if (error || !data) throw new Error(`Place not found: ${id}`);
  return data;
}

// POST /api/trips/:tripId/rides
// Body: { fromPlaceId, toPlaceId, provider? }
// Returns: { deep_link, provider, ... }
router.post('/', async (req, res, next) => {
  try {
    const { fromPlaceId, toPlaceId, provider = 'uber' } = req.body;
    if (!fromPlaceId || !toPlaceId) {
      return res.status(400).json({ error: 'fromPlaceId and toPlaceId are required' });
    }

    const [from, to] = await Promise.all([
      resolvePoint(fromPlaceId, req.params.tripId),
      resolvePoint(toPlaceId, req.params.tripId),
    ]);

    const deepLink = provider === 'lyft'
      ? lyftDeepLink({ from, to })
      : uberDeepLink({ from, to, clientId: process.env.UBER_CLIENT_ID });

    // Log the ride request for affiliate tracking
    const { data: rideRow, error } = await supabase
      .from('ride_requests')
      .insert({
        trip_id: req.params.tripId,
        requested_by: req.user.sub,
        from_place_id: fromPlaceId === 'base' ? null : fromPlaceId,
        to_place_id:   toPlaceId   === 'base' ? null : toPlaceId,
        provider,
        deep_link: deepLink,
      })
      .select()
      .single();
    if (error) throw error;

    // Revenue tracking
    try {
  await supabase.from('affiliate_events').insert({
    trip_id: req.params.tripId,
    user_id: req.user.sub,
    partner: provider,
    place_id: toPlaceId === 'base' ? null : toPlaceId,
    event_type: 'click',
  });
} catch (_) {} // non-fatal if this fails

    // Always return deep_link at the top level so the frontend can open it directly
    res.status(201).json({ ...rideRow, deep_link: deepLink });
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('ride_requests').select('*')
      .eq('trip_id', req.params.tripId)
      .order('requested_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
