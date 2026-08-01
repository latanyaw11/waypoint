const router = require('express').Router();
const { randomBytes } = require('crypto');
const { supabase } = require('../db/client');
const { requireAuth } = require('../middleware/auth');
const { geocode } = require('../services/geocodeService');

// Built-in share code generator — avoids nanoid ESM compatibility issues
function genCode(len = 6) {
  return randomBytes(len).toString('base64url').slice(0, len).toUpperCase();
}

router.use(requireAuth);

// Create a trip
router.post('/', async (req, res, next) => {
  try {
    const { name, destinationCity, startDate, endDate, pace, transportMode, budgetCapCents } = req.body;
    const geo = await geocode(destinationCity).catch(() => null);
    const { data, error } = await supabase
      .from('trips')
      .insert({
        owner_id: req.user.sub,
        name,
        destination_city: destinationCity,
        destination_lat: geo?.lat,
        destination_lng: geo?.lng,
        start_date: startDate,
        end_date: endDate,
        pace: pace || 'moderate',
        transport_mode: transportMode || 'driving',
        budget_cap_cents: budgetCapCents || 0,
      })
      .select()
      .single();
    if (error) throw error;
    await supabase.from('trip_members').insert({ trip_id: data.id, user_id: req.user.sub, role: 'owner', color: '#E2654A' });
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// List my trips
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('trip_members')
      .select('trips(*)')
      .eq('user_id', req.user.sub);
    if (error) throw error;
    res.json(data.map((row) => row.trips));
  } catch (e) { next(e); }
});

// Get one trip (with places + base)
router.get('/:tripId', async (req, res, next) => {
  try {
    const { data: trip, error } = await supabase.from('trips').select('*').eq('id', req.params.tripId).single();
    if (error) throw error;
    const { data: places } = await supabase.from('places').select('*').eq('trip_id', req.params.tripId);
    const { data: bases } = await supabase.from('bases').select('*').eq('trip_id', req.params.tripId);
    const { data: members } = await supabase.from('trip_members').select('user_id, role, color, waypoint_users!trip_members_user_id_fkey(display_name)').eq('trip_id', req.params.tripId);
    res.json({ ...trip, places, bases, members });
  } catch (e) { next(e); }
});

// Update trip settings
router.patch('/:tripId', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('trips').update({ ...req.body, updated_at: new Date() }).eq('id', req.params.tripId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Set/update the hotel/home base — always replaces existing primary base
router.post('/:tripId/base', async (req, res, next) => {
  try {
    const { name, address, checkIn, checkOut } = req.body;
    const geo = await geocode(address || name);

    // Delete any existing bases for this trip first
    await supabase.from('bases').delete().eq('trip_id', req.params.tripId);

    // Insert the new base
    const { data, error } = await supabase
      .from('bases')
      .insert({ trip_id: req.params.tripId, name, address: geo.address, lat: geo.lat, lng: geo.lng, check_in: checkIn, check_out: checkOut, is_primary: true })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// Generate / fetch a share code
router.post('/:tripId/share', async (req, res, next) => {
  try {
    const code = genCode(6);
    const { data, error } = await supabase
      .from('trips')
      .update({ share_code: code, is_shared: true })
      .eq('id', req.params.tripId)
      .select()
      .single();
    if (error) throw error;
    res.json({ shareCode: data.share_code, shareUrl: `${process.env.APP_BASE_URL}/join/${data.share_code}` });
  } catch (e) { next(e); }
});

router.delete('/:tripId', async (req, res, next) => {
  try {
    const { error } = await supabase.from('trips').delete().eq('id', req.params.tripId).eq('owner_id', req.user.sub);
    if (error) throw error;
    res.status(204).send();
  } catch (e) { next(e); }
});

module.exports = router;
