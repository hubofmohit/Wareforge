// Updates an existing member's name and/or role. Same shared-secret
// auth as the other admin-* functions.
//
// Deliberately refuses to touch a member whose current role is
// "admin" — that row is the tenant's own root link (created
// automatically alongside the tenant, sharing its access_token). It
// isn't a person you invited, and editing/demoting it here could
// silently strip a tenant of its own access. If you truly need to
// change a tenant's identity, do it through the tenant itself, not
// through this member-editing flow.

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EDITABLE_ROLES = ["editor", "viewer"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const providedSecret = event.headers["x-admin-secret"];
  if (!providedSecret || providedSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  let memberId, name, role;
  try {
    const parsed = JSON.parse(event.body || "{}");
    memberId = String(parsed.memberId || "").trim();
    name = parsed.name === undefined ? undefined : String(parsed.name).trim();
    role = parsed.role === undefined ? undefined : String(parsed.role).trim().toLowerCase();
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  if (!memberId) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "memberId is required" }) };
  }
  if (role !== undefined && !EDITABLE_ROLES.includes(role)) {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: `role must be one of: ${EDITABLE_ROLES.join(", ")}` }),
    };
  }

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("members")
    .select("id, role")
    .eq("id", memberId)
    .maybeSingle();

  if (fetchError) {
    console.error("admin-update-member fetch error:", fetchError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't look up member" }) };
  }
  if (!existing) {
    return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: "No member with that id" }) };
  }
  if (existing.role === "admin") {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "This is the tenant's own root link and can't be edited here" }),
    };
  }

  const updates = {};
  if (name !== undefined) updates.name = name || null;
  if (role !== undefined) updates.role = role;

  if (!Object.keys(updates).length) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Nothing to update" }) };
  }

  const { error: updateError } = await supabaseAdmin.from("members").update(updates).eq("id", memberId);

  if (updateError) {
    console.error("admin-update-member update error:", updateError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't update member" }) };
  }

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) };
};

const jsonHeaders = { "Content-Type": "application/json" };