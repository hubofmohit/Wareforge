// Health check for external uptime monitoring (e.g. UptimeRobot, Better
// Uptime — see the setup notes below). A 200 response means both this
// Netlify site and the Supabase database are reachable; a non-200 means
// one of them isn't.
//
// This does a trivial read (not a write) so it can't affect real data,
// and uses the service-role key only to bypass the need for a tenant
// token — it doesn't touch anything tenant-specific.

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async () => {
  try {
    const { error } = await supabaseAdmin.from("tenants").select("id").limit(1);
    if (error) throw error;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ok", checkedAt: new Date().toISOString() }),
    };
  } catch (err) {
    console.error("Health check failed:", err);
    return {
      statusCode: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "error", message: "Database unreachable" }),
    };
  }
};