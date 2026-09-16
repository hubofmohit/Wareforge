// Creates a member (a per-person access link) under an existing tenant.
// Same shared-secret auth as admin-create-tenant.js — this is an
// admin-only endpoint, not something a tenant calls for themselves.
//
// Role is restricted to "editor" or "viewer" server-side, matching the
// admin.html UI (which never offers "admin" as an option). There is
// intentionally exactly one admin — whoever holds ADMIN_SECRET — and
// that isn't a member row at all.

const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CREATABLE_ROLES = ["editor", "viewer"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedSecret = event.headers["x-admin-secret"];
  if (!providedSecret || providedSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let tenantId, name, role;
  try {
    const parsed = JSON.parse(event.body || "{}");
    tenantId = String(parsed.tenantId || "").trim();
    name = String(parsed.name || "").trim();
    role = String(parsed.role || "editor").trim().toLowerCase();
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  if (!tenantId) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "tenantId is required" }) };
  }
  if (!CREATABLE_ROLES.includes(role)) {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: `role must be one of: ${CREATABLE_ROLES.join(", ")}` }),
    };
  }

  // Confirm the tenant actually exists before creating a member under
  // it — otherwise a typo'd tenantId silently creates an orphaned row.
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .maybeSingle();

  if (tenantError) {
    console.error("admin-create-member tenant lookup error:", tenantError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't verify tenant" }) };
  }
  if (!tenant) {
    return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: "No tenant with that id" }) };
  }

  const accessToken = randomUUID();

  const { error: insertError } = await supabaseAdmin.from("members").insert({
    tenant_id: tenantId,
    access_token: accessToken,
    name: name || null,
    role,
  });

  if (insertError) {
    console.error("admin-create-member insert error:", insertError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't create member" }) };
  }

  const accessUrl = `${process.env.SITE_URL}/index.html?t=${accessToken}`;

  return {
    statusCode: 200,
    headers: jsonHeaders,
    body: JSON.stringify({ accessUrl, name: name || null, role }),
  };
};

const jsonHeaders = { "Content-Type": "application/json" };