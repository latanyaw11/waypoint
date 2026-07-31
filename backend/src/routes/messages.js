const router = require('express').Router({ mergeParams: true });
const { supabase } = require('../db/client');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/trips/:tripId/messages?since=ISO_TIMESTAMP
router.get('/', async (req, res, next) => {
  try {
    let query = supabase
      .from('trip_messages')
      .select('id, user_id, display_name, avatar_color, body, created_at')
      .eq('trip_id', req.params.tripId)
      .order('created_at', { ascending: true })
      .limit(200);

    if (req.query.since) query = query.gt('created_at', req.query.since);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// POST /api/trips/:tripId/messages
router.post('/', async (req, res, next) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
    if (body.length > 1000) return res.status(400).json({ error: 'Message too long' });

    // Get sender info
    const { data: user, error: uerr } = await supabase
      .from('waypoint_users')
      .select('display_name, avatar_color')
      .eq('id', req.user.sub)
      .single();
    if (uerr) throw uerr;

    const { data, error } = await supabase
      .from('trip_messages')
      .insert({
        trip_id: req.params.tripId,
        user_id: req.user.sub,
        display_name: user.display_name,
        avatar_color: user.avatar_color || '#E2654A',
        body: body.trim()
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

module.exports = router;
