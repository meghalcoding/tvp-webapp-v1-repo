import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_CONFIGURED } from "./config.js";

// Single shared client for the whole app. If config.js hasn't been filled
// in yet, we still create a client (so imports don't crash) but every call
// site should check IS_CONFIGURED and show the "connect Supabase" state
// instead of a confusing network error.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

export { IS_CONFIGURED };
