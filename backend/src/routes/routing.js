const router = require('express').Router({ mergeParams: true });
const { supabase } = require('../db/client');
const { requireAuth } = require('../middleware/auth');
const { buildItinerary } = require('../services/routingService');

router.use(requireAuth);

// Calculate the optimized, day-split itinerary for a trip
router.post('/calculate', async (req, res, next) => {
  try {
    const { data: trip } = await supabase.from('trips').select('*').eq('id', req.params.tripId).single();
    const { data: bases } = await supabase.from('bases').select('*').eq('trip_id', req.params.tripId).eq('is_primary', true).limit(1); const base = bases?.[0] || null;
    const { data: places } = await supabase.from('places').select('*').eq('trip_id', req.params.tripId).eq('status', 'planned');

    if (!base) return res.status(400).json({ error: 'Set a hotel/home base before calculating a route' });
    if (!places?.length) return res.status(400).json({ error: 'Add at least one place before calculating a route' });

    const result = await buildItinerary({ base, places, mode: trip.transport_mode, pace: trip.pace });

    // Persist day/route-position assignments back onto each place
    for (const day of result.days) {
      for (let i = 0; i < day.stops.length; i++) {
        await supabase.from('places').update({ day_assignment: day.day, route_position: i + 1 }).eq('id', day.stops[i].id);
      }
    }

    res.json({ base: { name: base.name, lat: base.lat, lng: base.lng, address: base.address }, ...result });
  } catch (e) { next(e); }
});

// Get just the distance matrix (useful for client-side what-if recalculation)
router.get('/matrix', async (req, res, next) => {
  try {
    const { getMatrix } = require('../services/routingService');
    const { data: bases } = await supabase.from('bases').select('*').eq('trip_id', req.params.tripId).eq('is_primary', true).limit(1); const base = bases?.[0] || null;
    const { data: places } = await supabase.from('places').select('*').eq('trip_id', req.params.tripId);
    const { data: trip } = await supabase.from('trips').select('transport_mode').eq('id', req.params.tripId).single();
    const result = await getMatrix([base, ...places], trip.transport_mode);
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;
