import type { Handler } from "@netlify/functions";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let email: string;
  try {
    const body = JSON.parse(event.body ?? "{}") as { email?: unknown };
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  if (!EMAIL_RE.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid email address" }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error("[subscribe] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return { statusCode: 500, body: JSON.stringify({ error: "Server configuration error" }) };
  }

  const res = await fetch(`${supabaseUrl}/rest/v1/subscribers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ email, created_at: new Date().toISOString() }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[subscribe] Supabase error ${res.status}: ${text}`);
    return { statusCode: 500, body: JSON.stringify({ error: "Could not save subscription" }) };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  };
};
