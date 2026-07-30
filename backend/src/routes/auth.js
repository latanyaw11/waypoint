const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { supabase } = require('../db/client');

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
});

router.post('/signup', async (req, res, next) => {
  try {
    const { email, password, displayName } = signupSchema.parse(req.body);
    const password_hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase
      .from('waypoint_users')
      .insert({ email, password_hash, display_name: displayName })
      .select()
      .single();
    if (error) throw error;
    const token = jwt.sign({ sub: data.id, email, isAdmin: false }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: data.id, email, displayName } });
  } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('waypoint_users').select('*').eq('email', email).single();
    if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.is_suspended) return res.status(403).json({ error: 'Account suspended — contact support' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    await supabase.from('waypoint_users').update({ last_login_at: new Date() }).eq('id', user.id);
    const token = jwt.sign({ sub: user.id, email, isAdmin: !!user.is_admin }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name } });
  } catch (e) { next(e); }
});

module.exports = router;
