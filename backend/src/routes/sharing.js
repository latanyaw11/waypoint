const router = require('express').Router();
const { supabase } = require('../db/client');
const { requireAuth } = require('../middleware/auth');

// Look up a trip by share code (used by the "Join shared trip" flow)
router.get('/:code', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('trips').select('*').eq('share_code', req.params.code.toUpperCase()).single();
    if (error || !data) return res.status(404).json({ error: 'No trip found for that code' });
    const { data: places } = await supabase.from('places').select('*').eq('trip_id', data.id);
    res.json({ ...data, places });
  } catch (e) { next(e); }
});

// Join a shared trip as a collaborator
router.post('/:code/join', requireAuth, async (req, res, next) => {
  try {
    const { data: trip, error } = await supabase.from('trips').select('*').eq('share_code', req.params.code.toUpperCase()).single();
    if (error || !trip) return res.status(404).json({ error: 'No trip found for that code' });
    const colors = ['#E2654A', '#3F6B53', '#C99A3B', '#5B3FA3', '#2B6E91', '#A03E78'];
    const { count } = await supabase.from('trip_members').select('*', { count: 'exact', head: true }).eq('trip_id', trip.id);
    const { data: membership, error: joinError } = await supabase
      .from('trip_members')
      .upsert({ trip_id: trip.id, user_id: req.user.sub, role: 'editor', color: colors[(count || 0) % colors.length] }, { onConflict: 'trip_id,user_id' })
      .select()
      .single();
    if (joinError) throw joinError;
    res.status(201).json({ trip, membership });
  } catch (e) { next(e); }
});

module.exports = router;
