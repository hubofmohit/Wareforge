// Lists every member (person-level access link) under a given tenant,
// for the "Manage members" modal in admin.html. Same shared-secret
// auth as the other admin-* functions.

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

  const tenantId = event.queryStringParameters && event.queryStringParameters.tenantId;
  if (!tenantId) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "tenantId query param is required" }) };
  }

  const { data: members, error } = await supabaseAdmin
    .from("members")
    .select("id, name, role, access_token, created_at, is_active")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("admin-list-members error:", error);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't list members" }) };
  }

  const result = members.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    createdAt: m.created_at,
    accessUrl: `${process.env.SITE_URL}/index.html?t=${m.access_token}`,
    isActive: m.is_active,
  }));

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ members: result }) };
};

const jsonHeaders = { "Content-Type": "application/json" };