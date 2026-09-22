import { createClient } from "@supabase/supabase-js";

function getSupabaseUrl(): string {
  const url = process.env["SUPABASE_URL"];
  if (!url) throw new Error("Missing required environment variable: SUPABASE_URL");
  return url;
}

/**
 * Service-role client — use in pipeline scripts only. Never expose to browser.
 */
export function createServiceClient() {
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!key) throw new Error("Missing required environment variable: SUPABASE_SERVICE_KEY");
  return createClient(getSupabaseUrl(), key);
}

/**
 * Anon (public) client — safe to use in the Astro site.
 */
export function createAnonClient() {
  const key = process.env["SUPABASE_ANON_KEY"];
  if (!key) throw new Error("Missing required environment variable: SUPABASE_ANON_KEY");
  return createClient(getSupabaseUrl(), key);
}
