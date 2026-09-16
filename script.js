"use strict";

/*
   Warehouse Designer — fully client-side.

   No backend, no accounts: everything lives in this browser's
   localStorage under STORAGE_KEY. That means data doesn't sync across
   devices and clearing browser data erases it — Export JSON/Excel is
   the way to keep a real backup. This mirrors the earlier Supabase
   version's data shape exactly, so swapping in a real backend later is
   a matter of replacing load()/save() with network calls; nothing else
   needs to change.
*/

const STORAGE_KEY = "warehouseDesignerState";
// Separate from STORAGE_KEY on purpose — this is disposable "recent edit"
// scratch data (per browser, per tenant-in-this-browser), not the synced
// inventory itself, so it's kept in its own key rather than folded into
// appState.
const UNDO_STORAGE_KEY = "warehouseDesignerUndoStacks";
// Remembers which location was open, per tenant, so a page refresh in
// cloud mode doesn't silently jump back to the first location when
// there are several. Keyed by tenantId (not just one bare id) since a
// single browser can hold links to more than one tenant. Local-only
// mode doesn't need this — appState.activeId there is already part of
// the single blob saved under STORAGE_KEY.
const REDO_STORAGE_KEY = "warehouseDesignerRedoStacks";

const ACTIVE_WAREHOUSE_STORAGE_KEY = "warehouseDesignerActiveWarehouseByTenant";
const DEFAULT_MIN_QTY = 2; // used when an item has no minQty set (e.g. old saved data)
const SNAP_STEP = 20;
const UNDO_MAX = 40;
const HISTORY_MAX = 300;

/* ---------- state ---------- */

let appState = { activeId: null, warehouses: {}, history: [] };
let warehouse = { length: 1000, breadth: 600 }; // working copy of the active location's dims
let zones = []; // working copy of the active location's zones
let selectedZoneId = null;
let scale = 1;
let layoutEditMode = false;
let snapEnabled = true;
let undoStacksById = {};
let undoStack = [];
let redoStacksById = {};
let redoStack = [];

/* ---------- roles / view-only access ----------
   currentRole is resolved once at boot from the server (see bootTenant).
   It stays `null` when there's no member/role system yet (e.g. the
   schema hasn't been migrated, or Supabase isn't configured at all) —
   null means "don't restrict anything," so this is safe to ship before
   the members/roles migration exists. Once that migration is live,
   current_role() will return "admin" | "editor" | "viewer" and this
   starts actually gating writes. */
let currentRole = null;
let currentMemberId = null;              // resolved at boot — "who am I" for attributing new local actions instantly
let memberNameById = new Map();          // id -> display label, for showing "by X" on history entries fetched from the server
let rosterLoaded = false;                // true only once tenant_members_public() has actually succeeded — see getMemberLabel

function isViewOnly() {
  return currentRole === "viewer";
}

// Call at the top of any handler that writes data. Returns true (and
// shows a toast) if the action should be stopped.
function blockIfViewOnly() {
  if (isViewOnly()) {
    showToast("You have view-only access", "danger");
    return true;
  }
  return false;
}

// Visually disables edit/delete controls for viewers, once the role is
// known. This is cosmetic on top of the real protection — the guard
// lines in each handler (and, once added, the database RLS rules) are
// what actually stop the write; this just avoids showing someone a
// button that will immediately refuse them.
function applyViewOnlyUI() {
  if (!isViewOnly()) return;
  const selectors = [
    "#addZoneBtn", "#newWarehouseBtn", "#renameWarehouseBtn", "#deleteWarehouseBtn",
    "#deleteZoneBtn", "#undoBtn", "#importBtn",
    "#addItemForm button", "#tableAddItemForm button",
    "#tableAddZoneForm button", "#tableAddLocationForm button",
    ".delete-btn", ".table-row-delete",
  ];
  document.querySelectorAll(selectors.join(", ")).forEach((el) => { el.disabled = true; });
  showToast("You have view-only access", "success");
}

// "Who made this change" label for a history entry. Returns null when
// there's nothing meaningful to show (local-only mode with no member
// system at all, or an entry predating this feature) — callers should
// skip rendering attribution entirely in that case, not show a blank.
function getMemberLabel(memberId) {
  if (!memberId) return null;
  if (memberId === currentMemberId) return "You";
  if (memberNameById.has(memberId)) return memberNameById.get(memberId);
  // Absent from a roster that genuinely loaded means they were
  // actually deleted (deactivated members still appear — see
  // tenant_members_public()). Absent because the roster fetch itself
  // failed is a different, temporary situation — don't guess.
  return rosterLoaded ? "Former member" : null;
}

/* ---------- Supabase (cloud backend, admin-provisioned access) ----------
   Fill these in from your Supabase project (Settings → API), and run
   supabase-schema.sql once in the SQL Editor. There is no self-signup:
   an admin creates each access link from admin.html. The token from
   that link (?t=...) is sent as a custom header on every request;
   Postgres RLS (via current_tenant_id(), see the schema file) only
   lets a visitor see rows belonging to their own tenant. No token, or
   an unrecognized one, sends the visitor to no-access.html. If
   SUPABASE_URL is left as a placeholder, the app falls back to
   local-only mode (same behavior as the original app). */
const SUPABASE_URL = "https://berahbwqlnntncgiterv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlcmFoYndxbG5udG5jZ2l0ZXJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MjEyNjAsImV4cCI6MjEwMzk5NzI2MH0.Vjs76cbSjafoNE8vHIG4D91v5XjplNyJeqY651dbsHk";
const SUPABASE_CONFIGURED = window.supabase && !SUPABASE_URL.startsWith("YOUR_");

let supa = null;         // created once the access token is known (needs it as a header)
let accessToken = null;  // the ?t= token from the URL — sent as x-access-token on every request
let tenantId = null;     // resolved server-side from accessToken; used only for the realtime filter
let isSyncing = false;   // true while we're pushing our own change, so we ignore the realtime echo of it
let knownIds = { warehouses: new Set(), zones: new Set(), items: new Set() }; // last-pushed server row IDs, used to detect deletions

const HISTORY_CATEGORIES = {
  zone: { label: "Zones", icon: "▭" },
  item: { label: "Items", icon: "◆" },
  location: { label: "Locations", icon: "⌂" },
  backup: { label: "Backups", icon: "⇅" },
  return: { label: "Returns", icon: "↩" },
  undo: { label: "Undo", icon: "↶" },
  other: { label: "Other", icon: "•" },
};

/* ---------- DOM references ---------- */

const warehouseEl = document.getElementById("warehouse");
const canvasWrap = document.getElementById("canvasWrap");
const lengthInput = document.getElementById("warehouseLength");
const breadthInput = document.getElementById("warehouseBreadth");
const editLayoutToggle = document.getElementById("editLayoutToggle");
const snapToggle = document.getElementById("snapToggle");
const addZoneBtn = document.getElementById("addZoneBtn");
const gridTemplateBtn = document.getElementById("gridTemplateBtn");
const aisleTemplateBtn = document.getElementById("aisleTemplateBtn");
const autoArrangeBtn = document.getElementById("autoArrangeBtn");
const layoutToolsMenu = document.getElementById("layoutToolsMenu");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const canvasHint = document.getElementById("canvasHint");
const emptyState = document.getElementById("emptyState");
const zoneEditor = document.getElementById("zoneEditor");
const zoneNameInput = document.getElementById("zoneName");
const zoneStatusDot = document.getElementById("zoneStatusDot");
const zoneXInput = document.getElementById("zoneX");
const zoneYInput = document.getElementById("zoneY");
const zoneWidthInput = document.getElementById("zoneWidth");
const zoneHeightInput = document.getElementById("zoneHeight");
const deleteZoneBtn = document.getElementById("deleteZoneBtn");
const itemListEl = document.getElementById("itemList");
const itemCountBadge = document.getElementById("itemCountBadge");
const addItemForm = document.getElementById("addItemForm");
const newItemNameInput = document.getElementById("newItemName");
const newItemQtyInput = document.getElementById("newItemQty");
const newItemMinInput = document.getElementById("newItemMin");
const scaleBadge = document.getElementById("scaleBadge");
const overlapBadge = document.getElementById("overlapBadge");
const toastContainer = document.getElementById("toastContainer");
const warehouseSelect = document.getElementById("warehouseSelect");
const newWarehouseBtn = document.getElementById("newWarehouseBtn");
const renameWarehouseBtn = document.getElementById("renameWarehouseBtn");
const deleteWarehouseBtn = document.getElementById("deleteWarehouseBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const exportExcelBtn = document.getElementById("exportExcelBtn");
const importBtn = document.getElementById("importBtn");
const importFileInput = document.getElementById("importFileInput");
const searchInput = document.getElementById("searchInput");
const searchResultsEl = document.getElementById("searchResults");
const tabradioDetails = document.getElementById("tabradio-details");
const tabradioHistory = document.getElementById("tabradio-history");
const historyListEl = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const scoperadioCurrent = document.getElementById("scoperadio-current");
const scoperadioAll = document.getElementById("scoperadio-all");
const catradios = document.querySelectorAll('input[name="historyCategory"]');
const tableViewToggle = document.getElementById("tableViewToggle");
const mobileMenuToggle = document.getElementById("mobileMenuToggle");
const drawerCloseBtn = document.getElementById("drawerCloseBtn");
const copyAccessLinkBtn = document.getElementById("copyAccessLinkBtn");
const saveSnapshotBtn = document.getElementById("saveSnapshotBtn");
const openBackupHistoryBtn = document.getElementById("openBackupHistoryBtn");
const backupHistoryOverlay = document.getElementById("backupHistoryOverlay");
const backupHistoryBackdrop = document.getElementById("backupHistoryBackdrop");
const backupHistoryCloseBtn = document.getElementById("backupHistoryCloseBtn");
const backupHistoryList = document.getElementById("backupHistoryList");
const backupHistoryLoading = document.getElementById("backupHistoryLoading");
const backupHistoryEmpty = document.getElementById("backupHistoryEmpty");

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- toasts ---------- */

function showToast(message, variant) {
  const toast = document.createElement("div");
  toast.className = "toast" + (variant ? ` toast--${variant}` : "");
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

/* ---------- low stock: alert + badges ---------- */

// Call right after mutating item.qty, passing the qty it had *before*
// the change. Only alerts on the transition (crossing the threshold),
// not on every edit — otherwise editing an already-low item would spam
// a toast on every keystroke.
function trackQtyChange(item, oldQty) {
  const min = itemMinQty(item);
  const wasLow = oldQty <= min;
  const nowLow = item.qty <= min;
  if (nowLow && !wasLow) {
    showToast(`⚠ "${item.name}" is running low — ${item.qty} left (min ${min})`, "danger");
  } else if (!nowLow && wasLow) {
    showToast(`"${item.name}" restocked (${item.qty})`, "success");
  }
}

function countLowStockItems() {
  let count = 0;
  Object.values(appState.warehouses).forEach((entry) => {
    entry.zones.forEach((zone) => {
      zone.items.forEach((item) => { if (isLowStock(item)) count++; });
    });
  });
  return count;
}

const lowStockBadgeEls = [
  document.getElementById("headerLowStockBadge"),
  document.getElementById("mobileLowStockBadge"),
  document.getElementById("tabLowStockBadge"),
].filter(Boolean);

function updateLowStockBadges() {
  const count = countLowStockItems();
  lowStockBadgeEls.forEach((el) => {
    el.textContent = count > 99 ? "99+" : String(count);
    el.hidden = count === 0;
  });
}

/* ---------- cloud sync (Supabase) ----------
   Reads/writes the same appState shape used everywhere else in this
   file. Local rendering code (renderWarehouse, renderSidebar, table
   view, etc.) is completely unchanged — this layer only concerns
   itself with getting appState into and out of Postgres, and keeping
   other signed-in devices in sync via Realtime. */

// Shared by cloudFetchAll() (the live tables) and restoreFromBackup()
// (a snapshot's saved data) — same row shape either way, so both
// paths build the exact same nested warehouses object and can never
// drift apart from each other.
function rowsToWarehouses(whRows, zoneRows, itemRows) {
  const warehouses = {};
  whRows.forEach((w) => {
    warehouses[w.id] = { id: w.id, name: w.name, warehouse: { length: w.length, breadth: w.breadth }, zones: [] };
  });
  const zoneById = {};
  zoneRows.forEach((z) => {
    const zone = { id: z.id, name: z.name, x: z.x, y: z.y, width: z.width, height: z.height, items: [] };
    zoneById[z.id] = zone;
    if (warehouses[z.warehouse_id]) warehouses[z.warehouse_id].zones.push(zone);
  });
  itemRows.forEach((i) => {
    const zone = zoneById[i.zone_id];
    if (zone) zone.items.push({ id: i.id, name: i.name, qty: i.qty, minQty: i.min_qty });
  });
  return warehouses;
}

async function cloudFetchAll() {
  const [{ data: whRows, error: whErr }, { data: zoneRows, error: zoneErr }, { data: itemRows, error: itemErr }, { data: histRows, error: histErr }] =
    await Promise.all([
      supa.from("warehouses").select("*").order("created_at", { ascending: true }),
      supa.from("zones").select("*"),
      supa.from("items").select("*"),
      supa.from("history").select("*").order("ts", { ascending: false }).limit(HISTORY_MAX),
    ]);
  if (whErr) throw whErr;
  if (zoneErr) throw zoneErr;
  if (itemErr) throw itemErr;
  if (histErr) throw histErr;

  const warehouses = rowsToWarehouses(whRows, zoneRows, itemRows);
  const history = histRows.map((h) => ({ text: h.text, ts: new Date(h.ts).getTime(), category: h.category, locationId: h.warehouse_id, memberId: h.member_id }));

  return { warehouses, history };
}

function refreshKnownIds() {
  knownIds.warehouses = new Set(Object.keys(appState.warehouses));
  knownIds.zones = new Set(Object.values(appState.warehouses).flatMap((w) => w.zones.map((z) => z.id)));
  knownIds.items = new Set(Object.values(appState.warehouses).flatMap((w) => w.zones.flatMap((z) => z.items.map((i) => i.id))));
}

async function cloudPruneDeleted(whIds, zoneIds, itemIds) {
  const deletedItemIds = [...knownIds.items].filter((id) => !itemIds.has(id));
  const deletedZoneIds = [...knownIds.zones].filter((id) => !zoneIds.has(id));
  const deletedWhIds = [...knownIds.warehouses].filter((id) => !whIds.has(id));
  if (deletedItemIds.length) await supa.from("items").delete().in("id", deletedItemIds);
  if (deletedZoneIds.length) await supa.from("zones").delete().in("id", deletedZoneIds);
  if (deletedWhIds.length) await supa.from("warehouses").delete().in("id", deletedWhIds);
}

async function cloudPushAll() {
  if (!supa || !tenantId) return;
  isSyncing = true;
  try {
    const whPayload = Object.values(appState.warehouses).map((w) => ({
      id: w.id, tenant_id: tenantId, name: w.name, length: w.warehouse.length, breadth: w.warehouse.breadth,
    }));
    const zonePayload = [];
    const itemPayload = [];
    Object.values(appState.warehouses).forEach((w) => {
      w.zones.forEach((z) => {
        zonePayload.push({ id: z.id, tenant_id: tenantId, warehouse_id: w.id, name: z.name, x: z.x, y: z.y, width: z.width, height: z.height });
        z.items.forEach((i) => {
          itemPayload.push({ id: i.id, tenant_id: tenantId, zone_id: z.id, name: i.name, qty: i.qty, min_qty: itemMinQty(i) });
        });
      });
    });

    if (whPayload.length) { const { error } = await supa.from("warehouses").upsert(whPayload); if (error) throw error; }
    if (zonePayload.length) { const { error } = await supa.from("zones").upsert(zonePayload); if (error) throw error; }
    if (itemPayload.length) { const { error } = await supa.from("items").upsert(itemPayload); if (error) throw error; }

    await cloudPruneDeleted(
      new Set(whPayload.map((r) => r.id)),
      new Set(zonePayload.map((r) => r.id)),
      new Set(itemPayload.map((r) => r.id))
    );
    refreshKnownIds();
  } catch (e) {
    console.error("Cloud sync failed.", e);
    showToast("Sync failed — changes saved locally only", "danger");
  } finally {
    isSyncing = false;
  }
}

async function cloudLogHistory(entry) {
  if (!supa || !tenantId) return;
  try {
    const { error } = await supa.from("history").insert({
      tenant_id: tenantId,
      warehouse_id: entry.locationId,
      text: entry.text,
      category: entry.category,
      ts: new Date(entry.ts).toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    console.error("History sync failed.", e);
  }
}

/* ---------- immediate, explicit deletes ----------
   cloudPushAll()'s prune step infers deletions by diffing the
   current local state against a client-cached "last known" list —
   that's fine for a single user, but unsafe the moment a second
   browser tab (a teammate, or you on another device) is involved: if
   their local copy hasn't yet caught up to a deletion you just made,
   their next unrelated save pushes THEIR still-stale full zone list,
   which silently resurrects whatever you just deleted, because
   nothing in that push says "and delete this one" — it just re-sends
   what looks, to them, like the current truth.
   
   These helpers fire an explicit, targeted DELETE the moment the
   action happens, independent of any other client's state. A
   deletion can no longer be undone by someone else's stale save,
   because there's nothing left for a stale upsert to resurrect. */

async function cloudDeleteZone(zoneId) {
  if (!supa || !tenantId) return;
  try {
    const { error } = await supa.from("zones").delete().eq("id", zoneId);
    if (error) throw error;
  } catch (e) {
    console.error("Immediate zone delete failed — the next full sync's cleanup will still catch it eventually.", e);
  }
}

async function cloudDeleteItem(itemId) {
  if (!supa || !tenantId) return;
  try {
    const { error } = await supa.from("items").delete().eq("id", itemId);
    if (error) throw error;
  } catch (e) {
    console.error("Immediate item delete failed — the next full sync's cleanup will still catch it eventually.", e);
  }
}

async function cloudDeleteWarehouse(warehouseId) {
  if (!supa || !tenantId) return;
  try {
    const { error } = await supa.from("warehouses").delete().eq("id", warehouseId);
    if (error) throw error;
  } catch (e) {
    console.error("Immediate location delete failed — the next full sync's cleanup will still catch it eventually.", e);
  }
}

let remoteRefreshTimer = null;

function handleRemoteChange() {
  if (isSyncing) return; // ignore the echo of our own writes
  clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = setTimeout(refreshFromCloud, 200);
}

async function refreshFromCloud() {
  if (!supa || !tenantId) return;
  try {
    const { warehouses, history } = await cloudFetchAll();
    if (!Object.keys(warehouses).length) return;
    const activeId = warehouses[appState.activeId] ? appState.activeId : Object.keys(warehouses)[0];
    appState = { activeId, warehouses, history };
    warehouse = appState.warehouses[activeId].warehouse;
    zones = appState.warehouses[activeId].zones;
    if (selectedZoneId && !zones.find((z) => z.id === selectedZoneId)) selectedZoneId = null;
    refreshKnownIds();

    lengthInput.value = warehouse.length;
    breadthInput.value = warehouse.breadth;
    renderWarehouseSelect();
    renderWarehouse();
    renderSidebar();
    renderHistory();
    refreshTableViewIfOpen();
    showToast("Updated by a teammate", "success");
  } catch (e) {
    console.error("Realtime refresh failed.", e);
  }
}

function subscribeRealtime() {
  if (!supa || !tenantId) return;
  supa
    .channel("warehouse-sync-" + tenantId)
    .on("postgres_changes", { event: "*", schema: "public", table: "warehouses", filter: `tenant_id=eq.${tenantId}` }, handleRemoteChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "zones", filter: `tenant_id=eq.${tenantId}` }, handleRemoteChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: `tenant_id=eq.${tenantId}` }, handleRemoteChange)
    .subscribe();
}

/* ---------- persistence (localStorage only — no backend) ---------- */

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.warehouses) return null;
    return parsed;
  } catch (e) {
    console.error("Couldn't read saved data.", e);
    return null;
  }
}

let saveDebounceTimer = null;

// cloudPushAll() reads and mutates a shared knownIds cache to figure
// out which rows were deleted since the last push. If two pushes ever
// ran concurrently (e.g. several zone-replacing actions fired in
// quick succession — templates, undo, a resize, each within the same
// debounce window), the second one could start diffing against a
// knownIds snapshot the first hadn't finished updating yet, and miss
// deleting rows that were genuinely gone. Those rows then sit
// orphaned in Supabase and resurface on the next fetch, alongside
// whatever's actually correct — which looks exactly like "zones I
// didn't create" overlapping the real ones. Chaining every push
// through this promise guarantees strict one-at-a-time ordering, so
// each push always diffs against the true post-previous-push state.
let cloudPushChain = Promise.resolve();

function save() {
  syncActiveIntoState();
  updateLowStockBadges();
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState)); // offline cache / instant reload
    } catch (e) {
      console.error("Couldn't save.", e);
      showToast("Couldn't save — your browser storage may be full", "danger");
    }
    if (supa && tenantId) {
      cloudPushChain = cloudPushChain.then(() => cloudPushAll()).catch((e) => console.error("Queued cloud push failed.", e));
    }
  }, 250);
}

function syncActiveIntoState() {
  if (!appState.activeId || !appState.warehouses[appState.activeId]) return;
  appState.warehouses[appState.activeId].warehouse = warehouse;
  appState.warehouses[appState.activeId].zones = zones;
}

function createWarehouseEntry(name, dims) {
  const id = newId();
  appState.warehouses[id] = {
    id,
    name,
    warehouse: dims ? { ...dims } : { length: 1000, breadth: 600 },
    zones: [],
  };
  return id;
}

function seedDemoData() {
  // First-ever run: give the app some example content so the floor plan
  // and table view aren't empty on first look. Freely editable/deletable.
  const id = createWarehouseEntry("Warehouse 1");
  const w = appState.warehouses[id];
  const z = (name, x, y, width, height, items) => ({ id: newId(), name, x, y, width, height, items });
  const i = (name, qty, minQty = DEFAULT_MIN_QTY) => ({ id: newId(), name, qty, minQty });

  w.zones.push(
    z("Receiving", 40, 40, 260, 200, [i("Pallet jacks", 4, 2), i("Barcode scanners", 6, 3)]),
    z("Fasteners", 340, 40, 200, 200, [i("M6 hex bolts", 2, 5), i("Washers", 40, 20)]),
    z("Bulk Storage", 580, 40, 380, 340, [i("Pallet wrap", 28, 10), i("Shrink film", 10, 5)]),
    z("Returns", 40, 280, 260, 120, []),
    z("Packing", 340, 280, 200, 200, [i("Shipping labels", 6, 5), i("Bubble wrap roll", 3, 5)])
  );

  appState.activeId = id;
  logEvent(`Set up <strong>${escapeHtml(w.name)}</strong> with some example zones to get you started`, "backup", null);
}

// Fills in minQty on any item that doesn't have one — covers data saved
// before this feature existed, plus anything that comes in through
// import that wasn't exported by this app.
function backfillMinQty(state) {
  Object.values(state.warehouses || {}).forEach((entry) => {
    (entry.zones || []).forEach((zone) => {
      (zone.items || []).forEach((item) => {
        if (item.minQty == null) item.minQty = DEFAULT_MIN_QTY;
      });
    });
  });
}

function load() {
  const stored = loadFromStorage();
  if (stored) {
    appState = stored;
    if (!Array.isArray(appState.history)) appState.history = [];
    if (!appState.activeId || !appState.warehouses[appState.activeId]) {
      appState.activeId = Object.keys(appState.warehouses)[0] || null;
    }
    if (!appState.activeId) {
      const id = createWarehouseEntry("Warehouse 1");
      appState.activeId = id;
    }
    backfillMinQty(appState);
    return;
  }
  appState = { activeId: null, warehouses: {}, history: [] };
  seedDemoData();
}

/* ---------- activity history ---------- */

function logEvent(html, category = "other", locationId = appState.activeId) {
  if (!appState.history) appState.history = [];
  // memberId here is purely optimistic, for instant display — the
  // server round-trip (cloudLogHistory) doesn't send it at all; the
  // authoritative value is set by a database trigger from the actual
  // authenticated access token, not trusted from this client value.
  const entry = { text: html, ts: Date.now(), category, locationId, memberId: currentMemberId };
  appState.history.unshift(entry);
  if (appState.history.length > HISTORY_MAX) appState.history.length = HISTORY_MAX;
  save();
  renderHistory();
  cloudLogHistory(entry);
}

function relativeTime(ts) {
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayHeading(ts) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date());
  const entryDay = startOfDay(new Date(ts));
  const diffDays = Math.round((today - entryDay) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: "long" });
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(ts).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function getFilteredHistory() {
  const hist = appState.history || [];
  const category = [...catradios].find((r) => r.checked)?.id.replace("catradio-", "") || "all";
  const scope = scoperadioAll.checked ? "all" : "current";

  return hist.filter((entry) => {
    if (category !== "all" && (entry.category || "other") !== category) return false;
    if (scope === "current" && entry.locationId && entry.locationId !== appState.activeId) return false;
    return true;
  });
}

function renderHistory() {
  const hist = appState.history || [];
  const filtered = getFilteredHistory();
  historyListEl.innerHTML = "";

  if (!filtered.length) {
    const li = document.createElement("li");
    li.className = "history-empty-msg";
    li.textContent = hist.length ? "No activity matches these filters." : "No activity yet.";
    historyListEl.appendChild(li);
    return;
  }

  let lastHeading = null;
  filtered.forEach((entry) => {
    const heading = dayHeading(entry.ts);
    if (heading !== lastHeading) {
      const headingEl = document.createElement("li");
      headingEl.className = "history-day-heading";
      headingEl.textContent = heading;
      historyListEl.appendChild(headingEl);
      lastHeading = heading;
    }

    const category = entry.category || "other";
    const meta = HISTORY_CATEGORIES[category] || HISTORY_CATEGORIES.other;
    const authorLabel = getMemberLabel(entry.memberId);
    const li = document.createElement("li");
    li.className = `history-item history-item--${category}`;
    li.innerHTML = `
      <span class="history-item__icon" title="${meta.label}" aria-hidden="true">${meta.icon}</span>
      <div class="history-item__body">
        <div class="history-item__text">${entry.text}</div>
        <div class="history-item__time">${relativeTime(entry.ts)}${authorLabel ? ` · by ${escapeHtml(authorLabel)}` : ""}</div>
      </div>`;
    historyListEl.appendChild(li);
  });
}

[scoperadioCurrent, scoperadioAll, ...catradios].forEach((el) => el.addEventListener("change", renderHistory));

clearHistoryBtn.addEventListener("click", () => {
  if (!appState.history || !appState.history.length) return;
  if (!confirm("Clear the activity history? This can't be undone.")) return;
  appState.history = [];
  renderHistory();
  save();
});

function activeLocationName() {
  const entry = appState.warehouses[appState.activeId];
  return entry ? entry.name : "";
}

// Re-render the history list whenever the History tab is opened, so
// relative timestamps ("2m ago") are fresh.
tabradioHistory.addEventListener("change", () => {
  if (tabradioHistory.checked) renderHistory();
});

/* ---------- zone stock status ---------- */

function itemMinQty(item) {
  return item.minQty == null ? DEFAULT_MIN_QTY : item.minQty;
}

function isLowStock(item) {
  return item.qty <= itemMinQty(item);
}

function zoneStatus(zone) {
  if (!zone.items.length) return "empty";
  if (zone.items.some(isLowStock)) return "low";
  return "stocked";
}

function snap(value) {
  return snapEnabled ? Math.round(value / SNAP_STEP) * SNAP_STEP : value;
}

/* ---------- undo ---------- */

function writeUndoStacksToStorage() {
  try {
    localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(undoStacksById));
  } catch (e) {
    console.error("Couldn't persist undo history.", e);
  }
}

// Call after any change to undoStack (push or pop) so the active
// location's stack is folded back into undoStacksById before writing.
function persistUndoStacks() {
  if (appState.activeId) undoStacksById[appState.activeId] = undoStack;
  writeUndoStacksToStorage();
}

// Restores whatever undo stacks were saved before the last refresh.
// Drops stacks for locations that no longer exist (deleted elsewhere,
// or replaced by an import since the last visit), so undo can never
// target a location that's genuinely gone.
function restoreUndoStacks() {
  try {
    const raw = localStorage.getItem(UNDO_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    Object.keys(parsed).forEach((id) => {
      if (appState.warehouses[id]) undoStacksById[id] = parsed[id];
    });
  } catch (e) {
    console.error("Couldn't restore undo history.", e);
  }
}

function writeRedoStacksToStorage() {
  try {
    localStorage.setItem(REDO_STORAGE_KEY, JSON.stringify(redoStacksById));
  } catch (e) {
    console.error("Couldn't persist redo history.", e);
  }
}

function persistRedoStacks() {
  if (appState.activeId) redoStacksById[appState.activeId] = redoStack;
  writeRedoStacksToStorage();
}

function restoreRedoStacks() {
  try {
    const raw = localStorage.getItem(REDO_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    Object.keys(parsed).forEach((id) => {
      if (appState.warehouses[id]) redoStacksById[id] = parsed[id];
    });
  } catch (e) {
    console.error("Couldn't restore redo history.", e);
  }
}

// Call any time the active location changes in cloud mode. No-op in
// local-only mode (tenantId is null there) — nothing to do, since
// appState.activeId already rides along with the rest of appState in
// that mode's normal save().
function saveActiveWarehouseId(id) {
  if (!tenantId) return;
  try {
    const raw = localStorage.getItem(ACTIVE_WAREHOUSE_STORAGE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[tenantId] = id;
    localStorage.setItem(ACTIVE_WAREHOUSE_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.error("Couldn't remember active location.", e);
  }
}

// Returns the remembered warehouse id for the current tenant, or null
// if there isn't one (first-ever visit, local-only mode, or storage
// unavailable). Callers are responsible for checking the id still
// exists in the freshly-fetched data before trusting it — it may have
// been deleted since the last visit.
function loadActiveWarehouseId() {
  if (!tenantId) return null;
  try {
    const raw = localStorage.getItem(ACTIVE_WAREHOUSE_STORAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map && typeof map === "object" ? map[tenantId] || null : null;
  } catch (e) {
    console.error("Couldn't read remembered active location.", e);
    return null;
  }
}

function snapshotBeforeChange() {
  undoStack.push({ warehouse: { ...warehouse }, zones: deepClone(zones) });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack = [];
  updateUndoButtonState();
  persistUndoStacks();
  persistRedoStacks();
}

function updateUndoButtonState() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;   // add this line
}

undoBtn.addEventListener("click", undo);

function undo() {
  if (!undoStack.length) return;
  if (blockIfViewOnly()) return;
  redoStack.push({ warehouse: { ...warehouse }, zones: deepClone(zones) });   // add this line
  const snapshot = undoStack.pop();
  warehouse = snapshot.warehouse;
  zones = snapshot.zones;
  if (selectedZoneId && !zones.find((z) => z.id === selectedZoneId)) selectedZoneId = null;
  lengthInput.value = warehouse.length;
  breadthInput.value = warehouse.breadth;
  renderWarehouse();
  renderSidebar();
  updateUndoButtonState();
  persistUndoStacks();
  persistRedoStacks();            // add this line
  logEvent(`Undid last change in <strong>${escapeHtml(activeLocationName())}</strong>`, "undo");
  save();
  showToast("Undone");
}


redoBtn.addEventListener("click", redo);

function redo() {
  if (!redoStack.length) return;
  if (blockIfViewOnly()) return;
  undoStack.push({ warehouse: { ...warehouse }, zones: deepClone(zones) });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  const snapshot = redoStack.pop();
  warehouse = snapshot.warehouse;
  zones = snapshot.zones;
  if (selectedZoneId && !zones.find((z) => z.id === selectedZoneId)) selectedZoneId = null;
  lengthInput.value = warehouse.length;
  breadthInput.value = warehouse.breadth;
  renderWarehouse();
  renderSidebar();
  updateUndoButtonState();
  persistUndoStacks();
  persistRedoStacks();
  logEvent(`Redid last undone change in <strong>${escapeHtml(activeLocationName())}</strong>`, "undo");
  save();
  showToast("Redone");
}

/* ---------- location (warehouse) management ---------- */

function renderWarehouseSelect() {
  warehouseSelect.innerHTML = "";
  Object.values(appState.warehouses).forEach((entry) => {
    const opt = document.createElement("option");
    opt.value = entry.id;
    opt.textContent = entry.name;
    if (entry.id === appState.activeId) opt.selected = true;
    warehouseSelect.appendChild(opt);
  });
  deleteWarehouseBtn.disabled = Object.keys(appState.warehouses).length <= 1;
}

function switchWarehouse(id) {
  if (!appState.warehouses[id] || id === appState.activeId) return;
  syncActiveIntoState();
  if (appState.activeId) undoStacksById[appState.activeId] = undoStack;
  if (appState.activeId) redoStacksById[appState.activeId] = redoStack;   // add this line

  appState.activeId = id;
  saveActiveWarehouseId(id);
  const entry = appState.warehouses[id];
  warehouse = entry.warehouse;
  zones = entry.zones;
  undoStack = undoStacksById[id] || [];
  redoStack = redoStacksById[id] || [];   // add this line
  selectedZoneId = null;

  lengthInput.value = warehouse.length;
  breadthInput.value = warehouse.breadth;
  clearSearch();
  renderWarehouseSelect();
  renderWarehouse();
  renderSidebar();
  renderHistory();
  updateUndoButtonState();
  persistUndoStacks();
  persistRedoStacks();   // add this line
  save();
  refreshTableViewIfOpen();
  closeMobileMenu();
}

warehouseSelect.addEventListener("change", () => switchWarehouse(warehouseSelect.value));

newWarehouseBtn.addEventListener("click", () => {
  if (blockIfViewOnly()) return;
  const name = prompt("Name this location:", `Warehouse ${Object.keys(appState.warehouses).length + 1}`);
  if (!name) return;
  syncActiveIntoState();
  const id = createWarehouseEntry(name.trim() || "New location");
  switchWarehouse(id);
  logEvent(`Created location <strong>${escapeHtml(activeLocationName())}</strong>`, "location");
  showToast(`"${activeLocationName()}" created`, "success");
});

renameWarehouseBtn.addEventListener("click", () => {
  if (blockIfViewOnly()) return;
  const entry = appState.warehouses[appState.activeId];
  if (!entry) return;
  const name = prompt("Rename this location:", entry.name);
  if (!name) return;
  const oldName = entry.name;
  entry.name = name.trim() || entry.name;
  renderWarehouseSelect();
  logEvent(`Renamed location <strong>${escapeHtml(oldName)}</strong> to <strong>${escapeHtml(entry.name)}</strong>`, "location");
  save();
  showToast(`Renamed to "${entry.name}"`, "success");
  refreshTableViewIfOpen();
  closeMobileMenu();
});

deleteWarehouseBtn.addEventListener("click", () => {
  if (blockIfViewOnly()) return;
  const ids = Object.keys(appState.warehouses);
  if (ids.length <= 1) return;
  const entry = appState.warehouses[appState.activeId];
  if (!confirm(`Delete location "${entry.name}" and everything in it? This can't be undone.`)) return;

  const remainingIds = ids.filter((id) => id !== appState.activeId);
  const deletedId = appState.activeId;
  const deletedName = entry.name;
  delete appState.warehouses[appState.activeId];
  delete undoStacksById[appState.activeId];
  delete redoStacksById[appState.activeId];
  writeUndoStacksToStorage();
  writeRedoStacksToStorage();
  appState.activeId = null;
  switchWarehouse(remainingIds[0]);
  logEvent(`Deleted location <strong>${escapeHtml(deletedName)}</strong>`, "location", null);
  cloudDeleteWarehouse(deletedId);
  save();
  showToast(`Deleted "${deletedName}"`, "danger");
});

/* ---------- export / import (backup & restore) ---------- */

function applyImportedState(parsed, successMessage, options = {}) {
  if (!parsed || typeof parsed !== "object" || !parsed.warehouses || !Object.keys(parsed.warehouses).length) {
    throw new Error("Not a recognizable backup.");
  }
  if (!options.skipConfirm && !confirm("Importing will replace everything currently saved in this browser. Continue?")) return false;

  appState = parsed;
  if (!appState.activeId || !appState.warehouses[appState.activeId]) {
    appState.activeId = Object.keys(appState.warehouses)[0];
  }
  if (!Array.isArray(appState.history)) appState.history = [];
  backfillMinQty(appState);
  redoStacksById = {};
  redoStack = [];
  writeUndoStacksToStorage();
  writeRedoStacksToStorage();

  const entry = appState.warehouses[appState.activeId];
  warehouse = entry.warehouse;
  zones = entry.zones;
  selectedZoneId = null;

  lengthInput.value = warehouse.length;
  breadthInput.value = warehouse.breadth;
  clearSearch();
  renderWarehouseSelect();
  renderWarehouse();
  renderSidebar();
  updateUndoButtonState();
  logEvent(successMessage, "backup", null);
  save();
  showToast(successMessage, "success");
  refreshTableViewIfOpen();
  return true;
}

exportJsonBtn.addEventListener("click", () => {
  syncActiveIntoState();
  const data = JSON.stringify(appState, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `warehouse-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  logEvent("Downloaded a JSON backup file", "backup", null);
  showToast("JSON file downloaded", "success");
});

function sheetOrPlaceholder(rows, placeholderMessage) {
  return XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: placeholderMessage }]);
}

exportExcelBtn.addEventListener("click", () => {
  syncActiveIntoState();
  const locationRows = [];
  const zoneRows = [];
  const itemRows = [];

  Object.values(appState.warehouses).forEach((entry) => {
    locationRows.push({
      "Location ID": entry.id,
      "Location Name": entry.name,
      Length: entry.warehouse.length,
      Breadth: entry.warehouse.breadth,
    });
    entry.zones.forEach((zone) => {
      zoneRows.push({
        "Location ID": entry.id,
        "Location Name": entry.name,
        "Zone ID": zone.id,
        "Zone Name": zone.name,
        X: zone.x,
        Y: zone.y,
        Width: zone.width,
        Height: zone.height,
      });
      zone.items.forEach((item) => {
        itemRows.push({
          "Location ID": entry.id,
          "Location Name": entry.name,
          "Zone ID": zone.id,
          "Zone Name": zone.name,
          "Item ID": item.id,
          "Item Name": item.name,
          Quantity: item.qty,
          "Min Qty": itemMinQty(item),
        });
      });
    });
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(locationRows, "No locations yet"), "Locations");
  XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(zoneRows, "No zones yet"), "Zones");
  XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(itemRows, "No items yet"), "Items");
  XLSX.writeFile(wb, `warehouse-backup-${new Date().toISOString().slice(0, 10)}.xlsx`);

  logEvent("Downloaded an Excel backup file", "backup", null);
  showToast("Excel file downloaded", "success");
});

function readField(row, candidates) {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const match = keys.find((k) => k.trim().toLowerCase() === candidate);
    if (match !== undefined) return row[match];
  }
  return undefined;
}

function buildStateFromWorkbook(wb) {
  const locationRows = XLSX.utils.sheet_to_json(wb.Sheets["Locations"]);
  const zoneRows = XLSX.utils.sheet_to_json(wb.Sheets["Zones"]);
  const itemRows = XLSX.utils.sheet_to_json(wb.Sheets["Items"]);

  const warehouses = {};
  const locationIdMap = {};

  locationRows.forEach((row) => {
    const fileId = readField(row, ["location id"]);
    const newLocId = newId();
    if (fileId !== undefined) locationIdMap[String(fileId)] = newLocId;
    warehouses[newLocId] = {
      id: newLocId,
      name: String(readField(row, ["location name"]) || "Imported Location"),
      warehouse: {
        length: Math.max(100, Number(readField(row, ["length"])) || 1000),
        breadth: Math.max(100, Number(readField(row, ["breadth"])) || 600),
      },
      zones: [],
    };
  });

  const zoneRefMap = {};
  zoneRows.forEach((row) => {
    const fileLocId = readField(row, ["location id"]);
    const locId = locationIdMap[String(fileLocId)];
    if (!locId || !warehouses[locId]) return;
    const zone = {
      id: newId(),
      name: String(readField(row, ["zone name"]) || "Zone"),
      x: Number(readField(row, ["x"])) || 0,
      y: Number(readField(row, ["y"])) || 0,
      width: Math.max(20, Number(readField(row, ["width"])) || 20),
      height: Math.max(20, Number(readField(row, ["height"])) || 20),
      items: [],
    };
    warehouses[locId].zones.push(zone);
    const fileZoneId = readField(row, ["zone id"]);
    if (fileZoneId !== undefined) zoneRefMap[String(fileZoneId)] = zone;
  });

  itemRows.forEach((row) => {
    const fileZoneId = readField(row, ["zone id"]);
    const zone = zoneRefMap[String(fileZoneId)];
    if (!zone) return;
    const minRaw = readField(row, ["min qty", "minimum qty", "min quantity", "min"]);
    zone.items.push({
      id: newId(),
      name: String(readField(row, ["item name"]) || "Item"),
      qty: Math.max(0, parseInt(readField(row, ["quantity", "qty"]), 10) || 0),
      minQty: minRaw === undefined ? DEFAULT_MIN_QTY : Math.max(0, parseInt(minRaw, 10) || 0),
    });
  });

  return { activeId: Object.keys(warehouses)[0], warehouses, history: [] };
}

function bulkAddItemsFromWorkbook(wb) {
  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === "items") || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
  if (!rows.length) return { added: 0, skipped: 0 };

  snapshotBeforeChange();
  let added = 0;
  let skipped = 0;

  rows.forEach((row) => {
    const zoneName = readField(row, ["zone", "zone name"]);
    const itemName = readField(row, ["item", "item name"]);
    const qtyRaw = readField(row, ["quantity", "qty"]);
    if (!zoneName || !itemName) { skipped++; return; }
    const zone = zones.find((z) => z.name.trim().toLowerCase() === String(zoneName).trim().toLowerCase());
    if (!zone) { skipped++; return; }
    zone.items.push({ id: newId(), name: String(itemName).trim(), qty: Math.max(0, parseInt(qtyRaw, 10) || 0) });
    added++;
  });

  if (added > 0) {
    renderSidebar();
    renderWarehouse();
    logEvent(`Bulk-added ${added} item${added === 1 ? "" : "s"} from a spreadsheet to <strong>${escapeHtml(activeLocationName())}</strong>`, "item");
    save();
  }
  return { added, skipped };
}

function importJsonFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyImportedState(JSON.parse(reader.result), "Backup restored");
    } catch (e) {
      console.error("Import failed.", e);
      alert("That file doesn't look like a valid Warehouse Designer backup.");
    } finally {
      importFileInput.value = "";
    }
  };
  reader.readAsText(file);
}

function importExcelFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const wb = XLSX.read(new Uint8Array(reader.result), { type: "array" });
      const hasFullStructure = ["Locations", "Zones", "Items"].every((name) => wb.SheetNames.includes(name));
      if (hasFullStructure) {
        applyImportedState(buildStateFromWorkbook(wb), "Excel backup restored");
      } else {
        const { added, skipped } = bulkAddItemsFromWorkbook(wb);
        if (added === 0) {
          alert(
            "Couldn't match any rows to zones in the current location.\n\n" +
            "For a full restore, use a file exported from this app (Export Excel).\n" +
            "For a quick add, use a sheet with Zone / Item / Quantity columns, matching zone names already on the floor."
          );
        } else {
          showToast(`Added ${added} item${added === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}`, "success");
        }
      }
    } catch (e) {
      console.error("Excel import failed.", e);
      alert("Couldn't read that Excel file. Make sure it's a .xlsx file.");
    } finally {
      importFileInput.value = "";
    }
  };
  reader.readAsArrayBuffer(file);
}

importBtn.addEventListener("click", () => importFileInput.click());

importFileInput.addEventListener("change", () => {
  const file = importFileInput.files[0];
  if (!file) return;
  if (blockIfViewOnly()) { importFileInput.value = ""; return; }
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) importExcelFile(file);
  else importJsonFile(file);
});

/* ---------- layout math ---------- */

function computeScale() {
  const maxW = Math.max(200, canvasWrap.clientWidth - 8);
  const maxH = 560;
  const scaleX = maxW / warehouse.length;
  const scaleY = maxH / warehouse.breadth;
  return Math.max(0.05, Math.min(scaleX, scaleY, 2));
}

function applyWarehouseSize() {
  scale = computeScale();
  warehouseEl.style.width = warehouse.length * scale + "px";
  warehouseEl.style.height = warehouse.breadth * scale + "px";
  const minor = SNAP_STEP * scale;
  const major = minor * 5;
  warehouseEl.style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px, ${minor}px ${minor}px`;
  if (scaleBadge) {
    const utilization = computeUtilization(warehouse, zones);
    scaleBadge.textContent = `${warehouse.length} × ${warehouse.breadth}  ·  ${scale.toFixed(2)}×  ·  ${utilization}% used`;
  }
}

function clampZoneToWarehouse(zone) {
  zone.width = Math.max(20, Math.min(zone.width, warehouse.length));
  zone.height = Math.max(20, Math.min(zone.height, warehouse.breadth));
  zone.x = Math.max(0, Math.min(zone.x, warehouse.length - zone.width));
  zone.y = Math.max(0, Math.min(zone.y, warehouse.breadth - zone.height));
}

/* ---------- space & layout planning helpers ----------
   Pure functions, no DOM/state side effects, so they're shared safely
   between the floor plan, the Overview sheet, and the Locations
   sheet without risk of drifting out of sync with each other. */

function zonesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Returns a Set of zone ids that overlap at least one other zone in
// the same list. O(n²), but zone counts per location are small.
function getOverlappingZoneIds(zoneList) {
  const overlapping = new Set();
  for (let i = 0; i < zoneList.length; i++) {
    for (let j = i + 1; j < zoneList.length; j++) {
      if (zonesOverlap(zoneList[i], zoneList[j])) {
        overlapping.add(zoneList[i].id);
        overlapping.add(zoneList[j].id);
      }
    }
  }
  return overlapping;
}

// % of floor area covered by zones. Can exceed 100 if zones overlap —
// that's intentional, it's a visible symptom of the same problem the
// overlap warning flags directly, not a bug to hide.
function computeUtilization(dims, zoneList) {
  const floorArea = dims.length * dims.breadth;
  if (floorArea <= 0) return 0;
  const usedArea = zoneList.reduce((sum, z) => sum + z.width * z.height, 0);
  return Math.round((usedArea / floorArea) * 100);
}

/* ---- layout templates: generate a fresh, non-overlapping zone set ---- */

function generateGridTemplate(length, breadth) {
  const gap = SNAP_STEP;
  const targetCell = 180;
  const cols = Math.max(1, Math.floor((length + gap) / (targetCell + gap)));
  const rows = Math.max(1, Math.floor((breadth + gap) / (targetCell + gap)));
  const cellW = Math.floor((length - gap * (cols - 1)) / cols);
  const cellH = Math.floor((breadth - gap * (rows - 1)) / rows);
  const generated = [];
  let n = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      generated.push({
        id: newId(),
        name: `Zone ${n++}`,
        x: c * (cellW + gap),
        y: r * (cellH + gap),
        width: cellW,
        height: cellH,
        items: [],
      });
    }
  }
  return generated;
}

function generateAisleTemplate(length, breadth) {
  const gap = SNAP_STEP;
  const aisleHeight = 80;
  const rowHeight = Math.floor((breadth - aisleHeight - gap * 2) / 2);
  if (rowHeight < 40) return generateGridTemplate(length, breadth); // too shallow for two rows + a walkway — fall back

  const bayWidth = 140;
  const cols = Math.max(1, Math.floor((length + gap) / (bayWidth + gap)));
  const cellW = Math.floor((length - gap * (cols - 1)) / cols);
  const generated = [];

  for (let c = 0; c < cols; c++) {
    generated.push({ id: newId(), name: `Aisle A-${c + 1}`, x: c * (cellW + gap), y: 0, width: cellW, height: rowHeight, items: [] });
  }
  for (let c = 0; c < cols; c++) {
    generated.push({ id: newId(), name: `Aisle B-${c + 1}`, x: c * (cellW + gap), y: rowHeight + aisleHeight, width: cellW, height: rowHeight, items: [] });
  }
  return generated;
}

// Shelf-packing heuristic: keeps each zone's own width/height (its
// storage requirements) but repositions all of them, tallest first,
// left-to-right, wrapping rows — eliminates overlaps and tends to
// reduce wasted gaps versus wherever they'd been dragged to by hand.
function autoArrangeZones(zoneList, length, breadth) {
  const gap = SNAP_STEP;
  const sorted = [...zoneList].sort((a, b) => b.height - a.height);
  let x = 0, y = 0, rowHeight = 0;
  const placed = sorted.map((zone) => {
    const w = Math.min(zone.width, length);
    const h = Math.min(zone.height, breadth);
    if (x + w > length) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    const result = { ...zone, x, y, width: w, height: h };
    x += w + gap;
    rowHeight = Math.max(rowHeight, h);
    return result;
  });
  placed.forEach((z) => clampZoneToWarehouse(z));
  return placed;
}

function warehousePoint(e) {
  const rect = warehouseEl.getBoundingClientRect();
  const x = (e.clientX - rect.left) / scale;
  const y = (e.clientY - rect.top) / scale;
  return { x: Math.max(0, Math.min(x, warehouse.length)), y: Math.max(0, Math.min(y, warehouse.breadth)) };
}

/* ---------- rendering ---------- */

function renderWarehouse() {
  applyWarehouseSize();
  warehouseEl.classList.toggle("layout-edit-mode", layoutEditMode);
  warehouseEl.innerHTML = "";

  const overlappingIds = getOverlappingZoneIds(zones);
  updateOverlapBadge(overlappingIds.size);

  zones.forEach((zone) => {
    const status = zoneStatus(zone);
    const isOverlapping = overlappingIds.has(zone.id);
    const el = document.createElement("div");
    el.className =
      "zone" + ` zone--${status}` + (zone.id === selectedZoneId ? " zone--selected" : "") + (isOverlapping ? " zone--overlap" : "");
    el.style.left = zone.x * scale + "px";
    el.style.top = zone.y * scale + "px";
    el.style.width = zone.width * scale + "px";
    el.style.height = zone.height * scale + "px";
    el.dataset.id = zone.id;
    el.dataset.dims = `${Math.round(zone.width)} × ${Math.round(zone.height)}${isOverlapping ? " · overlapping" : ""}`;

    const label = document.createElement("span");
    label.className = "zone-label";
    label.textContent = zone.name + (zone.items.length ? ` (${zone.items.length})` : "");
    el.appendChild(label);

    let handle = null;
    if (layoutEditMode) {
      handle = document.createElement("div");
      handle.className = "zone-resize-handle";
      el.appendChild(handle);
    }

    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (addingZone) return;
      if (!layoutEditMode) {
        selectZone(zone.id);
        return;
      }
      if (blockIfViewOnly()) return;
      if (e.target === handle) startResize(e, zone.id);
      else startMove(e, zone.id);
    });

    warehouseEl.appendChild(el);
  });
}

function updateOverlapBadge(count) {
  if (!overlapBadge) return;
  overlapBadge.textContent = `⚠ ${count} zone${count === 1 ? "" : "s"} overlapping`;
  overlapBadge.hidden = count === 0;
}

// Call right after a zone's position/size finishes changing (drag end,
// resize end, coordinate edit, new zone drawn). Only warns when the
// SPECIFIC zone just touched is newly overlapping — not on every
// render — so this doesn't spam a toast on every pixel of a drag.
function warnIfZoneNowOverlapping(zoneId) {
  const zone = zones.find((z) => z.id === zoneId);
  if (!zone) return;
  const others = zones.filter((z) => z.id !== zoneId);
  if (others.some((o) => zonesOverlap(zone, o))) {
    showToast(`"${zone.name}" overlaps another zone`, "danger");
  }
}

function currentZone() {
  return zones.find((z) => z.id === selectedZoneId);
}

function selectZone(id) {
  selectedZoneId = id;
  renderWarehouse();
  renderSidebar();
}

function renderSidebar() {
  const zone = currentZone();
  if (!zone) {
    emptyState.style.display = "";
    zoneEditor.style.display = "none";
    return;
  }
  emptyState.style.display = "none";
  zoneEditor.style.display = "";

  zoneNameInput.value = zone.name;
  syncZoneNumberInputs(zone);

  const status = zoneStatus(zone);
  zoneStatusDot.className = "status-dot" + (status !== "empty" ? ` status-dot--${status}` : "");
  itemCountBadge.textContent = zone.items.length ? `${zone.items.length}` : "";

  itemListEl.innerHTML = "";
  if (!zone.items.length) {
    const li = document.createElement("li");
    li.className = "item-empty-msg";
    li.textContent = "No items yet.";
    itemListEl.appendChild(li);
  }
  zone.items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "item" + (isLowStock(item) ? " item--low" : "");
    li.innerHTML = `
      <div class="item-row-main">
        <span class="item-name">${escapeHtml(item.name)}</span>
        <div class="item-controls">
          <button type="button" data-action="dec" data-item="${item.id}" aria-label="Decrease quantity">−</button>
          <input type="number" class="qty-input" data-item="${item.id}" value="${item.qty}" min="0" inputmode="numeric" aria-label="Quantity for ${escapeHtml(item.name)}" />
          <button type="button" data-action="inc" data-item="${item.id}" aria-label="Increase quantity">+</button>
          <button type="button" data-action="del" data-item="${item.id}" aria-label="Delete ${escapeHtml(item.name)}">✕</button>
        </div>
      </div>
      <div class="item-row-meta">
        <label class="item-min-field">
          Min
          <input type="number" class="min-input" data-item="${item.id}" value="${itemMinQty(item)}" min="0" aria-label="Minimum quantity for ${escapeHtml(item.name)} before it's flagged low" />
        </label>
        ${isLowStock(item) ? '<span class="item-low-flag">⚠ Low</span>' : ""}
      </div>`;
    itemListEl.appendChild(li);
  });
}

function syncZoneNumberInputs(zone) {
  zoneXInput.value = Math.round(zone.x);
  zoneYInput.value = Math.round(zone.y);
  zoneWidthInput.value = Math.round(zone.width);
  zoneHeightInput.value = Math.round(zone.height);
}

/* ---------- warehouse dimensions ---------- */

lengthInput.addEventListener("change", () => {
  if (blockIfViewOnly()) { lengthInput.value = warehouse.length; return; }
  snapshotBeforeChange();
  warehouse.length = Math.max(100, parseInt(lengthInput.value, 10) || warehouse.length);
  lengthInput.value = warehouse.length;
  zones.forEach(clampZoneToWarehouse);
  renderWarehouse();
  if (selectedZoneId) syncZoneNumberInputs(currentZone());
  logEvent(`Resized <strong>${escapeHtml(activeLocationName())}</strong> to ${warehouse.length} × ${warehouse.breadth}`, "location");
  save();
});

breadthInput.addEventListener("change", () => {
  if (blockIfViewOnly()) { breadthInput.value = warehouse.breadth; return; }
  snapshotBeforeChange();
  warehouse.breadth = Math.max(100, parseInt(breadthInput.value, 10) || warehouse.breadth);
  breadthInput.value = warehouse.breadth;
  zones.forEach(clampZoneToWarehouse);
  renderWarehouse();
  if (selectedZoneId) syncZoneNumberInputs(currentZone());
  logEvent(`Resized <strong>${escapeHtml(activeLocationName())}</strong> to ${warehouse.length} × ${warehouse.breadth}`, "location");
  save();
});

window.addEventListener("resize", renderWarehouse);

/* ---------- layout lock + snap toggles ---------- */

function updateCanvasHint() {
  if (addingZone) canvasHint.textContent = "Drag on the floor to draw the new zone's outline.";
  else if (layoutEditMode) canvasHint.textContent = "Edit Layout is on — drag a zone to move it, drag its corner to resize.";
  else canvasHint.textContent = "Click a zone to view what's stored inside. Turn on Edit Layout to move or resize zones.";
}

editLayoutToggle.addEventListener("change", () => {
  layoutEditMode = editLayoutToggle.checked;
  if (layoutEditMode && addingZone) cancelDrawing();
  updateCanvasHint();
  renderWarehouse();
});

snapToggle.addEventListener("change", () => {
  snapEnabled = snapToggle.checked;
  showToast(snapEnabled ? "Snap to grid on" : "Snap to grid off");
});

/* ---------- add zone (drag to draw) ---------- */

let addingZone = false;
let drawStart = null;
let previewEl = null;
let readoutEl = null;

function cancelDrawing() {
  if (previewEl) { previewEl.remove(); previewEl = null; }
  if (readoutEl) { readoutEl.remove(); readoutEl = null; }
  drawStart = null;
  addingZone = false;
  addZoneBtn.classList.remove("active");
  addZoneBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">+</span> Add Zone';
  warehouseEl.classList.remove("drawing-mode");
  updateCanvasHint();
}

function setLayoutButtonsDisabled(disabled) {
  [gridTemplateBtn, aisleTemplateBtn, autoArrangeBtn].forEach((btn) => {
    if (btn) btn.disabled = disabled;
  });
}

function applyGeneratedZones(generated, actionLabel) {
  if (blockIfViewOnly()) return;
  if (zones.length > 0) {
    const ok = confirm(`Apply this layout? It replaces all ${zones.length} existing zone${zones.length === 1 ? "" : "s"} in "${activeLocationName()}" — this can be undone with Ctrl+Z.`);
    if (!ok) return;
  }
  setLayoutButtonsDisabled(true);
  snapshotBeforeChange();
  const oldZones = zones;
  zones = generated;
  selectedZoneId = null;
  layoutEditMode = true;
  editLayoutToggle.checked = true;
  renderWarehouse();
  renderSidebar();
  updateCanvasHint();
  logEvent(`Applied <strong>${escapeHtml(actionLabel)}</strong> layout to <strong>${escapeHtml(activeLocationName())}</strong> (${generated.length} zones)`, "zone");
  showToast(`${actionLabel} layout applied`, "success");
  save();
  // Chained through cloudPushChain (the same queue save() uses) so the
  // old-zone cleanup can never race ahead of or behind the new zones'
  // own push — it always runs in the correct order relative to it.
  cloudPushChain = cloudPushChain
    .then(() => Promise.all(oldZones.map((z) => cloudDeleteZone(z.id))))
    .catch((e) => console.error("Layout template cleanup failed.", e))
    .finally(() => setLayoutButtonsDisabled(false));
  refreshTableViewIfOpen();
  if (layoutToolsMenu) layoutToolsMenu.open = false;
}

if (gridTemplateBtn) {
  gridTemplateBtn.addEventListener("click", () => {
    applyGeneratedZones(generateGridTemplate(warehouse.length, warehouse.breadth), "Grid");
  });
}

if (aisleTemplateBtn) {
  aisleTemplateBtn.addEventListener("click", () => {
    applyGeneratedZones(generateAisleTemplate(warehouse.length, warehouse.breadth), "Aisle");
  });
}

if (autoArrangeBtn) {
  autoArrangeBtn.addEventListener("click", () => {
    if (blockIfViewOnly()) return;
    if (!zones.length) { showToast("No zones to arrange yet", "danger"); return; }
    if (!confirm("Automatically rearrange all zones to remove overlaps and reduce wasted space? Zone contents stay the same — only position changes. This can be undone with Ctrl+Z.")) return;
    snapshotBeforeChange();
    zones = autoArrangeZones(zones, warehouse.length, warehouse.breadth);
    layoutEditMode = true;
    editLayoutToggle.checked = true;
    renderWarehouse();
    renderSidebar();
    updateCanvasHint();
    logEvent(`Auto-arranged zones in <strong>${escapeHtml(activeLocationName())}</strong>`, "zone");
    showToast("Zones rearranged", "success");
    save();
    refreshTableViewIfOpen();
    if (layoutToolsMenu) layoutToolsMenu.open = false;
  });
}

addZoneBtn.addEventListener("click", () => {
  if (addingZone) { cancelDrawing(); return; }
  if (blockIfViewOnly()) return;
  addingZone = true;
  addZoneBtn.classList.add("active");
  addZoneBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">✕</span> Cancel Drawing';
  warehouseEl.classList.add("drawing-mode");
  if (layoutEditMode) {
    layoutEditMode = false;
    editLayoutToggle.checked = false;
    renderWarehouse();
  }
  updateCanvasHint();
});

warehouseEl.addEventListener("pointerdown", (e) => {
  if (!addingZone) {
    if (e.target === warehouseEl) {
      selectedZoneId = null;
      renderWarehouse();
      renderSidebar();
    }
    return;
  }
  if (e.target !== warehouseEl) return;
  drawStart = warehousePoint(e);
  previewEl = document.createElement("div");
  previewEl.className = "zone-draw-preview";
  warehouseEl.appendChild(previewEl);
  readoutEl = document.createElement("div");
  readoutEl.className = "draw-readout";
  warehouseEl.appendChild(readoutEl);
  warehouseEl.setPointerCapture(e.pointerId);
});

warehouseEl.addEventListener("pointermove", (e) => {
  if (!addingZone || !drawStart || !previewEl) return;
  const p = warehousePoint(e);
  const x = snap(Math.min(drawStart.x, p.x));
  const y = snap(Math.min(drawStart.y, p.y));
  const x2 = snap(Math.max(drawStart.x, p.x));
  const y2 = snap(Math.max(drawStart.y, p.y));
  const w = Math.max(0, x2 - x);
  const h = Math.max(0, y2 - y);
  previewEl.style.left = x * scale + "px";
  previewEl.style.top = y * scale + "px";
  previewEl.style.width = w * scale + "px";
  previewEl.style.height = h * scale + "px";
  if (readoutEl) {
    readoutEl.style.left = (x + w) * scale + "px";
    readoutEl.style.top = (y + h) * scale + "px";
    readoutEl.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  }
});

warehouseEl.addEventListener("pointerup", (e) => {
  if (!addingZone || !drawStart) return;
  const p = warehousePoint(e);
  const x = snap(Math.min(drawStart.x, p.x));
  const y = snap(Math.min(drawStart.y, p.y));
  const x2 = snap(Math.max(drawStart.x, p.x));
  const y2 = snap(Math.max(drawStart.y, p.y));
  const w = Math.max(0, x2 - x);
  const h = Math.max(0, y2 - y);
  cancelDrawing();
  if (w < 10 || h < 10) return;

  const name = prompt("Name this zone:", "New zone");
  if (!name) return;

  snapshotBeforeChange();
  const zone = { id: newId(), name: name.trim() || "New zone", x, y, width: w, height: h, items: [] };
  zones.push(zone);
  selectedZoneId = zone.id;
  renderWarehouse();
  renderSidebar();
  logEvent(`Created zone <strong>${escapeHtml(zone.name)}</strong> (${Math.round(w)} × ${Math.round(h)}) in <strong>${escapeHtml(activeLocationName())}</strong>`, "zone");
  showToast(`Zone "${zone.name}" created`, "success");
  warnIfZoneNowOverlapping(zone.id);
  save();
  refreshTableViewIfOpen();
});

warehouseEl.addEventListener("pointercancel", cancelDrawing);

/* ---------- move / resize existing zones ---------- */

let dragState = null;

function startMove(e, id) {
  selectZone(id);
  const zone = currentZone();
  snapshotBeforeChange();
  dragState = { type: "move", id, start: warehousePoint(e), startZone: { ...zone } };
  warehouseEl.setPointerCapture(e.pointerId);
}

function startResize(e, id) {
  selectZone(id);
  const zone = currentZone();
  snapshotBeforeChange();
  dragState = { type: "resize", id, start: warehousePoint(e), startZone: { ...zone } };
  warehouseEl.setPointerCapture(e.pointerId);
}

warehouseEl.addEventListener("pointermove", (e) => {
  if (!dragState) return;
  const zone = zones.find((z) => z.id === dragState.id);
  if (!zone) return;
  const p = warehousePoint(e);
  const dx = p.x - dragState.start.x;
  const dy = p.y - dragState.start.y;

  if (dragState.type === "move") {
    zone.x = Math.round(snap(dragState.startZone.x + dx));
    zone.y = Math.round(snap(dragState.startZone.y + dy));
  } else if (dragState.type === "resize") {
    zone.width = Math.max(20, Math.round(snap(dragState.startZone.width + dx)));
    zone.height = Math.max(20, Math.round(snap(dragState.startZone.height + dy)));
  }
  clampZoneToWarehouse(zone);
  renderWarehouse();
  syncZoneNumberInputs(zone);
});

warehouseEl.addEventListener("pointerup", () => {
  if (!dragState) return;
  const zone = zones.find((z) => z.id === dragState.id);
  if (zone) {
    const moved = zone.x !== dragState.startZone.x || zone.y !== dragState.startZone.y;
    const resized = zone.width !== dragState.startZone.width || zone.height !== dragState.startZone.height;
    if (dragState.type === "move" && moved) {
      logEvent(`Moved zone <strong>${escapeHtml(zone.name)}</strong> in <strong>${escapeHtml(activeLocationName())}</strong>`, "zone");
    } else if (dragState.type === "resize" && resized) {
      logEvent(`Resized zone <strong>${escapeHtml(zone.name)}</strong> to ${Math.round(zone.width)} × ${Math.round(zone.height)}`, "zone");
    }
    if (moved || resized) warnIfZoneNowOverlapping(zone.id);
  }
  dragState = null;
  save();
  refreshTableViewIfOpen();
});

warehouseEl.addEventListener("pointercancel", () => { dragState = null; });

/* ---------- sidebar: precise editing ---------- */

zoneNameInput.addEventListener("change", () => {
  const zone = currentZone();
  if (!zone) return;
  if (blockIfViewOnly()) { zoneNameInput.value = zone.name; return; }
  const oldName = zone.name;
  snapshotBeforeChange();
  zone.name = zoneNameInput.value.trim() || zone.name;
  zoneNameInput.value = zone.name;
  renderWarehouse();
  if (zone.name !== oldName) {
    logEvent(`Renamed zone <strong>${escapeHtml(oldName)}</strong> to <strong>${escapeHtml(zone.name)}</strong>`, "zone");
  }
  save();
  refreshTableViewIfOpen();
});

[zoneXInput, zoneYInput, zoneWidthInput, zoneHeightInput].forEach((input) => {
  input.addEventListener("change", () => {
    const zone = currentZone();
    if (!zone) return;
    if (blockIfViewOnly()) { syncZoneNumberInputs(zone); return; }
    snapshotBeforeChange();
    zone.x = parseInt(zoneXInput.value, 10) || 0;
    zone.y = parseInt(zoneYInput.value, 10) || 0;
    zone.width = Math.max(20, parseInt(zoneWidthInput.value, 10) || zone.width);
    zone.height = Math.max(20, parseInt(zoneHeightInput.value, 10) || zone.height);
    clampZoneToWarehouse(zone);
    syncZoneNumberInputs(zone);
    renderWarehouse();
    logEvent(`Updated zone <strong>${escapeHtml(zone.name)}</strong> position/size`, "zone");
    warnIfZoneNowOverlapping(zone.id);
    save();
    refreshTableViewIfOpen();
  });
});

function deleteSelectedZone() {
  const zone = currentZone();
  if (!zone) return;
  if (blockIfViewOnly()) return;
  if (!confirm(`Delete "${zone.name}" and everything stored in it?`)) return;
  snapshotBeforeChange();
  zones = zones.filter((z) => z.id !== zone.id);
  selectedZoneId = null;
  renderWarehouse();
  renderSidebar();
  logEvent(`Deleted zone <strong>${escapeHtml(zone.name)}</strong> from <strong>${escapeHtml(activeLocationName())}</strong>`, "zone");
  cloudDeleteZone(zone.id);
  save();
  showToast(`Zone "${zone.name}" deleted`, "danger");
  refreshTableViewIfOpen();
}

deleteZoneBtn.addEventListener("click", deleteSelectedZone);

/* ---------- items within a zone (sidebar) ---------- */

itemListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const zone = currentZone();
  if (!zone) return;
  const item = zone.items.find((i) => i.id === btn.dataset.item);
  if (!item) return;
  if (blockIfViewOnly()) return;

  snapshotBeforeChange();
  const oldQty = item.qty;
  if (btn.dataset.action === "inc") {
    item.qty += 1;
    logEvent(`Increased <strong>${escapeHtml(item.name)}</strong> to ${item.qty} in <strong>${escapeHtml(zone.name)}</strong>`, "item");
    trackQtyChange(item, oldQty);
  }
  if (btn.dataset.action === "dec") {
    item.qty = Math.max(0, item.qty - 1);
    logEvent(`Decreased <strong>${escapeHtml(item.name)}</strong> to ${item.qty} in <strong>${escapeHtml(zone.name)}</strong>`, "item");
    trackQtyChange(item, oldQty);
  }
  if (btn.dataset.action === "del") {
    zone.items = zone.items.filter((i) => i.id !== item.id);
    logEvent(`Removed <strong>${escapeHtml(item.name)}</strong> from <strong>${escapeHtml(zone.name)}</strong>`, "item");
    cloudDeleteItem(item.id);
    showToast(`Removed "${item.name}"`, "danger");
  }
  renderSidebar();
  renderWarehouse();
  save();
  refreshTableViewIfOpen();
});

itemListEl.addEventListener("change", (e) => {
  const qtyInput = e.target.closest(".qty-input");
  const minInput = e.target.closest(".min-input");
  const zone = currentZone();
  if (!zone) return;
  if (blockIfViewOnly()) { renderSidebar(); return; }

  if (qtyInput) {
    const item = zone.items.find((i) => i.id === qtyInput.dataset.item);
    if (!item) return;
    const newQty = Math.max(0, parseInt(qtyInput.value, 10) || 0);
    if (newQty === item.qty) { qtyInput.value = item.qty; return; }
    snapshotBeforeChange();
    const oldQty = item.qty;
    item.qty = newQty;
    qtyInput.value = item.qty;
    logEvent(`Set <strong>${escapeHtml(item.name)}</strong> to ${item.qty} in <strong>${escapeHtml(zone.name)}</strong>`, "item");
    trackQtyChange(item, oldQty);
    renderSidebar();
    renderWarehouse();
    save();
    refreshTableViewIfOpen();
    return;
  }

  if (minInput) {
    const item = zone.items.find((i) => i.id === minInput.dataset.item);
    if (!item) return;
    const newMin = Math.max(0, parseInt(minInput.value, 10) || 0);
    if (newMin === itemMinQty(item)) { minInput.value = newMin; return; }
    item.minQty = newMin;
    logEvent(`Set minimum for <strong>${escapeHtml(item.name)}</strong> to ${newMin}`, "item");
    renderSidebar();
    renderWarehouse();
    save();
    refreshTableViewIfOpen();
  }
});

addItemForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const zone = currentZone();
  if (!zone) return;
  if (blockIfViewOnly()) return;
  const name = newItemNameInput.value.trim();
  if (!name) return;
  const qty = Math.max(0, parseInt(newItemQtyInput.value, 10) || 0);
  const minQty = Math.max(0, parseInt(newItemMinInput.value, 10) || 0);

  const item = { id: newId(), name, qty, minQty };
  zone.items.push(item);
  newItemNameInput.value = "";
  newItemQtyInput.value = 1;
  newItemMinInput.value = DEFAULT_MIN_QTY;
  renderSidebar();
  renderWarehouse();
  logEvent(`Added <strong>${escapeHtml(item.name)}</strong> (qty ${item.qty}) to <strong>${escapeHtml(zone.name)}</strong>`, "item");
  showToast(`Added "${item.name}" (qty ${item.qty})`, "success");
  save();
  refreshTableViewIfOpen();
});

/* ---------- search (current location) ---------- */

function clearSearch() {
  searchInput.value = "";
  searchResultsEl.style.display = "none";
  searchResultsEl.innerHTML = "";
}

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  searchResultsEl.innerHTML = "";
  if (!q) { searchResultsEl.style.display = "none"; return; }

  const results = [];
  zones.forEach((zone) => {
    zone.items.forEach((item) => {
      if (item.name.toLowerCase().includes(q)) results.push({ zoneId: zone.id, zoneName: zone.name, item });
    });
  });

  searchResultsEl.style.display = "";
  if (!results.length) {
    searchResultsEl.innerHTML = '<div class="search-empty">No matching items in this location.</div>';
    return;
  }
  results.forEach((r) => {
    const row = document.createElement("div");
    row.className = "search-result";
    row.innerHTML = `
      <span class="search-result-name">${escapeHtml(r.item.name)} <span class="search-result-qty">· qty ${r.item.qty}</span></span>
      <span class="search-result-zone">${escapeHtml(r.zoneName)}</span>`;
    row.addEventListener("click", () => { selectZone(r.zoneId); clearSearch(); });
    searchResultsEl.appendChild(row);
  });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) searchResultsEl.style.display = "none";
});

/* ---------- mobile drawer (menu button that reveals header/location controls) ---------- */

function closeMobileMenu() {
  mobileMenuToggle.checked = false;
  syncScrollLock();
}

drawerCloseBtn.addEventListener("click", closeMobileMenu);

// Opening Table View from inside the drawer, or switching/creating a
// location, should close the drawer too — otherwise it's left hovering
// over whatever just changed.
tableViewToggle.addEventListener("change", () => {
  if (tableViewToggle.checked) closeMobileMenu();
});

// Lock background scroll while a full-screen overlay (Table View or the
// mobile drawer) is open. Without this, touch-scrolling inside the
// modal on mobile can also drag the page underneath, which is exactly
// the kind of thing that makes an overlay feel broken/hard to use.
function syncScrollLock() {
  document.body.classList.toggle("scroll-locked", tableViewToggle.checked || mobileMenuToggle.checked);
}
tableViewToggle.addEventListener("change", syncScrollLock);
mobileMenuToggle.addEventListener("change", syncScrollLock);

/* ---------- keyboard shortcuts ---------- */

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : "";
  const isEditable = tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable);

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !isEditable) {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z")) && !isEditable) {
    e.preventDefault();
    redo();
    return;
  }
  if (e.key === "Escape") {
    if (addingZone) cancelDrawing();
    searchResultsEl.style.display = "none";
    if (tableViewToggle.checked) { tableViewToggle.checked = false; syncScrollLock(); }
    if (mobileMenuToggle.checked) closeMobileMenu();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !isEditable && selectedZoneId) {
    e.preventDefault();
    deleteSelectedZone();
  }
});

/* ==========================================================
   TABLE VIEW — multi-tab spreadsheet (Items / Zones / Locations)
   ==========================================================
   All three sheets read from and write to the exact same appState the
   floor plan uses. Edits here go through the same save()/history path
   as everything else, so nothing gets out of sync.
*/

const tvTabs = document.querySelectorAll(".tv-tab");
const tvPanels = document.querySelectorAll(".tv-panel");
const tvLocationFilterLabel = document.getElementById("tvLocationFilterLabel");
const tableScopeSelect = document.getElementById("tableScopeSelect");
const tableSearchInput = document.getElementById("tableSearchInput");

const overviewStatsEl = document.getElementById("overviewStats");
const overviewTableBody = document.getElementById("overviewTableBody");
const overviewTableEmpty = document.getElementById("overviewTableEmpty");

const itemsTableBody = document.getElementById("itemsTableBody");
const itemsTableEmpty = document.getElementById("itemsTableEmpty");
const tableAddItemForm = document.getElementById("tableAddItemForm");
const tableAddItemWarehouse = document.getElementById("tableAddItemWarehouse");
const tableAddItemZone = document.getElementById("tableAddItemZone");
const tableAddItemName = document.getElementById("tableAddItemName");
const tableAddItemQty = document.getElementById("tableAddItemQty");
const tableAddItemMin = document.getElementById("tableAddItemMin");

const zonesTableBody = document.getElementById("zonesTableBody");
const zonesTableEmpty = document.getElementById("zonesTableEmpty");
const tableAddZoneForm = document.getElementById("tableAddZoneForm");
const tableAddZoneWarehouse = document.getElementById("tableAddZoneWarehouse");
const tableAddZoneName = document.getElementById("tableAddZoneName");
const tableAddZoneWidth = document.getElementById("tableAddZoneWidth");
const tableAddZoneHeight = document.getElementById("tableAddZoneHeight");

const locationsTableBody = document.getElementById("locationsTableBody");
const locationsTableEmpty = document.getElementById("locationsTableEmpty");
const tableAddLocationForm = document.getElementById("tableAddLocationForm");
const tableAddLocationName = document.getElementById("tableAddLocationName");
const tableAddLocationLength = document.getElementById("tableAddLocationLength");
const tableAddLocationBreadth = document.getElementById("tableAddLocationBreadth");

let activeTvTab = "overview";

/* ---- collapsible add-item/zone/location forms (mobile) ----
   On desktop these forms are always visible (see styles.css — the
   toggle button stays display:none there) so none of this changes
   desktop behavior. On mobile, each sheet's add-form starts collapsed
   behind a single button so it doesn't dominate the fixed-height
   panel; expanding one sheet's form doesn't affect the others. */

function setAddSectionExpanded(section, expanded) {
  if (!section) return;
  section.classList.toggle("expanded", expanded);
  const toggle = section.querySelector(".tv-add-toggle");
  const icon = toggle.querySelector(".btn-icon");
  const label = toggle.querySelector(".tv-add-toggle-label");
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  icon.textContent = expanded ? "✕" : "+";
  label.textContent = expanded ? "Cancel" : toggle.dataset.addLabel;

  if (expanded) {
    const firstField = section.querySelector("form input, form select");
    if (firstField) setTimeout(() => firstField.focus(), 50);
  }
}

function collapseAllAddSections() {
  document.querySelectorAll(".tv-add-section").forEach((section) => setAddSectionExpanded(section, false));
}

document.querySelectorAll(".tv-add-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const section = toggle.closest(".tv-add-section");
    setAddSectionExpanded(section, !section.classList.contains("expanded"));
  });
});

function openTableView() {
  syncActiveIntoState();
  populateTableScopeSelect();
  populateAddSelects();
  collapseAllAddSections();
  returnsLoaded = false; // always re-fetch returns on a fresh open, same as Reports/Backup History do
  renderActiveTvSheet();
}

tableViewToggle.addEventListener("change", () => {
  if (tableViewToggle.checked) openTableView();
});

function refreshTableViewIfOpen() {
  if (!tableViewToggle.checked) return;
  populateTableScopeSelect();
  populateAddSelects();
  renderActiveTvSheet();
}

tvTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeTvTab = tab.dataset.tvTab;
    tvTabs.forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });
    tvPanels.forEach((p) => { p.hidden = p.dataset.tvPanel !== activeTvTab; });
    tvLocationFilterLabel.style.display = (activeTvTab === "locations" || activeTvTab === "overview" || activeTvTab === "returns") ? "none" : "";
    collapseAllAddSections();
    renderActiveTvSheet();
  });
});

function renderActiveTvSheet() {
  if (activeTvTab === "overview") renderOverviewSheet();
  else if (activeTvTab === "items") renderItemsSheet();
  else if (activeTvTab === "zones") renderZonesSheet();
  else if (activeTvTab === "locations") renderLocationsSheet();
  else if (activeTvTab === "returns") renderReturnsSheet();
  else renderLowStockSheet();
}

// Shared by the Overview sheet and the Locations sheet's Items/Low
// Stock columns — one place computing "how healthy is this location"
// so both views can never drift out of sync with each other.
function getLocationStats(entry) {
  let itemCount = 0;
  let lowStockCount = 0;
  entry.zones.forEach((zone) => {
    itemCount += zone.items.length;
    zone.items.forEach((item) => { if (isLowStock(item)) lowStockCount++; });
  });
  return {
    zoneCount: entry.zones.length,
    itemCount,
    lowStockCount,
    utilization: computeUtilization(entry.warehouse, entry.zones),
    overlapCount: getOverlappingZoneIds(entry.zones).size,
  };
}

function populateTableScopeSelect() {
  const previous = tableScopeSelect.value || "all";
  tableScopeSelect.innerHTML = '<option value="all">All locations</option>';
  Object.values(appState.warehouses).forEach((entry) => {
    const opt = document.createElement("option");
    opt.value = entry.id;
    opt.textContent = entry.name;
    tableScopeSelect.appendChild(opt);
  });
  tableScopeSelect.value = appState.warehouses[previous] ? previous : "all";
}

function populateAddSelects() {
  [tableAddItemWarehouse, tableAddZoneWarehouse, returnWarehouse].forEach((sel) => {
    const previous = sel.value;
    sel.innerHTML = "";
    Object.values(appState.warehouses).forEach((entry) => {
      const opt = document.createElement("option");
      opt.value = entry.id;
      opt.textContent = entry.name;
      sel.appendChild(opt);
    });
    sel.value = appState.warehouses[previous] ? previous : appState.activeId;
  });
  populateAddItemZoneOptions();
  populateReturnZoneOptions();
}

function populateAddItemZoneOptions() {
  const entry = appState.warehouses[tableAddItemWarehouse.value];
  tableAddItemZone.innerHTML = "";
  if (!entry || !entry.zones.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No zones in this location";
    tableAddItemZone.appendChild(opt);
    return;
  }
  entry.zones.forEach((zone) => {
    const opt = document.createElement("option");
    opt.value = zone.id;
    opt.textContent = zone.name;
    tableAddItemZone.appendChild(opt);
  });
}

tableAddItemWarehouse.addEventListener("change", populateAddItemZoneOptions);
tableScopeSelect.addEventListener("change", () => { itemsPage = zonesPage = lowStockPage = returnsPage = 1; renderActiveTvSheet(); });
tableSearchInput.addEventListener("input", () => { itemsPage = zonesPage = lowStockPage = returnsPage = 1; renderActiveTvSheet(); });

function refreshFloorPlanIfActive(warehouseId) {
  if (warehouseId !== appState.activeId) return;
  renderSidebar();
  renderWarehouse();
}

/* ---- Overview sheet ---- */

function renderOverviewSheet() {
  const entries = Object.values(appState.warehouses);
  const rows = entries.map((entry) => ({ entry, stats: getLocationStats(entry) }));

  const totalZones = rows.reduce((sum, r) => sum + r.stats.zoneCount, 0);
  const totalItems = rows.reduce((sum, r) => sum + r.stats.itemCount, 0);
  const totalLow = rows.reduce((sum, r) => sum + r.stats.lowStockCount, 0);
  const totalOverlaps = rows.reduce((sum, r) => sum + r.stats.overlapCount, 0);
  const avgUtilization = rows.length ? Math.round(rows.reduce((sum, r) => sum + r.stats.utilization, 0) / rows.length) : 0;

  overviewStatsEl.innerHTML = `
    <div class="tv-stat-card">
      <span class="tv-stat-value">${entries.length}</span>
      <span class="tv-stat-label">Location${entries.length === 1 ? "" : "s"}</span>
    </div>
    <div class="tv-stat-card">
      <span class="tv-stat-value">${totalZones}</span>
      <span class="tv-stat-label">Zone${totalZones === 1 ? "" : "s"}</span>
    </div>
    <div class="tv-stat-card">
      <span class="tv-stat-value">${totalItems}</span>
      <span class="tv-stat-label">Item${totalItems === 1 ? "" : "s"}</span>
    </div>
    <div class="tv-stat-card${totalLow > 0 ? " tv-stat-card--alert" : ""}">
      <span class="tv-stat-value">${totalLow}</span>
      <span class="tv-stat-label">Low Stock</span>
    </div>
    <div class="tv-stat-card">
      <span class="tv-stat-value">${avgUtilization}%</span>
      <span class="tv-stat-label">Avg. Space Used</span>
    </div>
    <div class="tv-stat-card${totalOverlaps > 0 ? " tv-stat-card--alert" : ""}">
      <span class="tv-stat-value">${totalOverlaps}</span>
      <span class="tv-stat-label">Overlapping Zones</span>
    </div>
  `;

  const q = tableSearchInput.value.trim().toLowerCase();
  let filteredRows = q ? rows.filter((r) => r.entry.name.toLowerCase().includes(q)) : rows;
  filteredRows = [...filteredRows].sort((a, b) => a.entry.name.localeCompare(b.entry.name));

  overviewTableBody.innerHTML = "";
  overviewTableEmpty.style.display = filteredRows.length ? "none" : "";

  filteredRows.forEach(({ entry, stats }) => {
    const isActive = entry.id === appState.activeId;
    const tr = document.createElement("tr");
    tr.dataset.warehouseId = entry.id;
    tr.innerHTML = `
      <td data-label="Location">${escapeHtml(entry.name)}</td>
      <td data-label="Zones">${stats.zoneCount}</td>
      <td data-label="Items">${stats.itemCount}</td>
      <td data-label="Low Stock">${stats.lowStockCount > 0 ? `<span class="tv-lowstock-flag">⚠ ${stats.lowStockCount}</span>` : "—"}</td>
      <td data-label="Space Used">${stats.utilization}%</td>
      <td data-label="Overlaps">${stats.overlapCount > 0 ? `<span class="tv-lowstock-flag">⚠ ${stats.overlapCount}</span>` : "—"}</td>
      <td data-label="Actions"><button type="button" class="chip-btn tv-loc-switch" ${isActive ? "disabled" : ""}>${isActive ? "Current" : "Switch to"}</button></td>`;
    overviewTableBody.appendChild(tr);
  });
}

overviewTableBody.addEventListener("click", (e) => {
  if (!e.target.closest(".tv-loc-switch")) return;
  const tr = e.target.closest("tr");
  if (!tr) return;
  switchWarehouse(tr.dataset.warehouseId);
  renderOverviewSheet();
});

/* ---------- Reports: trend charts + activity analytics ----------
   Trends are sourced from the `backups` table (daily snapshots) —
   reusing that existing data instead of building a separate
   time-series tracker. Activity analytics are sourced from `history`,
   fetched fresh here rather than reusing appState.history (which is
   capped at HISTORY_MAX for the sidebar's own purposes and isn't the
   right shape for aggregate reporting). */

const openReportsBtn = document.getElementById("openReportsBtn");
const reportsOverlay = document.getElementById("reportsOverlay");
const reportsBackdrop = document.getElementById("reportsBackdrop");
const reportsCloseBtn = document.getElementById("reportsCloseBtn");
const reportsLoading = document.getElementById("reportsLoading");
const reportsEmpty = document.getElementById("reportsEmpty");
const reportTabs = document.querySelectorAll("[data-report-tab]");
const reportPanels = document.querySelectorAll("[data-report-panel]");
const forecastStatsEl = document.getElementById("forecastStats");
const forecastTableBody = document.getElementById("forecastTableBody");
const forecastTableEmpty = document.getElementById("forecastTableEmpty");
const FORECAST_REORDER_BUFFER_DAYS = 14; // suggest enough stock to cover this many days at the current burn rate

let activeReportTab = "trends";
let reportChartInstances = {};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function destroyReportCharts() {
  Object.values(reportChartInstances).forEach((chart) => chart && chart.destroy());
  reportChartInstances = {};
}

function openReports() {
  if (!supa || !tenantId) { showToast("Reports need a cloud connection", "danger"); return; }
  reportsOverlay.classList.add("open");
  loadReports();
}

function closeReports() {
  reportsOverlay.classList.remove("open");
}

if (openReportsBtn) openReportsBtn.addEventListener("click", openReports);
if (reportsBackdrop) reportsBackdrop.addEventListener("click", closeReports);
if (reportsCloseBtn) reportsCloseBtn.addEventListener("click", closeReports);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && reportsOverlay && reportsOverlay.classList.contains("open")) closeReports();
});

reportTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeReportTab = tab.dataset.reportTab;
    reportTabs.forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });
    reportPanels.forEach((p) => { p.hidden = p.dataset.reportPanel !== activeReportTab; });
  });
});

async function loadReports() {
  reportsLoading.style.display = "";
  reportsEmpty.style.display = "none";
  destroyReportCharts();
  try {
    const [trendData, activityData, forecastData] = await Promise.all([fetchTrendData(), fetchActivityData(), fetchForecastData()]);
    if (!trendData.labels.length && !activityData.total && !forecastData.length) {
      reportsEmpty.style.display = "";
      return;
    }
    renderTrendCharts(trendData);
    renderActivityCharts(activityData);
    renderForecastTab(forecastData);
  } catch (e) {
    console.error("Couldn't load reports.", e);
    showToast("Couldn't load reports", "danger");
  } finally {
    reportsLoading.style.display = "none";
  }
}

// Finds an item by id in the CURRENT live state (not the backup
// snapshot) — a forecast is only actionable if the item still
// exists; if it's since been deleted, there's nothing to reorder.
function findLiveItemById(itemId) {
  for (const entry of Object.values(appState.warehouses)) {
    for (const zone of entry.zones) {
      const item = zone.items.find((it) => it.id === itemId);
      if (item) return { item, locationLabel: `${entry.name} / ${zone.name}` };
    }
  }
  return null;
}

// Demand forecasting, scoped honestly: this estimates a rough trend
// from how each item's quantity has moved across recent daily backup
// snapshots, and suggests a reorder quantity to cover a buffer period
// at that rate. It does NOT place any order — there's no supplier
// system this app could actually order from — it's a "here's what to
// consider reordering soon" surface, not automated purchasing.
async function fetchForecastData() {
  const { data: rows, error } = await supa
    .from("backups")
    .select("created_at, data")
    .order("created_at", { ascending: true })
    .limit(60);
  if (error) throw error;

  // Build a per-item time series of { ts, qty } from the raw item
  // rows stored in each snapshot.
  const seriesByItem = new Map();
  (rows || []).forEach((row) => {
    const ts = new Date(row.created_at).getTime();
    (row.data.items || []).forEach((i) => {
      if (!seriesByItem.has(i.id)) seriesByItem.set(i.id, []);
      seriesByItem.get(i.id).push({ ts, qty: i.qty });
    });
  });

  const forecasts = [];
  seriesByItem.forEach((points, itemId) => {
    if (points.length < 2) return; // not enough history to trend at all
    const first = points[0];
    const last = points[points.length - 1];
    const daysSpan = (last.ts - first.ts) / 86400000;
    if (daysSpan <= 0) return;
    const dailyRate = (last.qty - first.qty) / daysSpan; // negative = declining
    if (dailyRate >= -0.01) return; // flat or growing — nothing to forecast

    const live = findLiveItemById(itemId);
    if (!live) return; // deleted since — nothing actionable

    const currentQty = live.item.qty;
    const daysUntilStockout = currentQty / Math.abs(dailyRate);
    const suggestedReorder = Math.max(0, Math.ceil(Math.abs(dailyRate) * FORECAST_REORDER_BUFFER_DAYS - currentQty));

    forecasts.push({
      name: live.item.name,
      locationLabel: live.locationLabel,
      currentQty,
      dailyRate,
      daysUntilStockout,
      suggestedReorder,
    });
  });

  forecasts.sort((a, b) => a.daysUntilStockout - b.daysUntilStockout);
  return forecasts;
}

function renderForecastTab(forecasts) {
  const urgentCount = forecasts.filter((f) => f.daysUntilStockout <= 7).length;

  forecastStatsEl.innerHTML = `
    <div class="tv-stat-card">
      <span class="tv-stat-value">${forecasts.length}</span>
      <span class="tv-stat-label">Item${forecasts.length === 1 ? "" : "s"} Trending Down</span>
    </div>
    <div class="tv-stat-card${urgentCount > 0 ? " tv-stat-card--alert" : ""}">
      <span class="tv-stat-value">${urgentCount}</span>
      <span class="tv-stat-label">Within 7 Days</span>
    </div>
  `;

  forecastTableBody.innerHTML = "";
  forecastTableEmpty.style.display = forecasts.length ? "none" : "";

  forecasts.forEach((f) => {
    const days = Math.round(f.daysUntilStockout);
    const isUrgent = f.daysUntilStockout <= 7;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="Item">${escapeHtml(f.name)}</td>
      <td data-label="Location">${escapeHtml(f.locationLabel)}</td>
      <td data-label="Current Qty">${f.currentQty}</td>
      <td data-label="Losing ~/day">${Math.abs(f.dailyRate).toFixed(1)}</td>
      <td data-label="Est. Stockout">${isUrgent ? `<span class="tv-lowstock-flag">⚠ ${days} day${days === 1 ? "" : "s"}</span>` : `${days} days`}</td>
      <td data-label="Suggested Reorder">${f.suggestedReorder > 0 ? `+${f.suggestedReorder}` : "—"}</td>`;
    forecastTableBody.appendChild(tr);
  });
}

async function fetchTrendData() {
  const { data: rows, error } = await supa
    .from("backups")
    .select("created_at, data")
    .order("created_at", { ascending: true })
    .limit(60);
  if (error) throw error;

  const labels = [];
  const itemCounts = [];
  const zoneCounts = [];
  const lowStockCounts = [];

  (rows || []).forEach((row) => {
    const warehouses = rowsToWarehouses(row.data.warehouses || [], row.data.zones || [], row.data.items || []);
    let items = 0, zones = 0, low = 0;
    Object.values(warehouses).forEach((entry) => {
      zones += entry.zones.length;
      entry.zones.forEach((zone) => {
        items += zone.items.length;
        zone.items.forEach((item) => { if (isLowStock(item)) low++; });
      });
    });
    labels.push(new Date(row.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    itemCounts.push(items);
    zoneCounts.push(zones);
    lowStockCounts.push(low);
  });

  return { labels, itemCounts, zoneCounts, lowStockCounts };
}

async function fetchActivityData() {
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const { data: rows, error } = await supa
    .from("history")
    .select("category, member_id, ts")
    .gte("ts", since)
    .order("ts", { ascending: true })
    .limit(2000);
  if (error) throw error;

  const categoryCounts = {};
  const memberCounts = new Map();
  const dailyCounts = new Map();

  (rows || []).forEach((row) => {
    const category = row.category || "other";
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    const label = row.member_id ? (memberNameById.get(row.member_id) || "Former member") : "Unattributed";
    memberCounts.set(label, (memberCounts.get(label) || 0) + 1);

    const day = new Date(row.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    dailyCounts.set(day, (dailyCounts.get(day) || 0) + 1);
  });

  return { total: (rows || []).length, categoryCounts, memberCounts, dailyCounts };
}

function renderTrendCharts(trendData) {
  const itemsCtx = document.getElementById("trendItemsChart");
  reportChartInstances.trendItems = new Chart(itemsCtx, {
    type: "line",
    data: {
      labels: trendData.labels,
      datasets: [
        { label: "Items", data: trendData.itemCounts, borderColor: cssVar("--cyan"), backgroundColor: cssVar("--cyan-soft"), tension: 0.3, fill: true },
        { label: "Zones", data: trendData.zoneCounts, borderColor: cssVar("--violet"), backgroundColor: cssVar("--violet-soft"), tension: 0.3, fill: true },
      ],
    },
    options: chartBaseOptions(),
  });

  const lowCtx = document.getElementById("trendLowStockChart");
  reportChartInstances.trendLowStock = new Chart(lowCtx, {
    type: "line",
    data: {
      labels: trendData.labels,
      datasets: [
        { label: "Low Stock Items", data: trendData.lowStockCounts, borderColor: cssVar("--amber"), backgroundColor: cssVar("--amber-soft"), tension: 0.3, fill: true },
      ],
    },
    options: chartBaseOptions(),
  });
}

function renderActivityCharts(activityData) {
  const catLabels = Object.keys(activityData.categoryCounts).map((c) => (HISTORY_CATEGORIES[c] || HISTORY_CATEGORIES.other).label);
  const catValues = Object.values(activityData.categoryCounts);
  const catCtx = document.getElementById("activityCategoryChart");
  reportChartInstances.activityCategory = new Chart(catCtx, {
    type: "bar",
    data: { labels: catLabels, datasets: [{ label: "Actions", data: catValues, backgroundColor: cssVar("--cyan") }] },
    options: chartBaseOptions(),
  });

  const memberEntries = [...activityData.memberCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const memberCtx = document.getElementById("activityMemberChart");
  reportChartInstances.activityMember = new Chart(memberCtx, {
    type: "bar",
    data: {
      labels: memberEntries.map((e) => e[0]),
      datasets: [{ label: "Actions", data: memberEntries.map((e) => e[1]), backgroundColor: cssVar("--violet") }],
    },
    options: { ...chartBaseOptions(), indexAxis: "y" },
  });

  const dailyEntries = [...activityData.dailyCounts.entries()];
  const dailyCtx = document.getElementById("activityDailyChart");
  reportChartInstances.activityDaily = new Chart(dailyCtx, {
    type: "bar",
    data: {
      labels: dailyEntries.map((e) => e[0]),
      datasets: [{ label: "Actions", data: dailyEntries.map((e) => e[1]), backgroundColor: cssVar("--emerald") }],
    },
    options: chartBaseOptions(),
  });
}

function chartBaseOptions() {
  const gridColor = cssVar("--border-soft");
  const textColor = cssVar("--muted");
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: textColor } } },
    scales: {
      x: { ticks: { color: textColor }, grid: { color: gridColor } },
      y: { ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true },
    },
  };
}

/* ---- Items sheet ---- */

function getAllItemRows() {
  const rows = [];
  Object.values(appState.warehouses).forEach((entry) => {
    entry.zones.forEach((zone) => {
      zone.items.forEach((item) => {
        rows.push({ warehouseId: entry.id, warehouseName: entry.name, zoneId: zone.id, zoneName: zone.name, item });
      });
    });
  });
  return rows;
}

function renderItemsSheet() {
  const scope = tableScopeSelect.value;
  const q = tableSearchInput.value.trim().toLowerCase();
  let rows = getAllItemRows();
  if (scope !== "all") rows = rows.filter((r) => r.warehouseId === scope);
  if (q) rows = rows.filter((r) => r.item.name.toLowerCase().includes(q) || r.zoneName.toLowerCase().includes(q));
  rows.sort((a, b) => a.warehouseName.localeCompare(b.warehouseName) || a.zoneName.localeCompare(b.zoneName) || a.item.name.localeCompare(b.item.name));

  const { pageRows, totalPages, currentPage } = paginate(rows, itemsPage);
  itemsPage = currentPage;
  updatePaginationControls(itemsPagination, itemsPageLabel, itemsPagePrev, itemsPageNext, currentPage, totalPages);

  itemsTableBody.innerHTML = "";
  itemsTableEmpty.style.display = rows.length ? "none" : "";

  pageRows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.warehouseId = r.warehouseId;
    tr.dataset.zoneId = r.zoneId;
    tr.dataset.itemId = r.item.id;
    tr.innerHTML = `
      <td data-label="Location">${escapeHtml(r.warehouseName)}</td>
      <td data-label="Zone">${escapeHtml(r.zoneName)}</td>
      <td data-label="Item"><input type="text" class="table-cell-input tv-item-name" value="${escapeHtml(r.item.name)}" aria-label="Item name" /></td>
      <td data-label="Qty"><input type="number" class="table-cell-input table-item-qty tv-item-qty" min="0" value="${r.item.qty}" aria-label="Quantity" /></td>
      <td data-label="Min"><input type="number" class="table-cell-input table-item-qty tv-item-min" min="0" value="${itemMinQty(r.item)}" aria-label="Minimum quantity" /></td>
      <td data-label="Actions"><button type="button" class="delete-btn table-row-delete" aria-label="Delete ${escapeHtml(r.item.name)}">✕</button></td>`;
    itemsTableBody.appendChild(tr);
  });
}

itemsTableBody.addEventListener("change", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const entry = appState.warehouses[tr.dataset.warehouseId];
  const zone = entry && entry.zones.find((z) => z.id === tr.dataset.zoneId);
  const item = zone && zone.items.find((i) => i.id === tr.dataset.itemId);
  if (!item) return;
  if (blockIfViewOnly()) { renderItemsSheet(); return; }

  if (e.target.classList.contains("tv-item-name")) {
    const newName = e.target.value.trim();
    if (!newName) { e.target.value = item.name; return; }
    if (newName === item.name) return;
    const oldName = item.name;
    item.name = newName;
    logEvent(`Renamed item <strong>${escapeHtml(oldName)}</strong> to <strong>${escapeHtml(newName)}</strong> in <strong>${escapeHtml(zone.name)}</strong>`, "item");
    refreshFloorPlanIfActive(tr.dataset.warehouseId);
    save();
  }
  if (e.target.classList.contains("tv-item-qty")) {
    const newQty = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = newQty;
    if (newQty === item.qty) return;
    const oldQty = item.qty;
    item.qty = newQty;
    logEvent(`Set <strong>${escapeHtml(item.name)}</strong> to ${newQty} in <strong>${escapeHtml(zone.name)}</strong>`, "item");
    trackQtyChange(item, oldQty);
    refreshFloorPlanIfActive(tr.dataset.warehouseId);
    save();
  }
  if (e.target.classList.contains("tv-item-min")) {
    const newMin = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = newMin;
    if (newMin === itemMinQty(item)) return;
    item.minQty = newMin;
    logEvent(`Set minimum for <strong>${escapeHtml(item.name)}</strong> to ${newMin}`, "item");
    refreshFloorPlanIfActive(tr.dataset.warehouseId);
    save();
  }
});

itemsTableBody.addEventListener("click", (e) => {
  const btn = e.target.closest(".table-row-delete");
  if (!btn) return;
  if (blockIfViewOnly()) return;
  const tr = btn.closest("tr");
  const entry = appState.warehouses[tr.dataset.warehouseId];
  const zone = entry && entry.zones.find((z) => z.id === tr.dataset.zoneId);
  const item = zone && zone.items.find((i) => i.id === tr.dataset.itemId);
  if (!item) return;
  if (!confirm(`Delete "${item.name}"?`)) return;

  zone.items = zone.items.filter((i) => i.id !== item.id);
  logEvent(`Removed <strong>${escapeHtml(item.name)}</strong> from <strong>${escapeHtml(zone.name)}</strong>`, "item");
  cloudDeleteItem(item.id);
  refreshFloorPlanIfActive(tr.dataset.warehouseId);
  save();
  renderItemsSheet();
  showToast(`Removed "${item.name}"`, "danger");
});

tableAddItemForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (blockIfViewOnly()) return;
  const warehouseId = tableAddItemWarehouse.value;
  const zoneId = tableAddItemZone.value;
  const name = tableAddItemName.value.trim();
  if (!zoneId || !name) {
    if (!zoneId) showToast("That location has no zones to add stock into yet", "danger");
    return;
  }
  const qty = Math.max(0, parseInt(tableAddItemQty.value, 10) || 0);
  const minQty = Math.max(0, parseInt(tableAddItemMin.value, 10) || 0);
  const entry = appState.warehouses[warehouseId];
  const zone = entry && entry.zones.find((z) => z.id === zoneId);
  if (!zone) return;

  const item = { id: newId(), name, qty, minQty };
  zone.items.push(item);
  logEvent(`Added <strong>${escapeHtml(item.name)}</strong> (qty ${item.qty}) to <strong>${escapeHtml(zone.name)}</strong>`, "item");
  refreshFloorPlanIfActive(warehouseId);

  tableAddItemName.value = "";
  tableAddItemQty.value = 1;
  tableAddItemMin.value = DEFAULT_MIN_QTY;
  showToast(`Added "${item.name}"`, "success");
  save();
  renderItemsSheet();
  setAddSectionExpanded(tableAddItemForm.closest(".tv-add-section"), false);
});

/* ---- Zones sheet ---- */

function getAllZoneRows() {
  const rows = [];
  Object.values(appState.warehouses).forEach((entry) => {
    entry.zones.forEach((zone) => {
      rows.push({ warehouseId: entry.id, warehouseName: entry.name, zone });
    });
  });
  return rows;
}

function renderZonesSheet() {
  const scope = tableScopeSelect.value;
  const q = tableSearchInput.value.trim().toLowerCase();
  let rows = getAllZoneRows();
  if (scope !== "all") rows = rows.filter((r) => r.warehouseId === scope);
  if (q) rows = rows.filter((r) => r.zone.name.toLowerCase().includes(q));
  rows.sort((a, b) => a.warehouseName.localeCompare(b.warehouseName) || a.zone.name.localeCompare(b.zone.name));

  const { pageRows, totalPages, currentPage } = paginate(rows, zonesPage);
  zonesPage = currentPage;
  updatePaginationControls(zonesPagination, zonesPageLabel, zonesPagePrev, zonesPageNext, currentPage, totalPages);

  zonesTableBody.innerHTML = "";
  zonesTableEmpty.style.display = rows.length ? "none" : "";

  pageRows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.warehouseId = r.warehouseId;
    tr.dataset.zoneId = r.zone.id;
    tr.innerHTML = `
      <td data-label="Location">${escapeHtml(r.warehouseName)}</td>
      <td data-label="Zone"><input type="text" class="table-cell-input tv-zone-name" value="${escapeHtml(r.zone.name)}" aria-label="Zone name" /></td>
      <td data-label="X"><input type="number" class="table-cell-input table-item-qty tv-zone-x" value="${Math.round(r.zone.x)}" aria-label="X position" /></td>
      <td data-label="Y"><input type="number" class="table-cell-input table-item-qty tv-zone-y" value="${Math.round(r.zone.y)}" aria-label="Y position" /></td>
      <td data-label="Width"><input type="number" class="table-cell-input table-item-qty tv-zone-w" min="20" value="${Math.round(r.zone.width)}" aria-label="Width" /></td>
      <td data-label="Height"><input type="number" class="table-cell-input table-item-qty tv-zone-h" min="20" value="${Math.round(r.zone.height)}" aria-label="Height" /></td>
      <td data-label="Items">${r.zone.items.length}</td>
      <td data-label="Actions"><button type="button" class="delete-btn table-row-delete" aria-label="Delete ${escapeHtml(r.zone.name)}">✕</button></td>`;
    zonesTableBody.appendChild(tr);
  });
}

function findZone(tr) {
  const entry = appState.warehouses[tr.dataset.warehouseId];
  const zone = entry && entry.zones.find((z) => z.id === tr.dataset.zoneId);
  return zone ? { entry, zone } : null;
}

zonesTableBody.addEventListener("change", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const found = findZone(tr);
  if (!found) return;
  if (blockIfViewOnly()) { renderZonesSheet(); return; }
  const { entry, zone } = found;

  if (e.target.classList.contains("tv-zone-name")) {
    const newName = e.target.value.trim();
    if (!newName) { e.target.value = zone.name; return; }
    if (newName === zone.name) return;
    const oldName = zone.name;
    zone.name = newName;
    logEvent(`Renamed zone <strong>${escapeHtml(oldName)}</strong> to <strong>${escapeHtml(newName)}</strong>`, "zone");
  } else if (
    e.target.classList.contains("tv-zone-x") ||
    e.target.classList.contains("tv-zone-y") ||
    e.target.classList.contains("tv-zone-w") ||
    e.target.classList.contains("tv-zone-h")
  ) {
    const dims = entry.warehouse;
    let x = parseInt(tr.querySelector(".tv-zone-x").value, 10) || 0;
    let y = parseInt(tr.querySelector(".tv-zone-y").value, 10) || 0;
    let w = Math.max(20, parseInt(tr.querySelector(".tv-zone-w").value, 10) || zone.width);
    let h = Math.max(20, parseInt(tr.querySelector(".tv-zone-h").value, 10) || zone.height);
    w = Math.min(w, dims.length);
    h = Math.min(h, dims.breadth);
    x = Math.max(0, Math.min(x, dims.length - w));
    y = Math.max(0, Math.min(y, dims.breadth - h));
    zone.x = x; zone.y = y; zone.width = w; zone.height = h;
    tr.querySelector(".tv-zone-x").value = x;
    tr.querySelector(".tv-zone-y").value = y;
    tr.querySelector(".tv-zone-w").value = w;
    tr.querySelector(".tv-zone-h").value = h;
    logEvent(`Updated zone <strong>${escapeHtml(zone.name)}</strong> position/size`, "zone");
    if (entry.zones.some((other) => other.id !== zone.id && zonesOverlap(zone, other))) {
      showToast(`"${zone.name}" overlaps another zone`, "danger");
    }
  } else {
    return;
  }

  refreshFloorPlanIfActive(tr.dataset.warehouseId);
  save();
});

zonesTableBody.addEventListener("click", (e) => {
  const btn = e.target.closest(".table-row-delete");
  if (!btn) return;
  if (blockIfViewOnly()) return;
  const tr = btn.closest("tr");
  const found = findZone(tr);
  if (!found) return;
  const { entry, zone } = found;
  if (!confirm(`Delete "${zone.name}" and everything stored in it?`)) return;

  entry.zones = entry.zones.filter((z) => z.id !== zone.id);
  if (tr.dataset.warehouseId === appState.activeId) zones = entry.zones;
  if (selectedZoneId === zone.id) selectedZoneId = null;
  logEvent(`Deleted zone <strong>${escapeHtml(zone.name)}</strong> from <strong>${escapeHtml(entry.name)}</strong>`, "zone");
  cloudDeleteZone(zone.id);
  refreshFloorPlanIfActive(tr.dataset.warehouseId);
  save();
  renderZonesSheet();
  showToast(`Zone "${zone.name}" deleted`, "danger");
});

tableAddZoneForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (blockIfViewOnly()) return;
  const warehouseId = tableAddZoneWarehouse.value;
  const entry = appState.warehouses[warehouseId];
  if (!entry) return;
  const name = tableAddZoneName.value.trim() || "New zone";
  const width = Math.max(20, parseInt(tableAddZoneWidth.value, 10) || 100);
  const height = Math.max(20, parseInt(tableAddZoneHeight.value, 10) || 100);

  if (width > entry.warehouse.length || height > entry.warehouse.breadth) {
    showToast(`Zone must fit within ${entry.warehouse.length} × ${entry.warehouse.breadth}`, "danger");
    return;
  }

  const zone = { id: newId(), name, x: 0, y: 0, width, height, items: [] };
  entry.zones.push(zone);
  if (warehouseId === appState.activeId) zones = entry.zones;
  logEvent(`Created zone <strong>${escapeHtml(zone.name)}</strong> (${width} × ${height}) in <strong>${escapeHtml(entry.name)}</strong>`, "zone");
  refreshFloorPlanIfActive(warehouseId);

  tableAddZoneName.value = "";
  showToast(`Zone "${zone.name}" created`, "success");
  save();
  renderZonesSheet();
  populateAddItemZoneOptions();
  setAddSectionExpanded(tableAddZoneForm.closest(".tv-add-section"), false);
});

/* ---- Locations sheet ---- */

function renderLocationsSheet() {
  const q = tableSearchInput.value.trim().toLowerCase();
  let rows = Object.values(appState.warehouses);
  if (q) rows = rows.filter((entry) => entry.name.toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));

  locationsTableBody.innerHTML = "";
  locationsTableEmpty.style.display = rows.length ? "none" : "";
  const onlyOne = Object.keys(appState.warehouses).length <= 1;

  rows.forEach((entry) => {
    const tr = document.createElement("tr");
    tr.dataset.warehouseId = entry.id;
    const isActive = entry.id === appState.activeId;
    const stats = getLocationStats(entry);
    tr.innerHTML = `
      <td data-label="Name"><input type="text" class="table-cell-input tv-loc-name" value="${escapeHtml(entry.name)}" aria-label="Location name" /></td>
      <td data-label="Length"><input type="number" class="table-cell-input table-item-qty tv-loc-length" min="100" value="${entry.warehouse.length}" aria-label="Length" /></td>
      <td data-label="Breadth"><input type="number" class="table-cell-input table-item-qty tv-loc-breadth" min="100" value="${entry.warehouse.breadth}" aria-label="Breadth" /></td>
      <td data-label="Zones">${entry.zones.length}</td>
      <td data-label="Items">${stats.itemCount}</td>
      <td data-label="Low Stock">${stats.lowStockCount > 0 ? `<span class="tv-lowstock-flag">⚠ ${stats.lowStockCount}</span>` : "—"}</td>
      <td data-label="Actions">
        <button type="button" class="chip-btn tv-loc-switch" ${isActive ? "disabled" : ""}>${isActive ? "Current" : "Switch to"}</button>
        <button type="button" class="delete-btn table-row-delete" aria-label="Delete ${escapeHtml(entry.name)}" ${onlyOne ? "disabled" : ""}>✕</button>
      </td>`;
    locationsTableBody.appendChild(tr);
  });
}

locationsTableBody.addEventListener("change", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const entry = appState.warehouses[tr.dataset.warehouseId];
  if (!entry) return;
  if (blockIfViewOnly()) { renderLocationsSheet(); return; }

  if (e.target.classList.contains("tv-loc-name")) {
    const newName = e.target.value.trim();
    if (!newName) { e.target.value = entry.name; return; }
    if (newName === entry.name) return;
    const oldName = entry.name;
    entry.name = newName;
    logEvent(`Renamed location <strong>${escapeHtml(oldName)}</strong> to <strong>${escapeHtml(newName)}</strong>`, "location");
    renderWarehouseSelect();
  } else if (e.target.classList.contains("tv-loc-length") || e.target.classList.contains("tv-loc-breadth")) {
    const newLength = Math.max(100, parseInt(tr.querySelector(".tv-loc-length").value, 10) || entry.warehouse.length);
    const newBreadth = Math.max(100, parseInt(tr.querySelector(".tv-loc-breadth").value, 10) || entry.warehouse.breadth);
    entry.warehouse.length = newLength;
    entry.warehouse.breadth = newBreadth;
    tr.querySelector(".tv-loc-length").value = newLength;
    tr.querySelector(".tv-loc-breadth").value = newBreadth;
    entry.zones.forEach((z) => {
      z.width = Math.min(z.width, newLength);
      z.height = Math.min(z.height, newBreadth);
      z.x = Math.max(0, Math.min(z.x, newLength - z.width));
      z.y = Math.max(0, Math.min(z.y, newBreadth - z.height));
    });
    logEvent(`Resized <strong>${escapeHtml(entry.name)}</strong> to ${newLength} × ${newBreadth}`, "location");
    if (tr.dataset.warehouseId === appState.activeId) {
      warehouse = entry.warehouse;
      lengthInput.value = warehouse.length;
      breadthInput.value = warehouse.breadth;
    }
  } else {
    return;
  }

  refreshFloorPlanIfActive(tr.dataset.warehouseId);
  save();
  populateTableScopeSelect();
  populateAddSelects();
});

locationsTableBody.addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const warehouseId = tr.dataset.warehouseId;
  const entry = appState.warehouses[warehouseId];
  if (!entry) return;

  if (e.target.closest(".tv-loc-switch")) {
    switchWarehouse(warehouseId);
    renderLocationsSheet();
    return;
  }

  if (e.target.closest(".table-row-delete")) {
    if (blockIfViewOnly()) return;
    if (Object.keys(appState.warehouses).length <= 1) return;
    if (!confirm(`Delete location "${entry.name}" and everything in it? This can't be undone.`)) return;
    const remainingIds = Object.keys(appState.warehouses).filter((id) => id !== warehouseId);
    const wasActive = warehouseId === appState.activeId;
    delete appState.warehouses[warehouseId];
    delete undoStacksById[warehouseId];
    delete redoStacksById[warehouseId];
    writeUndoStacksToStorage();
    writeRedoStacksToStorage();
    if (wasActive) {
      appState.activeId = null;
      switchWarehouse(remainingIds[0]);
    }
    logEvent(`Deleted location <strong>${escapeHtml(entry.name)}</strong>`, "location", null);
    cloudDeleteWarehouse(warehouseId);
    save();
    showToast(`Deleted "${entry.name}"`, "danger");
    populateTableScopeSelect();
    populateAddSelects();
    renderLocationsSheet();
  }
});

tableAddLocationForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (blockIfViewOnly()) return;
  const name = tableAddLocationName.value.trim() || `Warehouse ${Object.keys(appState.warehouses).length + 1}`;
  const length = Math.max(100, parseInt(tableAddLocationLength.value, 10) || 1000);
  const breadth = Math.max(100, parseInt(tableAddLocationBreadth.value, 10) || 600);

  const id = createWarehouseEntry(name, { length, breadth });
  logEvent(`Created location <strong>${escapeHtml(name)}</strong>`, "location");
  showToast(`"${name}" created`, "success");

  tableAddLocationName.value = "";
  save();
  populateTableScopeSelect();
  populateAddSelects();
  renderLocationsSheet();
  setAddSectionExpanded(tableAddLocationForm.closest(".tv-add-section"), false);
});

/* ---- Low Stock sheet ---- */
/* A filtered view of the exact same items the Items sheet shows — no
   separate data, no add-form. A row appears here purely because
   item.qty <= itemMinQty(item), and disappears the moment that's no
   longer true, whether the edit happened here, in the Items sheet, or
   in the sidebar. */

const lowStockTableBody = document.getElementById("lowStockTableBody");
const lowStockTableEmpty = document.getElementById("lowStockTableEmpty");

/* ---------- table pagination (Items / Zones / Low Stock) ----------
   Renders everything already loaded (fetching is unaffected — see
   the earlier discussion on why full-fetch is fine at reasonable
   scale) but only draws TABLE_PAGE_SIZE rows into the DOM at a time.
   That's the part that actually chokes a browser with a few thousand
   items — not the network fetch itself. */

const TABLE_PAGE_SIZE = 50;
let itemsPage = 1;
let zonesPage = 1;
let lowStockPage = 1;
let returnsPage = 1;

const itemsPagination = document.getElementById("itemsPagination");
const itemsPageLabel = document.getElementById("itemsPageLabel");
const itemsPagePrev = document.getElementById("itemsPagePrev");
const itemsPageNext = document.getElementById("itemsPageNext");

const zonesPagination = document.getElementById("zonesPagination");
const zonesPageLabel = document.getElementById("zonesPageLabel");
const zonesPagePrev = document.getElementById("zonesPagePrev");
const zonesPageNext = document.getElementById("zonesPageNext");

const lowStockPagination = document.getElementById("lowStockPagination");
const lowStockPageLabel = document.getElementById("lowStockPageLabel");
const lowStockPagePrev = document.getElementById("lowStockPagePrev");
const lowStockPageNext = document.getElementById("lowStockPageNext");

const returnsPagination = document.getElementById("returnsPagination");
const returnsPageLabel = document.getElementById("returnsPageLabel");
const returnsPagePrev = document.getElementById("returnsPagePrev");
const returnsPageNext = document.getElementById("returnsPageNext");

// Clamps automatically — if rows shrink (e.g. the last item on the
// last page gets deleted), currentPage silently settles back onto a
// valid page instead of showing a stranded empty page.
function paginate(rows, page) {
  const totalPages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * TABLE_PAGE_SIZE;
  return { pageRows: rows.slice(start, start + TABLE_PAGE_SIZE), totalPages, currentPage };
}

function updatePaginationControls(containerEl, labelEl, prevBtn, nextBtn, currentPage, totalPages) {
  containerEl.hidden = totalPages <= 1;
  labelEl.textContent = `Page ${currentPage} of ${totalPages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
}

itemsPagePrev.addEventListener("click", () => { itemsPage--; renderItemsSheet(); });
itemsPageNext.addEventListener("click", () => { itemsPage++; renderItemsSheet(); });
zonesPagePrev.addEventListener("click", () => { zonesPage--; renderZonesSheet(); });
zonesPageNext.addEventListener("click", () => { zonesPage++; renderZonesSheet(); });
lowStockPagePrev.addEventListener("click", () => { lowStockPage--; renderLowStockSheet(); });
lowStockPageNext.addEventListener("click", () => { lowStockPage++; renderLowStockSheet(); });

function renderLowStockSheet() {
  const scope = tableScopeSelect.value;
  const q = tableSearchInput.value.trim().toLowerCase();
  let rows = getAllItemRows().filter((r) => isLowStock(r.item));
  if (scope !== "all") rows = rows.filter((r) => r.warehouseId === scope);
  if (q) rows = rows.filter((r) => r.item.name.toLowerCase().includes(q) || r.zoneName.toLowerCase().includes(q));
  // Most critical first: furthest below its minimum at the top.
  rows.sort((a, b) => (a.item.qty - itemMinQty(a.item)) - (b.item.qty - itemMinQty(b.item)));

  const { pageRows, totalPages, currentPage } = paginate(rows, lowStockPage);
  lowStockPage = currentPage;
  updatePaginationControls(lowStockPagination, lowStockPageLabel, lowStockPagePrev, lowStockPageNext, currentPage, totalPages);

  lowStockTableBody.innerHTML = "";
  lowStockTableEmpty.style.display = rows.length ? "none" : "";

  pageRows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.warehouseId = r.warehouseId;
    tr.dataset.zoneId = r.zoneId;
    tr.dataset.itemId = r.item.id;
    tr.innerHTML = `
      <td data-label="Location">${escapeHtml(r.warehouseName)}</td>
      <td data-label="Zone">${escapeHtml(r.zoneName)}</td>
      <td data-label="Item"><input type="text" class="table-cell-input tv-low-name" value="${escapeHtml(r.item.name)}" aria-label="Item name" /></td>
      <td data-label="Qty"><input type="number" class="table-cell-input table-item-qty tv-low-qty" min="0" value="${r.item.qty}" aria-label="Quantity — edit to restock" /></td>
      <td data-label="Min"><input type="number" class="table-cell-input table-item-qty tv-low-min" min="0" value="${itemMinQty(r.item)}" aria-label="Minimum quantity" /></td>
      <td data-label="Actions"><button type="button" class="delete-btn table-row-delete" aria-label="Delete ${escapeHtml(r.item.name)}">✕</button></td>`;
    lowStockTableBody.appendChild(tr);
  });
}

lowStockTableBody.addEventListener("change", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const entry = appState.warehouses[tr.dataset.warehouseId];
  const zone = entry && entry.zones.find((z) => z.id === tr.dataset.zoneId);
  const item = zone && zone.items.find((i) => i.id === tr.dataset.itemId);
  if (!item) return;
  if (blockIfViewOnly()) { renderLowStockSheet(); return; }

  if (e.target.classList.contains("tv-low-name")) {
    const newName = e.target.value.trim();
    if (!newName) { e.target.value = item.name; return; }
    if (newName === item.name) return;
    const oldName = item.name;
    item.name = newName;
    logEvent(`Renamed item <strong>${escapeHtml(oldName)}</strong> to <strong>${escapeHtml(newName)}</strong> in <strong>${escapeHtml(zone.name)}</strong>`, "item");
    refreshFloorPlanIfActive(tr.dataset.warehouseId);
    save();
    return;
  }

  if (e.target.classList.contains("tv-low-qty")) {
    const newQty = Math.max(0, parseInt(e.target.value, 10) || 0);
    if (newQty === item.qty) { e.target.value = newQty; return; }
    const oldQty = item.qty;
    item.qty = newQty;
    logEvent(`Set <strong>${escapeHtml(item.name)}</strong> to ${newQty} in <strong>${escapeHtml(zone.name)}</strong>`, "item");
    trackQtyChange(item, oldQty);
    refreshFloorPlanIfActive(tr.dataset.warehouseId);
    save();
    renderLowStockSheet(); // row may need to drop off the list now
    return;
  }

  if (e.target.classList.contains("tv-low-min")) {
    const newMin = Math.max(0, parseInt(e.target.value, 10) || 0);
    if (newMin === itemMinQty(item)) { e.target.value = newMin; return; }
    item.minQty = newMin;
    logEvent(`Set minimum for <strong>${escapeHtml(item.name)}</strong> to ${newMin}`, "item");
    refreshFloorPlanIfActive(tr.dataset.warehouseId);
    save();
    renderLowStockSheet(); // may no longer qualify as low with the new threshold
  }
});

lowStockTableBody.addEventListener("click", (e) => {
  const btn = e.target.closest(".table-row-delete");
  if (!btn) return;
  if (blockIfViewOnly()) return;
  const tr = btn.closest("tr");
  const entry = appState.warehouses[tr.dataset.warehouseId];
  const zone = entry && entry.zones.find((z) => z.id === tr.dataset.zoneId);
  const item = zone && zone.items.find((i) => i.id === tr.dataset.itemId);
  if (!item) return;
  if (!confirm(`Delete "${item.name}"?`)) return;

  zone.items = zone.items.filter((i) => i.id !== item.id);
  logEvent(`Removed <strong>${escapeHtml(item.name)}</strong> from <strong>${escapeHtml(zone.name)}</strong>`, "item");
  cloudDeleteItem(item.id);
  refreshFloorPlanIfActive(tr.dataset.warehouseId);
  save();
  renderLowStockSheet();
  showToast(`Removed "${item.name}"`, "danger");
});

/* ---------- Returns sheet ----------
   Scoped to supplier returns, damaged goods, and misdelivered stock —
   this app has no order fulfillment, so this is NOT customer order
   returns. Stored server-side in its own `returns` table (see
   add-returns-table.sql), separate from the core warehouses/zones/
   items sync — fetched fresh whenever this tab is opened, the same
   pattern already used for Backup History and Reports, rather than
   folded into the main boot-time cloudFetchAll(). member_id is set
   by a database trigger, not trusted from this client, for the same
   tamper-proof reason history.member_id is. */

const RETURN_REASON_LABELS = {
  damaged: "Damaged",
  wrong_item: "Wrong item delivered",
  supplier_defect: "Supplier defect",
  expired: "Expired",
  misdelivered: "Misdelivered",
  other: "Other",
};

const RETURN_DISPOSITION_LABELS = {
  returned_to_supplier: "Returned to supplier",
  scrapped: "Scrapped",
  restocked: "Restocked (false alarm)",
  other: "Other",
};

const logReturnForm = document.getElementById("logReturnForm");
const returnWarehouse = document.getElementById("returnWarehouse");
const returnZone = document.getElementById("returnZone");
const returnItem = document.getElementById("returnItem");
const returnQty = document.getElementById("returnQty");
const returnReason = document.getElementById("returnReason");
const returnDisposition = document.getElementById("returnDisposition");
const returnNotes = document.getElementById("returnNotes");
const returnDeductStock = document.getElementById("returnDeductStock");
const returnsTableBody = document.getElementById("returnsTableBody");
const returnsTableEmpty = document.getElementById("returnsTableEmpty");

let allReturns = []; // last-loaded batch, re-fetched each time this tab is opened
let returnsLoaded = false;

function populateReturnZoneOptions() {
  const entry = appState.warehouses[returnWarehouse.value];
  returnZone.innerHTML = "";
  if (!entry || !entry.zones.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No zones in this location";
    returnZone.appendChild(opt);
    populateReturnItemOptions();
    return;
  }
  entry.zones.forEach((zone) => {
    const opt = document.createElement("option");
    opt.value = zone.id;
    opt.textContent = zone.name;
    returnZone.appendChild(opt);
  });
  populateReturnItemOptions();
}

function populateReturnItemOptions() {
  const entry = appState.warehouses[returnWarehouse.value];
  const zone = entry && entry.zones.find((z) => z.id === returnZone.value);
  returnItem.innerHTML = "";
  if (!zone || !zone.items.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No items in this zone";
    returnItem.appendChild(opt);
    return;
  }
  zone.items.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = `${item.name} (qty ${item.qty})`;
    returnItem.appendChild(opt);
  });
}

returnWarehouse.addEventListener("change", populateReturnZoneOptions);
returnZone.addEventListener("change", populateReturnItemOptions);

async function loadReturns() {
  if (!supa || !tenantId) return;
  try {
    const { data, error } = await supa
      .from("returns")
      .select("id, warehouse_id, zone_id, item_id, item_name, zone_name, warehouse_name, qty, reason, disposition, notes, member_id, created_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    allReturns = data || [];
    returnsLoaded = true;
  } catch (e) {
    console.error("Couldn't load returns.", e);
    showToast("Couldn't load returns", "danger");
  }
}

function filterReturns(returns) {
  const q = tableSearchInput.value.trim().toLowerCase();
  if (!q) return returns;
  return returns.filter((r) =>
    (r.item_name || "").toLowerCase().includes(q) ||
    (r.zone_name || "").toLowerCase().includes(q) ||
    (r.warehouse_name || "").toLowerCase().includes(q)
  );
}

function renderReturnsSheet() {
  populateAddSelects(); // keeps returnWarehouse/Zone/Item current with any recent edits
  if (!returnsLoaded) {
    returnsTableBody.innerHTML = "";
    returnsTableEmpty.style.display = "";
    returnsTableEmpty.textContent = "Loading…";
    loadReturns().then(() => { if (activeTvTab === "returns") renderReturnsSheet(); });
    return;
  }

  const { pageRows, totalPages, currentPage } = paginate(filterReturns(allReturns), returnsPage);
  returnsPage = currentPage;
  updatePaginationControls(returnsPagination, returnsPageLabel, returnsPagePrev, returnsPageNext, currentPage, totalPages);

  returnsTableBody.innerHTML = "";
  const filteredCount = filterReturns(allReturns).length;
  returnsTableEmpty.style.display = filteredCount ? "none" : "";
  returnsTableEmpty.textContent = allReturns.length && !filteredCount ? "No returns match your search." : "No returns logged yet.";

  pageRows.forEach((r) => {
    const when = new Date(r.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const authorLabel = getMemberLabel(r.member_id) || "—";
    const reasonLabel = RETURN_REASON_LABELS[r.reason] || r.reason;
    const dispositionLabel = RETURN_DISPOSITION_LABELS[r.disposition] || r.disposition;
    const dispositionClass = r.disposition === "restocked" ? "return-badge--restocked" : "return-badge--disposition";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="Date">${when}</td>
      <td data-label="Location">${escapeHtml(r.warehouse_name || "—")}${r.zone_name ? ` / ${escapeHtml(r.zone_name)}` : ""}</td>
      <td data-label="Item">${escapeHtml(r.item_name)}</td>
      <td data-label="Qty">${r.qty}</td>
      <td data-label="Reason"><span class="return-badge return-badge--reason">${escapeHtml(reasonLabel)}</span></td>
      <td data-label="Disposition"><span class="return-badge ${dispositionClass}">${escapeHtml(dispositionLabel)}</span></td>
      <td data-label="Logged by">${escapeHtml(authorLabel)}</td>
      <td data-label="Notes">${r.notes ? escapeHtml(r.notes) : "—"}</td>`;
    returnsTableBody.appendChild(tr);
  });
}

returnsPagePrev.addEventListener("click", () => { returnsPage--; renderReturnsSheet(); });
returnsPageNext.addEventListener("click", () => { returnsPage++; renderReturnsSheet(); });

logReturnForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (blockIfViewOnly()) return;
  if (!supa || !tenantId) { showToast("Returns need a cloud connection", "danger"); return; }

  const warehouseId = returnWarehouse.value;
  const entry = appState.warehouses[warehouseId];
  if (!entry) { showToast("Choose a location", "danger"); return; }

  const zoneId = returnZone.value;
  const zone = entry.zones.find((z) => z.id === zoneId);

  const itemId = returnItem.value;
  const item = zone && zone.items.find((i) => i.id === itemId);
  if (!item) { showToast("Choose an item — that zone has none to log a return for", "danger"); return; }

  const qty = Math.max(1, parseInt(returnQty.value, 10) || 1);
  const reason = returnReason.value;
  const disposition = returnDisposition.value;
  const notes = returnNotes.value.trim();
  const shouldDeduct = returnDeductStock.checked;

  const submitBtn = logReturnForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Logging…";

  try {
    const { error } = await supa.from("returns").insert({
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      zone_id: zoneId,
      item_id: itemId,
      item_name: item.name,
      zone_name: zone.name,
      warehouse_name: entry.name,
      qty,
      reason,
      disposition,
      notes: notes || null,
    });
    if (error) throw error;

    if (shouldDeduct) {
      const oldQty = item.qty;
      item.qty = Math.max(0, item.qty - qty);
      trackQtyChange(item, oldQty);
      refreshFloorPlanIfActive(warehouseId);
      save();
    }

    logEvent(
      `Logged return of <strong>${qty}× ${escapeHtml(item.name)}</strong> (${escapeHtml(RETURN_REASON_LABELS[reason])}) from <strong>${escapeHtml(zone.name)}</strong>`,
      "return",
      warehouseId
    );

    returnNotes.value = "";
    returnQty.value = 1;
    showToast("Return logged", "success");
    returnsPage = 1;
    returnsLoaded = false; // force a fresh fetch so the new row shows immediately
    renderReturnsSheet();
  } catch (err) {
    console.error("Couldn't log return.", err);
    showToast("Couldn't log return", "danger");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Log Return";
  }
});

/* ---------- access token (admin-provisioned — the URL is the key) ----------
   There's no self-signup here: an admin creates each tenant from
   admin.html, which hands out a link like index.html?t=<token>. This
   app never generates its own token — it only ever reads the one it
   was given. Missing or unrecognized tokens go straight to
   no-access.html. */

function getAccessTokenFromUrl() {
  return new URLSearchParams(location.search).get("t");
}

function goToNoAccess() {
  location.href = "no-access.html";
}

async function copyAccessLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast("Link copied", "success");
  } catch (e) {
    showToast("Couldn't copy — copy the URL from your address bar instead", "danger");
  }
}

if (copyAccessLinkBtn) copyAccessLinkBtn.addEventListener("click", copyAccessLink);

/* ---------- backup history: on-demand snapshots + restore ----------
   Automatic daily snapshots are created server-side (scheduled-backup
   .js) — this is the in-app UI for triggering a manual one on demand
   and for browsing/restoring from any snapshot, automatic or manual.
   Only meaningful when a real tenant is configured (accessToken set);
   local-only mode has no backups table to talk to. */

async function saveSnapshotNow() {
  if (!accessToken) { showToast("Snapshots need a cloud connection", "danger"); return; }
  saveSnapshotBtn.disabled = true;
  const originalLabel = saveSnapshotBtn.innerHTML;
  saveSnapshotBtn.innerHTML = '<span class="menu-item-icon" aria-hidden="true">⏳</span> Saving…';
  try {
    const res = await fetch("/.netlify/functions/create-backup", {
      method: "POST",
      headers: { "x-access-token": accessToken },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    showToast("Snapshot saved", "success");
  } catch (e) {
    console.error("Manual snapshot failed.", e);
    showToast("Couldn't save snapshot", "danger");
  } finally {
    saveSnapshotBtn.disabled = false;
    saveSnapshotBtn.innerHTML = originalLabel;
  }
}

if (saveSnapshotBtn) saveSnapshotBtn.addEventListener("click", saveSnapshotNow);

function openBackupHistory() {
  if (!supa || !tenantId) { showToast("Backup history needs a cloud connection", "danger"); return; }
  backupHistoryOverlay.classList.add("open");
  loadBackupHistory();
}

function closeBackupHistory() {
  backupHistoryOverlay.classList.remove("open");
}

if (openBackupHistoryBtn) openBackupHistoryBtn.addEventListener("click", openBackupHistory);
if (backupHistoryBackdrop) backupHistoryBackdrop.addEventListener("click", closeBackupHistory);
if (backupHistoryCloseBtn) backupHistoryCloseBtn.addEventListener("click", closeBackupHistory);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && backupHistoryOverlay && backupHistoryOverlay.classList.contains("open")) closeBackupHistory();
});

async function loadBackupHistory() {
  backupHistoryList.innerHTML = "";
  backupHistoryEmpty.style.display = "none";
  backupHistoryLoading.style.display = "";
  try {
    // RLS scopes this to the caller's own tenant automatically — no
    // explicit filter needed, same pattern as every other read here.
    const { data: rows, error } = await supa
      .from("backups")
      .select("id, created_at, triggered_by")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    renderBackupHistory(rows || []);
  } catch (e) {
    console.error("Couldn't load backup history.", e);
    showToast("Couldn't load backup history", "danger");
  } finally {
    backupHistoryLoading.style.display = "none";
  }
}

function renderBackupHistory(rows) {
  if (!rows.length) {
    backupHistoryEmpty.style.display = "";
    backupHistoryList.innerHTML = "";
    return;
  }
  backupHistoryEmpty.style.display = "none";
  backupHistoryList.innerHTML = "";
  rows.forEach((row) => {
    const when = new Date(row.created_at).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <div class="history-item__body">
        <div class="history-item__text"><strong>${row.triggered_by === "manual" ? "Manual" : "Automatic"}</strong> snapshot</div>
        <div class="history-item__time">${when}</div>
      </div>
      <button type="button" class="chip-btn chip-btn--danger" data-restore-backup="${row.id}">Restore</button>
    `;
    backupHistoryList.appendChild(li);
  });
}

backupHistoryList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-restore-backup]");
  if (!btn) return;
  if (blockIfViewOnly()) return;
  const backupId = btn.dataset.restoreBackup;
  if (!confirm("Restore this snapshot? Every location, zone, and item currently saved will be replaced with what's in this backup. Your activity history is kept, not rolled back. This can't be undone once confirmed.")) return;

  btn.disabled = true;
  btn.textContent = "Restoring…";
  try {
    const { data: row, error } = await supa.from("backups").select("data").eq("id", backupId).single();
    if (error) throw error;
    const warehouses = rowsToWarehouses(row.data.warehouses || [], row.data.zones || [], row.data.items || []);
    if (!Object.keys(warehouses).length) throw new Error("That snapshot has no locations in it.");
    const restored = { activeId: Object.keys(warehouses)[0], warehouses, history: appState.history || [] };
    const applied = applyImportedState(restored, "Restored from a backup snapshot", { skipConfirm: true });
    if (applied) closeBackupHistory();
  } catch (e) {
    console.error("Restore failed.", e);
    showToast("Couldn't restore that snapshot", "danger");
  } finally {
    btn.disabled = false;
    btn.textContent = "Restore";
  }
});

async function bootTenant() {
  // Resolve this visitor's role, if the members/roles migration has
  // been applied. If current_member_role() doesn't exist yet (older
  // schema, still tenant-only tokens), this fails silently and
  // currentRole stays null — meaning nothing is restricted, same as
  // today. Named current_member_role (not current_role) because
  // current_role is a reserved SQL keyword and collides with
  // Postgres's own niladic pseudo-function of the same name.
  try {
    const { data: role, error: roleError } = await supa.rpc("current_member_role");
    if (!roleError && role) currentRole = role;
  } catch (e) {
    currentRole = null;
  }

  // Resolve "who am I" and the tenant's roster, for attributing
  // history entries to a name instead of just a raw id. Same
  // fail-silent pattern as the role lookup above — if this migration
  // hasn't been applied yet, attribution just doesn't show, nothing
  // else breaks.
  try {
    const { data: memberId, error: memberIdError } = await supa.rpc("current_member_id");
    if (!memberIdError && memberId) currentMemberId = memberId;

    const { data: roster, error: rosterError } = await supa.rpc("tenant_members_public");
    if (!rosterError && roster) {
      memberNameById = new Map(roster.map((m) => [m.id, m.name || `(unnamed ${m.role})`]));
      rosterLoaded = true;
    }
  } catch (e) {
    currentMemberId = null;
  }

  let cloudLoadFailed = false;
  try {
    const cloud = await cloudFetchAll();
    const rememberedActiveId = loadActiveWarehouseId();
    const initialActiveId =
      rememberedActiveId && cloud.warehouses[rememberedActiveId] ? rememberedActiveId : Object.keys(cloud.warehouses)[0];
    appState = Object.keys(cloud.warehouses).length
      ? { activeId: initialActiveId, warehouses: cloud.warehouses, history: cloud.history }
      : (() => {
        // brand-new tenant, no data yet — seed example data, then push it up
        const state = { activeId: null, warehouses: {}, history: [] };
        appState = state;
        seedDemoData();
        return appState;
      })();
    if (!Object.keys(cloud.warehouses).length) await cloudPushAll();
  } catch (e) {
    console.error("Cloud load failed, falling back to local cache.", e);
    showToast("Couldn't reach the cloud — using local data for now", "danger");
    load();
    cloudLoadFailed = true;
  }

  warehouse = appState.warehouses[appState.activeId].warehouse;
  zones = appState.warehouses[appState.activeId].zones;
  refreshKnownIds();
  restoreUndoStacks();
  restoreRedoStacks();
  undoStack = undoStacksById[appState.activeId] || [];
  redoStack = redoStacksById[appState.activeId] || [];

  lengthInput.value = warehouse.length;
  breadthInput.value = warehouse.breadth;
  zones.forEach(clampZoneToWarehouse);
  renderWarehouseSelect();
  renderWarehouse();
  renderSidebar();
  renderHistory();
  updateCanvasHint();
  updateUndoButtonState();

  if (cloudLoadFailed) {
    // A transient fetch failure fell back to whatever's cached in
    // localStorage, purely so the app isn't blank while offline —
    // that cached copy might be old (it's exactly what caused the
    // ghost-zone bug: an outdated local snapshot getting pushed back
    // over correct, current server data). Cache it locally for
    // display, but deliberately do NOT push it to the cloud here.
    // The next real edit — once connectivity is actually back — will
    // sync normally from that point forward, without silently
    // overwriting the server with something old in the meantime.
    syncActiveIntoState();
    updateLowStockBadges();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } catch (e) {
      console.error("Couldn't cache locally.", e);
    }
  } else {
    save();
  }

  applyViewOnlyUI();
}

/* ---------- boot ---------- */

(async function boot() {
  if (!SUPABASE_CONFIGURED) {
    // No Supabase configured — behave exactly as before (local-only,
    // this browser only, no tenant check, no sync).
    load();
    warehouse = appState.warehouses[appState.activeId].warehouse;
    zones = appState.warehouses[appState.activeId].zones;
    restoreUndoStacks();
    restoreRedoStacks();
    undoStack = undoStacksById[appState.activeId] || [];
    redoStack = redoStacksById[appState.activeId] || [];
    lengthInput.value = warehouse.length;
    breadthInput.value = warehouse.breadth;
    zones.forEach(clampZoneToWarehouse);
    renderWarehouseSelect();
    renderWarehouse();
    renderSidebar();
    renderHistory();
    updateCanvasHint();
    updateUndoButtonState();
    save();
    return;
  }

  const token = getAccessTokenFromUrl();
  if (!token) { goToNoAccess(); return; }

  accessToken = token;
  supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { "x-access-token": token } },
  });

  // Resolves the token to a tenant id server-side (security-definer
  // function — never exposes the tenants table itself to the anon
  // key). Null means the token doesn't match any tenant.
  const { data: resolvedId, error: resolveError } = await supa.rpc("current_tenant_id");
  if (resolveError || !resolvedId) { goToNoAccess(); return; }
  tenantId = resolvedId;

  await bootTenant();
  subscribeRealtime();
})();