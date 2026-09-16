// Deletes a tenant entirely. The schema's foreign keys are all
// `on delete cascade` (members, warehouses, zones, items, history all
// reference tenants.id), so removing the tenant row here is enough —
// Postgres cleans up everything belonging to it automatically. This
// is irreversible; the UI is expected to confirm before calling this.

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedSecret = event.headers["x-admin-secret"];
  if (!providedSecret || providedSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let tenantId;
  try {
    const parsed = JSON.parse(event.body || "{}");
    tenantId = String(parsed.tenantId || "").trim();
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  if (!tenantId) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "tenantId is required" }) };
  }

  const { error } = await supabaseAdmin.from("tenants").delete().eq("id", tenantId);

  if (error) {
    console.error("admin-delete-tenant error:", error);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't delete tenant" }) };
  }

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) };
};

const jsonHeaders = { "Content-Type": "application/json" };