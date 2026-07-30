const { createClient } = require('@supabase/supabase-js');

// Use the service-role key only on the backend, never client-side.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
