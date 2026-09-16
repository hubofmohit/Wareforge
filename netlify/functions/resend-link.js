// Lost-link recovery. Looks up a tenant by email and re-sends their
// access link. Uses the service-role key (bypasses RLS) since this has to
// search across all tenants by email, which the anon key can never do.
//
// Enumeration protection: the HTTP response is byte-for-byte identical
// whether the email matches a tenant, doesn't match, is throttled, or an
// internal error occurred. Response TIMING is also equalized (see
// MIN_RESPONSE_MS below) — without that, an attacker could still tell
// found vs. not-found apart by how long the request takes, even with an
// identical response body.

const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const GENERIC_MESSAGE = "If that email has an account with us, we've sent the access link.";
const THROTTLE_MINUTES = 5; // don't let one email address be used to spam-resend
const MIN_RESPONSE_MS = 500; // floor every response to roughly this long

exports.handler = async (event) => {
  const startedAt = Date.now();

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let email = "";
  try {
    const parsed = JSON.parse(event.body || "{}");
    email = String(parsed.email || "").trim().toLowerCase();
  } catch (e) {
    // Malformed body — fall through to the generic response below rather
    // than returning a distinct error, so this can't be used to fingerprint
    // the endpoint's parsing behavior.
  }

  if (email && isPlausibleEmail(email)) {
    try {
      await attemptResend(email);
    } catch (err) {
      // Never surface details — an internal error looks identical to
      // "not found" from the outside.
      console.error("resend-link error:", err);
    }
  }

  await waitUntilMinimumElapsed(startedAt, MIN_RESPONSE_MS);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: GENERIC_MESSAGE }),
  };
};

async function attemptResend(email) {
  const { data: tenant, error } = await supabaseAdmin
    .from("tenants")
    .select("id, access_token, last_resend_requested_at")
    .ilike("email", email)
    .maybeSingle();

  if (error) throw error;
  if (!tenant) return; // no such tenant — say nothing, just return

  const lastRequest = tenant.last_resend_requested_at ? new Date(tenant.last_resend_requested_at).getTime() : 0;
  const throttled = Date.now() - lastRequest < THROTTLE_MINUTES * 60 * 1000;
  if (throttled) return; // recently sent — don't send again, but still say nothing different

  const accessUrl = `${process.env.SITE_URL}/index.html?t=${tenant.access_token}`;

  const { error: sendError } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
    to: email,
    subject: "Your Warehouse Designer access link",
    html: `
      <p>Here's your Warehouse Designer access link:</p>
      <p><a href="${accessUrl}">${accessUrl}</a></p>
      <p>If you didn't request this, you can safely ignore this email — your link hasn't changed.</p>
    `,
  });
  if (sendError) throw sendError;

  const { error: updateError } = await supabaseAdmin
    .from("tenants")
    .update({ last_resend_requested_at: new Date().toISOString() })
    .eq("id", tenant.id);
  if (updateError) throw updateError;
}

function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function waitUntilMinimumElapsed(startedAt, minMs) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < minMs) {
    await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
  }
}