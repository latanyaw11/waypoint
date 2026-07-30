const router = require('express').Router();
const { supabase } = require('../db/client');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth, requireAdmin);

async function logAdminAction(adminId, action, targetTable, targetId, detail) {
  await supabase.from('admin_audit_log').insert({ admin_id: adminId, action, target_table: targetTable, target_id: targetId, detail });
}

// ---------- Dashboard summary ----------
router.get('/dashboard', async (req, res, next) => {
  try {
    const [{ count: userCount }, { count: tripCount }, { count: placeCount }, { count: rideCount }] = await Promise.all([
      supabase.from('waypoint_users').select('*', { count: 'exact', head: true }),
      supabase.from('trips').select('*', { count: 'exact', head: true }),
      supabase.from('places').select('*', { count: 'exact', head: true }),
      supabase.from('ride_requests').select('*', { count: 'exact', head: true }),
    ]);
    res.json({ userCount, tripCount, placeCount, rideCount });
  } catch (e) { next(e); }
});

// ---------- User management ----------
router.get('/users', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('waypoint_users').select('id,email,display_name,created_at,last_login_at').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/users/:id/suspend', async (req, res, next) => {
  try {
    await supabase.from('waypoint_users').update({ is_suspended: true }).eq('id', req.params.id);
    await logAdminAction(req.user.sub, 'suspend_user', 'users', req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Content moderation: trips & places ----------
router.get('/trips', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('trips').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/places/:id', async (req, res, next) => {
  try {
    await supabase.from('places').delete().eq('id', req.params.id);
    await logAdminAction(req.user.sub, 'remove_place', 'places', req.params.id, { reason: req.body.reason });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Celebrity guide content management ----------
router.get('/celebrity-picks/pending-review', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('celebrity_picks').select('*').eq('is_published', false);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// ---------- Affiliate / revenue reporting ----------
router.get('/revenue/affiliate-summary', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('affiliate_events').select('partner, event_type, payout_cents, occurred_at');
    if (error) throw error;
    const summary = {};
    for (const row of data) {
      summary[row.partner] = summary[row.partner] || { clicks: 0, bookings: 0, payoutCents: 0 };
      if (row.event_type === 'click') summary[row.partner].clicks++;
      if (row.event_type === 'booking_confirmed') { summary[row.partner].bookings++; summary[row.partner].payoutCents += row.payout_cents; }
    }
    res.json(summary);
  } catch (e) { next(e); }
});

// ---------- Audit log ----------
router.get('/audit-log', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

module.exports = router;
