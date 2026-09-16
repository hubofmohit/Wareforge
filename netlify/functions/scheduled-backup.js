// Runs daily (see netlify.toml for the schedule). Snapshots every
// active tenant's warehouses/zones/items into the `backups` table,
// then prunes old SCHEDULED snapshots down to SCHEDULED_RETENTION —
// manual snapshots (triggered_by: 'manual') are never auto-pruned by
// this function, since the person who saved one presumably wants to
// keep it until they delete it themselves.
//
// Deliberately excludes `history` from the snapshot: this captures
// inventory state for disaster recovery, not the audit log — the
// audit log should stay continuous even across a restore, not get
// rewound along with the inventory.

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SCHEDULED_RETENTION = 15;

exports.handler = async () => {
  try {
    const { data: tenants, error: tenantsError } = await supabaseAdmin
      .from("tenants")
      .select("id")
      .eq("is_active", true);

    if (tenantsError) throw tenantsError;

    let succeeded = 0;
    let failed = 0;

    for (const tenant of tenants || []) {
      try {
        await snapshotTenant(tenant.id, "scheduled");
        await pruneOldBackups(tenant.id, "scheduled", SCHEDULED_RETENTION);
        succeeded++;
      } catch (e) {
        console.error(`scheduled-backup: failed for tenant ${tenant.id}:`, e);
        failed++;
      }
    }

    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, succeeded, failed }) };
  } catch (err) {
    console.error("scheduled-backup error:", err);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: "Scheduled backup run failed" }) };
  }
};

async function snapshotTenant(tenantId, triggeredBy) {
  const [{ data: warehouses, error: whErr }, { data: zones, error: zErr }, { data: items, error: iErr }] = await Promise.all([
    supabaseAdmin.from("warehouses").select("*").eq("tenant_id", tenantId),
    supabaseAdmin.from("zones").select("*").eq("tenant_id", tenantId),
    supabaseAdmin.from("items").select("*").eq("tenant_id", tenantId),
  ]);
  if (whErr) throw whErr;
  if (zErr) throw zErr;
  if (iErr) throw iErr;

  const { error: insertError } = await supabaseAdmin.from("backups").insert({
    tenant_id: tenantId,
    triggered_by: triggeredBy,
    data: { warehouses, zones, items },
  });
  if (insertError) throw insertError;
}

async function pruneOldBackups(tenantId, triggeredBy, keep) {
  const { data: rows, error } = await supabaseAdmin
    .from("backups")
    .select("id, created_at")
    .eq("tenant_id", tenantId)
    .eq("triggered_by", triggeredBy)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const toDelete = (rows || []).slice(keep).map((r) => r.id);
  if (toDelete.length) {
    await supabaseAdmin.from("backups").delete().in("id", toDelete);
  }
}

const jsonHeaders = { "Content-Type": "application/json" };

// Exported for create-backup.js to reuse the exact same snapshot
// logic for manual, on-demand backups — one code path for both,
// so they can never drift out of sync with each other.
module.exports.snapshotTenant = snapshotTenant;