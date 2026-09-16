// Lists every tenant — this is how you (the admin) see everyone using the
// app. Same shared-secret auth as admin-create-tenant.js.

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedSecret = event.headers["x-admin-secret"];
  if (!providedSecret || providedSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const { data: tenants, error: tenantsError } = await supabaseAdmin
    .from("tenants")
    .select("id, email, access_token, created_at, is_active")
    .order("created_at", { ascending: false });

  if (tenantsError) {
    console.error("admin-list-tenants error:", tenantsError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't list tenants" }) };
  }

  // Two extra queries for quick usage signals per tenant — warehouse
  // count and member count — so the admin panel shows more than just
  // "a link exists." Neither is a write, so this stays safe to call
  // as often as the panel wants to refresh.
  const [{ data: warehouseCounts, error: countError }, { data: memberCounts, error: memberCountError }] = await Promise.all([
    supabaseAdmin.from("warehouses").select("tenant_id"),
    supabaseAdmin.from("members").select("tenant_id"),
  ]);

  if (countError) console.error("admin-list-tenants warehouse count error:", countError);
  if (memberCountError) console.error("admin-list-tenants member count error:", memberCountError);

  const countsByTenant = {};
  (warehouseCounts || []).forEach((w) => {
    countsByTenant[w.tenant_id] = (countsByTenant[w.tenant_id] || 0) + 1;
  });

  const memberCountsByTenant = {};
  (memberCounts || []).forEach((m) => {
    memberCountsByTenant[m.tenant_id] = (memberCountsByTenant[m.tenant_id] || 0) + 1;
  });

  const result = tenants.map((t) => ({
    id: t.id,
    email: t.email,
    createdAt: t.created_at,
    accessUrl: `${process.env.SITE_URL}/index.html?t=${t.access_token}`,
    warehouseCount: countsByTenant[t.id] || 0,
    memberCount: memberCountsByTenant[t.id] || 0,
    isActive: t.is_active,
  }));

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ tenants: result }) };
};

const jsonHeaders = { "Content-Type": "application/json" };