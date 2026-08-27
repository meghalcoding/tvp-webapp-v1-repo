// ============================================================================
// CONFIG — fill these in after creating your Supabase project.
// Settings > API in the Supabase dashboard gives you both values below.
// The anon key is safe to ship in client code — it has no power on its own;
// RLS policies (db/rls_policies.sql) are what actually restrict access.
// Never put the service_role key here or anywhere in client code.
// ============================================================================

export const SUPABASE_URL = "https://ecxranujcedwqckpjldi.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjeHJhbnVqY2Vkd3Fja3BqbGRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzM0OTAsImV4cCI6MjEwMTc0OTQ5MH0.gxZ4rSlfDfG4ei8IK5FbsO4RVCmJhKJexD118WOblYw";

export const IS_CONFIGURED =
  !SUPABASE_URL.includes("YOUR-PROJECT-REF") &&
  !SUPABASE_ANON_KEY.includes("YOUR-ANON-PUBLIC-KEY");