const router = require('express').Router();
const { supabase } = require('../db/client');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Public: browse curated celebrity favorites, optionally filtered by city or celebrity
router.get('/', async (req, res, next) => {
  try {
    let query = supabase.from('celebrity_picks').select('*').eq('is_published', true).order('sort_weight', { ascending: false });
    if (req.query.city) query = query.ilike('city', `%${req.query.city}%`);
    if (req.query.celebrity) query = query.ilike('celebrity_name', `%${req.query.celebrity}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// Admin: add/edit/publish entries to the celebrity guide library
router.post('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('celebrity_picks')
      .insert({ ...req.body, created_by_admin_id: req.user.sub })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('celebrity_picks').update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { error } = await supabase.from('celebrity_picks').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (e) { next(e); }
});

module.exports = router;
