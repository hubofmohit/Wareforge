// Creates a new tenant. This is now the ONLY way a tenant gets created —
// there's no self-serve signup and no payment gate. Access is controlled
// entirely by you (the admin) deciding who gets a link.
//
// Auth: a shared secret (ADMIN_SECRET env var) sent as the x-admin-secret
// header. This is intentionally simple — a single password, not a real
// multi-user auth system — which is appropriate for "just me as admin."
// If more than one person will manage tenants, or if this needs to be
// more robust, that's worth upgrading later (e.g. Netlify Identity, or a
// proper login system) rather than adding more shared secrets.
//
// No email is sent here — the admin panel shows the link and copies it
// to the clipboard; you share it yourself however you like. The email
// field is stored purely so the admin panel can show who a link belongs
// to (and so recover.html / resend-link.js can look someone up by it if
// you re-enable sending later).

const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedSecret = event.headers["x-admin-secret"];
  if (!providedSecret || providedSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let email = "";
  try {
    const parsed = JSON.parse(event.body || "{}");
    email = String(parsed.email || "").trim().toLowerCase();
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const accessToken = randomUUID();

  const { error: insertError } = await supabaseAdmin.from("tenants").insert({
    access_token: accessToken,
    email: email || null,
  });

  if (insertError) {
    console.error("admin-create-tenant insert error:", insertError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't create tenant" }) };
  }

  // IMPORTANT: current_tenant_id() and current_member_role() resolve
  // exclusively through the `members` table now (see the roles
  // migration) — a tenant with no matching members row can never
  // resolve its own tenant id and gets sent to no-access.html. Every
  // tenant needs exactly one "admin" member sharing its own token, so
  // its original link keeps full access, the same way the one-time
  // backfill did for tenants that existed before this migration.
  const { data: tenantRow, error: fetchTenantError } = await supabaseAdmin
    .from("tenants")
    .select("id")
    .eq("access_token", accessToken)
    .single();

  if (fetchTenantError || !tenantRow) {
    console.error("admin-create-tenant: couldn't re-fetch tenant for member backfill:", fetchTenantError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Tenant created but member link failed" }) };
  }

  const { error: memberInsertError } = await supabaseAdmin.from("members").insert({
    tenant_id: tenantRow.id,
    access_token: accessToken,
    name: email || null,
    role: "admin",
  });

  if (memberInsertError) {
    console.error("admin-create-tenant member backfill error:", memberInsertError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Tenant created but couldn't grant it access" }) };
  }

  const accessUrl = `${process.env.SITE_URL}/index.html?t=${accessToken}`;

  return {
    statusCode: 200,
    headers: jsonHeaders,
    body: JSON.stringify({ accessUrl, email: email || null }),
  };
};

const jsonHeaders = { "Content-Type": "application/json" };