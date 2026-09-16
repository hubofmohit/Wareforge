// Lets any active member save a snapshot on demand from inside the
// app itself (the "Save Snapshot Now" menu item), separate from the
// daily automatic ones. Authenticated by the member's own
// x-access-token — NOT the admin secret — since this is a per-tenant
// action any team member should be able to trigger, not an
// admin-only operation.
//
// No role restriction beyond "active member of an active tenant":
// saving a snapshot only reads warehouses/zones/items and writes to
// the separate backups table — it never touches live inventory data,
// so even a viewer can safely trigger one.

const { createClient } = require("@supabase/supabase-js");
const { snapshotTenant } = require("./scheduled-backup");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const accessToken = event.headers["x-access-token"];
  if (!accessToken) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: "Missing access token" }) };
  }

  const { data: member, error: memberError } = await supabaseAdmin
    .from("members")
    .select("tenant_id, is_active, tenants!inner(is_active)")
    .eq("access_token", accessToken)
    .maybeSingle();

  if (memberError) {
    console.error("create-backup member lookup error:", memberError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't verify access" }) };
  }
  if (!member || !member.is_active || !member.tenants.is_active) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid or inactive access" }) };
  }

  try {
    await snapshotTenant(member.tenant_id, "manual");
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("create-backup snapshot error:", err);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't save snapshot" }) };
  }
};

const jsonHeaders = { "Content-Type": "application/json" };