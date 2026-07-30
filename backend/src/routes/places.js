const router = require('express').Router({ mergeParams: true });
const { supabase } = require('../db/client');
const { requireAuth } = require('../middleware/auth');
const { geocode } = require('../services/geocodeService');

router.use(requireAuth);

// Search + add a place by free-text query (geocodes it)
router.post('/', async (req, res, next) => {
  try {
    const { query, name, category, notes, reservationUrl, visitDurationMin, estimatedCostCents, priority, celebrityPickId } = req.body;
    const geo = await geocode(query || name);
    const { data, error } = await supabase
      .from('places')
      .insert({
        trip_id: req.params.tripId,
        added_by: req.user.sub,
        name: name || query,
        category: category || 'other',
        lat: geo.lat,
        lng: geo.lng,
        address: geo.address,
        notes,
        reservation_url: reservationUrl,
        visit_duration_min: visitDurationMin || 60,
        estimated_cost_cents: estimatedCostCents || 0,
        priority: priority || 3,
        celebrity_pick_id: celebrityPickId || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('places').select('*').eq('trip_id', req.params.tripId).order('created_at');
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.patch('/:placeId', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('places').update(req.body).eq('id', req.params.placeId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/:placeId', async (req, res, next) => {
  try {
    const { error } = await supabase.from('places').delete().eq('id', req.params.placeId);
    if (error) throw error;
    res.status(204).send();
  } catch (e) { next(e); }
});

// Leave a rating/note on a place (shared trip members can see each other's notes)
router.post('/:placeId/notes', async (req, res, next) => {
  try {
    const { rating, comment } = req.body;
    const { data, error } = await supabase
      .from('place_notes')
      .insert({ place_id: req.params.placeId, user_id: req.user.sub, rating, comment })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

module.exports = router;
