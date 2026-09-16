// Activates or deactivates a tenant. A deactivated tenant loses ALL
// access immediately — every member link under it (including its own
// root link) stops resolving, because current_tenant_id() checks
// tenants.is_active. Nothing is deleted; reactivating restores access
// exactly as it was.

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

  let tenantId, active;
  try {
    const parsed = JSON.parse(event.body || "{}");
    tenantId = String(parsed.tenantId || "").trim();
    active = Boolean(parsed.active);
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  if (!tenantId) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "tenantId is required" }) };
  }

  const { error } = await supabaseAdmin.from("tenants").update({ is_active: active }).eq("id", tenantId);

  if (error) {
    console.error("admin-set-tenant-active error:", error);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't update tenant status" }) };
  }

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, active }) };
};

const jsonHeaders = { "Content-Type": "application/json" };