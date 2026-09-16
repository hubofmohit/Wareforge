// Removes a single member's access. Same guard as admin-update-member:
// refuses to touch a member whose role is "admin", since that row is
// the tenant's own root link, not a person you invited — deleting it
// would silently lock the tenant out while leaving the tenant record
// itself in place. To remove a tenant entirely, delete the tenant
// (admin-delete-tenant.js), not this member row.

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

  let memberId;
  try {
    const parsed = JSON.parse(event.body || "{}");
    memberId = String(parsed.memberId || "").trim();
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  if (!memberId) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "memberId is required" }) };
  }

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("members")
    .select("id, role")
    .eq("id", memberId)
    .maybeSingle();

  if (fetchError) {
    console.error("admin-delete-member fetch error:", fetchError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't look up member" }) };
  }
  if (!existing) {
    return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: "No member with that id" }) };
  }
  if (existing.role === "admin") {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "This is the tenant's own root link — delete the tenant instead to remove it" }),
    };
  }

  const { error: deleteError } = await supabaseAdmin.from("members").delete().eq("id", memberId);

  if (deleteError) {
    console.error("admin-delete-member delete error:", deleteError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't remove member" }) };
  }

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true }) };
};

const jsonHeaders = { "Content-Type": "application/json" };