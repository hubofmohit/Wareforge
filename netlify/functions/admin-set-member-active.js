// Activates or deactivates a single member. Same guard as
// admin-update-member.js and admin-delete-member.js: refuses to touch
// a member whose role is "admin" (the tenant's own root link) — to
// lock out an entire tenant, deactivate the tenant itself
// (admin-set-tenant-active.js) rather than this one row, so there's
// exactly one clear control for "shut off everything under here."

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

  let memberId, active;
  try {
    const parsed = JSON.parse(event.body || "{}");
    memberId = String(parsed.memberId || "").trim();
    active = Boolean(parsed.active);
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
    console.error("admin-set-member-active fetch error:", fetchError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't look up member" }) };
  }
  if (!existing) {
    return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: "No member with that id" }) };
  }
  if (existing.role === "admin") {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "This is the tenant's own root link — deactivate the tenant instead" }),
    };
  }

  const { error: updateError } = await supabaseAdmin.from("members").update({ is_active: active }).eq("id", memberId);

  if (updateError) {
    console.error("admin-set-member-active update error:", updateError);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Couldn't update member status" }) };
  }

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, active }) };
};

const jsonHeaders = { "Content-Type": "application/json" };