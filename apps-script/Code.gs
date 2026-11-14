/**
 * Triton — booking API on top of the Google Sheet.
 *
 * Paste this into Extensions → Apps Script in the "Triton Bookings — data" sheet,
 * then Deploy → New deployment → Web app:
 *     Execute as:      Me
 *     Who has access:  Anyone
 * Copy the /exec URL it gives you into app/config.js as SHEETS_API_URL.
 *
 * "Anyone" means anyone who knows the URL can call it, so every request past
 * sign-in carries a session token that this script issues and checks. A resident
 * token only ever returns that flat's own bookings plus the slot occupancy that
 * everyone needs to see. Payment pictures go to a Drive folder this script owns
 * and are handed out only against a valid token.
 */

/* The sheet this script serves. Works both as a standalone script and as one
   bound to the sheet itself. */
var SHEET_ID = "1pIV3uwhWC1oOlGyM7INTPqtkWTx8aA7umjkzXmOcLnY";

var SHEET_LOGINS   = "Logins";
var SHEET_BOOKINGS = "Bookings";
var SHEET_SPACES   = "Spaces";
var SHEET_SESSIONS = "Sessions";
var SHEET_NOTICES  = "Notices";
var SHEET_ISSUES   = "Issues";
var SHEET_DUES     = "Dues";
var SHEET_AUDIT    = "Audit";

var SESSION_DAYS   = 30;   // how long a phone stays signed in
var WINDOW_HOURS   = 48;   // payment window after approval
var PROOF_FOLDER   = "Triton payment proofs";
var ISSUE_FOLDER   = "Triton issue photos";
var MAX_TRIES      = 8;    // wrong PINs allowed per login per 15 minutes

/* Money owed. A charge becomes overdue the day after its due date; once it has
   been overdue this long the committee is asked whether to add interest. The
   decision is theirs every time — nothing is charged automatically. */
var INTEREST_AFTER_DAYS = 7;
var INTEREST_PERCENT    = 2;   // of the unpaid amount, charged once

/* ───────────────────────── entry points ───────────────────────── */

function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  var out;
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    else if (e && e.parameter) body = e.parameter;

    var action = String(body.action || "");
    if (action === "signIn")      out = ok(signIn(body));
    else if (action === "list")   out = ok(list(body));
    else if (action === "create") out = ok(create(body));
    else if (action === "update") out = ok(update(body));
    else if (action === "proof")  out = ok(saveProof(body));
    else if (action === "proofImage") out = ok(proofImage(body));
    else if (action === "addNotice")  out = ok(addNotice(body));
    else if (action === "editNotice") out = ok(editNotice(body));
    else if (action === "raiseIssue") out = ok(raiseIssue(body));
    else if (action === "issueUpdate") out = ok(issueUpdate(body));
    else if (action === "issuePhoto") out = ok(issuePhoto(body));
    else if (action === "addDue")     out = ok(addDue(body));
    else if (action === "dueUpdate")  out = ok(dueUpdate(body));
    else if (action === "interest")   out = ok(interestDecision(body));
    else if (action === "signOut") out = ok(signOut(body));
    else if (action === "ping")   out = ok({ pong: true, version: 1 });
    else out = fail("Unknown action: " + action);
  } catch (err) {
    out = fail(String(err && err.message ? err.message : err));
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok(data)    { return { ok: true, data: data }; }
function fail(msg)   { return { ok: false, error: msg }; }

/* ───────────────────────── sheet helpers ───────────────────────── */

function book() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active && active.getId() === SHEET_ID) return active;
  return SpreadsheetApp.openById(SHEET_ID);
}
function tab(name) {
  var s = book().getSheetByName(name);
  if (!s) throw new Error("The sheet tab '" + name + "' is missing.");
  return s;
}
function rows(name) {
  var s = tab(name), last = s.getLastRow();
  if (last < 2) return [];
  var values = s.getRange(2, 1, last - 1, s.getLastColumn()).getValues();
  var head = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  return values.map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, c) { if (h) o[String(h).trim()] = r[c]; });
    return o;
  });
}
function colIndex(name, key) {
  var head = tab(name).getRange(1, 1, 1, tab(name).getLastColumn()).getValues()[0];
  for (var i = 0; i < head.length; i++) if (String(head[i]).trim() === key) return i + 1;
  throw new Error("Column '" + key + "' not found in " + name);
}
function audit(login, action, booking, detail) {
  tab(SHEET_AUDIT).appendRow([new Date(), login, action, booking || "", detail || ""]);
}

/* ───────────────────────── sign in ───────────────────────── */

function signIn(body) {
  var kind = String(body.kind || "resident");
  var id   = String(body.id || "").trim();
  var pin  = String(body.pin || "").trim();
  if (!id || !pin) throw new Error("Enter both fields.");

  throttle(id);

  var wanted = kind === "committee" ? id.toLowerCase() : id.toUpperCase();
  var hit = null;
  rows(SHEET_LOGINS).forEach(function (r) {
    var lg = String(r.login || "").trim();
    var cmp = kind === "committee" ? lg.toLowerCase() : lg.toUpperCase();
    if (cmp === wanted) hit = r;
  });

  if (!hit || String(hit.pin).trim() !== pin || String(hit.active).toLowerCase() === "no") {
    countFailure(id);
    throw new Error(kind === "committee"
      ? "That committee ID and password do not match."
      : "That flat number and PIN do not match.");
  }
  if (String(hit.role).trim() !== (kind === "committee" ? "committee" : "resident")) {
    throw new Error(kind === "committee"
      ? "That is a resident login. Use the Resident tab."
      : "That is a committee login. Use the Committee tab.");
  }

  clearFailures(id);
  var token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  var expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  tab(SHEET_SESSIONS).appendRow([token, String(hit.login).trim(), String(hit.role).trim(), expires]);
  pruneSessions();
  audit(hit.login, "sign-in", "", "");

  return {
    token: token,
    me: {
      login: String(hit.login).trim(),
      name: String(hit.name || hit.login).trim(),
      unit: String(hit.flat || "").trim() || null,
      role: String(hit.role).trim()
    },
    spaces: spaces(),
    paymentWindowHours: WINDOW_HOURS
  };
}

/* Wrong-PIN throttling, kept in the script's own storage, not the sheet. */
function throttle(id) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get("tries:" + id) || 0);
  if (n >= MAX_TRIES) throw new Error("Too many wrong attempts. Try again in 15 minutes, or ask the desk to reset the PIN.");
}
function countFailure(id) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get("tries:" + id) || 0) + 1;
  cache.put("tries:" + id, String(n), 900);
}
function clearFailures(id) { CacheService.getScriptCache().remove("tries:" + id); }

function session(body) {
  var token = String(body.token || "");
  if (!token) throw new Error("Signed out. Sign in again.");
  var hit = null;
  rows(SHEET_SESSIONS).forEach(function (r) { if (String(r.token) === token) hit = r; });
  if (!hit) throw new Error("Signed out. Sign in again.");
  if (new Date(hit.expires_at).getTime() < Date.now()) throw new Error("Signed out. Sign in again.");

  var me = null;
  rows(SHEET_LOGINS).forEach(function (r) {
    if (String(r.login).trim() === String(hit.login).trim()) me = r;
  });
  if (!me || String(me.active).toLowerCase() === "no") throw new Error("This login has been switched off. Ask the clubhouse desk.");

  return {
    login: String(me.login).trim(),
    name: String(me.name || me.login).trim(),
    unit: String(me.flat || "").trim() || null,
    role: String(me.role).trim()
  };
}
function signOut(body) {
  var token = String(body.token || "");
  var s = tab(SHEET_SESSIONS);
  rows(SHEET_SESSIONS).forEach(function (r) {
    if (String(r.token) === token) s.deleteRow(r._row);
  });
  return { signedOut: true };
}
function pruneSessions() {
  var s = tab(SHEET_SESSIONS), now = Date.now(), dead = [];
  rows(SHEET_SESSIONS).forEach(function (r) {
    if (new Date(r.expires_at).getTime() < now) dead.push(r._row);
  });
  dead.reverse().forEach(function (row) { s.deleteRow(row); });
}

/* ───────────────────────── spaces ───────────────────────── */

function spaces() {
  return rows(SHEET_SPACES).filter(function (r) { return r.id; }).map(function (r) {
    return {
      id: String(r.id).trim(),
      name: String(r.name).trim(),
      cap: String(r.capacity || "").trim(),
      rate: Number(r.rate) || 0,
      unit: String(r.unit || "").trim(),
      slots: parseSlots(String(r.slots || ""))
    };
  });
}
/* Slot shapes, written in the Spaces tab so the committee can change them:
     H1=09:00-15:00=1st half|H2=16:00-23:00=2nd half
     hourly:9-21
     span:9,12,15,18=3                                     */
function parseSlots(spec) {
  function pad(h) { return (h < 10 ? "0" : "") + h + ":00"; }
  if (spec.indexOf("hourly:") === 0) {
    var p = spec.slice(7).split("-"), out = [];
    for (var h = Number(p[0]); h < Number(p[1]); h++) {
      out.push({ id: "H" + h, label: "1 hour", t: pad(h) + "–" + pad(h + 1) });
    }
    return out;
  }
  if (spec.indexOf("span:") === 0) {
    var bits = spec.slice(5).split("="), len = Number(bits[1]);
    return bits[0].split(",").map(function (x) {
      var h = Number(x.trim());
      return { id: "S" + h, label: len + " hours", t: pad(h) + "–" + pad(h + len) };
    });
  }
  return spec.split("|").filter(String).map(function (part) {
    var f = part.split("=");
    return { id: f[0].trim(), t: String(f[1] || "").replace("-", "–").trim(), label: String(f[2] || "").trim() };
  });
}

/* ───────────────────────── bookings ───────────────────────── */

function toBooking(r) {
  return {
    id: String(r.id).trim(),
    facility: String(r.facility).trim(),
    slots: String(r.slots || "").split(",").filter(String),
    date: fmtDate(r.date),
    unit: String(r.flat || "").trim(),
    resident: String(r.resident || "").trim(),
    purpose: String(r.purpose || "").trim(),
    guests: Number(r.guests) || 1,
    amount: Number(r.amount) || 0,
    status: String(r.status || "requested").trim(),
    note: String(r.note || ""),
    proof: r.proof_file_id ? {
      id: String(r.proof_file_id), name: String(r.proof_name || "receipt"),
      at: r.proof_at ? new Date(r.proof_at).getTime() : null
    } : null,
    approved_at: r.approved_at ? new Date(r.approved_at).getTime() : null,
    approved_by: String(r.approved_by || ""),
    verified_at: r.verified_at ? new Date(r.verified_at).getTime() : null,
    created_at: r.created_at ? new Date(r.created_at).getTime() : null
  };
}
function fmtDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, book().getSpreadsheetTimeZone(), "yyyy-MM-dd");
  return String(v || "").trim();
}

function list(body) {
  var me = session(body);
  expireUnpaid();
  var all = rows(SHEET_BOOKINGS).filter(function (r) { return r.id; }).map(toBooking);

  if (me.role === "committee") {
    return {
      me: me, bookings: all, spaces: spaces(), notices: notices(),
      issues: issues(me), dues: dues(me),
      interest: { afterDays: INTEREST_AFTER_DAYS, percent: INTEREST_PERCENT }
    };
  }

  /* A resident gets their own bookings in full, plus a stripped view of
     everyone else's live bookings — enough to grey out taken slots, with no
     names, purposes or amounts. */
  var out = [];
  all.forEach(function (b) {
    if (b.unit === me.unit) { out.push(b); return; }
    if (["requested", "approved", "paid_pending", "confirmed"].indexOf(b.status) > -1) {
      out.push({
        id: "", facility: b.facility, slots: b.slots, date: b.date,
        unit: "", resident: "", purpose: "", guests: 0, amount: 0,
        status: b.status, note: "", proof: null,
        approved_at: null, approved_by: "", verified_at: null, created_at: null
      });
    }
  });
  return {
    me: me, bookings: out, spaces: spaces(), notices: notices(),
    issues: issues(me), dues: dues(me),
    interest: { afterDays: INTEREST_AFTER_DAYS, percent: INTEREST_PERCENT }
  };
}

function create(body) {
  var me = session(body);
  var b  = body.booking || {};
  var unit = me.role === "committee" ? String(b.unit || "").trim() : me.unit;
  if (!unit) throw new Error("Which flat is this booking for?");

  var facility = String(b.facility || "").trim();
  var date     = String(b.date || "").trim();
  var slots    = (b.slots || []).map(String);
  if (!facility || !date || !slots.length) throw new Error("Pick a space, a date and at least one slot.");

  var space = null;
  spaces().forEach(function (s) { if (s.id === facility) space = s; });
  if (!space) throw new Error("That space is not in the Spaces tab.");

  /* One booking at a time, so two residents tapping the same slot in the same
     second cannot both win. */
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    expireUnpaid();
    var clash = false;
    rows(SHEET_BOOKINGS).forEach(function (r) {
      var x = toBooking(r);
      if (x.facility !== facility || x.date !== date) return;
      if (["requested", "approved", "paid_pending", "confirmed"].indexOf(x.status) < 0) return;
      x.slots.forEach(function (s) { if (slots.indexOf(s) > -1) clash = true; });
    });
    if (clash) throw new Error("Somebody took that slot a moment ago. Pick another.");

    var id = nextId();
    tab(SHEET_BOOKINGS).appendRow([
      id, facility, slots.join(","), date, unit,
      me.role === "committee" ? String(b.resident || unit) : me.name,
      String(b.purpose || "Private booking"), Number(b.guests) || 1,
      space.rate * slots.length, "requested", "", "", "", "", "", "", "", new Date()
    ]);
    audit(me.login, "request", id, facility + " " + date + " " + slots.join(","));
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}
function nextId() {
  var n = 0;
  rows(SHEET_BOOKINGS).forEach(function (r) {
    var m = String(r.id).match(/BKG-(\d+)/);
    if (m) n = Math.max(n, Number(m[1]));
  });
  return "BKG-" + String(n + 1).padStart(4, "0");
}

function update(body) {
  var me = session(body);
  var id = String(body.id || "");
  var act = String(body.act || "");

  var hit = null;
  rows(SHEET_BOOKINGS).forEach(function (r) { if (String(r.id).trim() === id) hit = r; });
  if (!hit) throw new Error("That booking is no longer in the register.");
  var b = toBooking(hit);

  var isCommittee = me.role === "committee";
  var isMine = b.unit === me.unit;
  var set = {};

  if (act === "approve") {
    if (!isCommittee) throw new Error("Only the committee can approve.");
    set = { status: "approved", approved_at: new Date(), approved_by: me.login, note: "" };
  } else if (act === "reject") {
    if (!isCommittee) throw new Error("Only the committee can reject.");
    set = { status: "rejected", note: "Not approved by the committee." };
  } else if (act === "verify") {
    if (!isCommittee) throw new Error("Only the committee can confirm a payment.");
    set = { status: "confirmed", verified_at: new Date(), note: "" };
  } else if (act === "reject-pay") {
    if (!isCommittee) throw new Error("Only the committee can return a proof.");
    set = { status: "approved", proof_file_id: "", proof_name: "", proof_at: "",
            note: "Proof returned — upload a clearer receipt before the clock runs out." };
  } else if (act === "cancel") {
    if (!isCommittee && !isMine) throw new Error("That is not your booking.");
    set = { status: "cancelled", note: isCommittee ? "Cancelled by the committee." : "Cancelled by the resident." };
  } else {
    throw new Error("Unknown action: " + act);
  }

  writeRow(hit._row, set);
  audit(me.login, act, id, "");
  return { id: id, status: set.status };
}
function writeRow(row, set) {
  var s = tab(SHEET_BOOKINGS);
  Object.keys(set).forEach(function (k) {
    s.getRange(row, colIndex(SHEET_BOOKINGS, k)).setValue(set[k]);
  });
}

/* ───────────────────────── money owed ─────────────────────────
   Maintenance, penalties and interest live here. What is owed on bookings is
   not copied in — it is read from the booking itself, so the two can never
   disagree. */

var DUE_CATEGORIES = ["maintenance", "penalty", "interest"];

function dues(me) {
  var today = startOfToday();
  var all = rows(SHEET_DUES).filter(function (r) { return r.id; }).map(function (r) {
    var due = r.due_date ? new Date(r.due_date) : null;
    var status = String(r.status || "pending").trim();
    var overdueDays = (due && status === "pending")
      ? Math.floor((today - startOfDay(due)) / 864e5) : 0;
    return {
      id: String(r.id).trim(),
      unit: String(r.flat || "").trim(),
      category: String(r.category || "maintenance").trim(),
      description: String(r.description || "").trim(),
      amount: Number(r.amount) || 0,
      due_date: due ? fmtDate(due) : "",
      status: status,
      overdueDays: overdueDays > 0 ? overdueDays : 0,
      interest_decision: String(r.interest_decision || "").trim(),
      parent: String(r.parent || "").trim(),
      raised_by: String(r.raised_by || "").trim(),
      created_at: r.created_at ? new Date(r.created_at).getTime() : null,
      settled_at: r.settled_at ? new Date(r.settled_at).getTime() : null
    };
  });
  if (me.role === "committee") return all;
  return all.filter(function (d) { return d.unit === me.unit; });
}
function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function startOfToday() { return startOfDay(new Date()); }

function addDue(body) {
  var me = session(body);
  if (me.role !== "committee") throw new Error("Only the committee can raise a charge.");
  var unit = String(body.unit || "").trim();
  var category = String(body.category || "").trim();
  var amount = Math.round(Number(body.amount));
  if (!unit) throw new Error("Which flat is this for?");
  if (DUE_CATEGORIES.indexOf(category) < 0) throw new Error("Unknown kind of charge.");
  if (!(amount > 0)) throw new Error("Enter an amount.");

  var known = false;
  rows(SHEET_LOGINS).forEach(function (r) {
    if (String(r.flat || "").trim().toUpperCase() === unit.toUpperCase()) known = true;
  });
  if (!known) throw new Error("No flat " + unit + " in the Logins tab.");

  var id = nextDueId();
  tab(SHEET_DUES).appendRow([
    id, unit, category, String(body.description || "").trim(),
    amount, String(body.due_date || "").trim(), "pending", "", "",
    me.login, new Date(), ""
  ]);
  audit(me.login, "due-" + category, id, unit + " " + amount);
  return { id: id };
}
function nextDueId() {
  var n = 0;
  rows(SHEET_DUES).forEach(function (r) {
    var m = String(r.id).match(/DUE-(\d+)/);
    if (m) n = Math.max(n, Number(m[1]));
  });
  return "DUE-" + String(n + 1).padStart(4, "0");
}

function dueUpdate(body) {
  var me = session(body);
  if (me.role !== "committee") throw new Error("Only the committee can settle a charge.");
  var id = String(body.id || ""), status = String(body.status || "");
  if (["pending", "paid", "waived"].indexOf(status) < 0) throw new Error("Unknown status.");

  var s = tab(SHEET_DUES), hit = null;
  rows(SHEET_DUES).forEach(function (r) { if (String(r.id).trim() === id) hit = r; });
  if (!hit) throw new Error("That charge is no longer in the ledger.");

  s.getRange(hit._row, colIndex(SHEET_DUES, "status")).setValue(status);
  s.getRange(hit._row, colIndex(SHEET_DUES, "settled_at")).setValue(status === "pending" ? "" : new Date());
  audit(me.login, "due-" + status, id, "");
  return { id: id, status: status };
}

/* The committee is asked once per overdue charge. "yes" adds a separate interest
   line against the same flat; "no" records that it was waived, so the charge
   stops being offered. Either way the decision is written down and attributable. */
function interestDecision(body) {
  var me = session(body);
  if (me.role !== "committee") throw new Error("Only the committee can decide on interest.");
  var id = String(body.id || "");
  var apply = !!body.apply;

  var s = tab(SHEET_DUES), hit = null;
  rows(SHEET_DUES).forEach(function (r) { if (String(r.id).trim() === id) hit = r; });
  if (!hit) throw new Error("That charge is no longer in the ledger.");
  if (String(hit.status).trim() !== "pending") throw new Error("That charge is already settled.");
  if (String(hit.interest_decision || "").trim()) throw new Error("Interest has already been decided on this one.");

  s.getRange(hit._row, colIndex(SHEET_DUES, "interest_decision")).setValue(apply ? "applied" : "waived");

  if (!apply) {
    audit(me.login, "interest-waived", id, "");
    return { id: id, applied: false };
  }

  var amount = Math.round((Number(hit.amount) || 0) * INTEREST_PERCENT / 100);
  if (amount < 1) amount = 1;
  var childId = nextDueId();
  tab(SHEET_DUES).appendRow([
    childId, String(hit.flat).trim(), "interest",
    INTEREST_PERCENT + "% on " + id + " (" + String(hit.description || hit.category).trim() + ")",
    amount, fmtDate(new Date(Date.now() + 7 * 864e5)), "pending", "", id,
    me.login, new Date(), ""
  ]);
  audit(me.login, "interest-applied", childId, id + " " + amount);
  return { id: childId, applied: true, amount: amount };
}

/* ───────────────────────── notice board ─────────────────────────
   Residents can read notices; only the committee can post one. */

function notices() {
  return rows(SHEET_NOTICES).filter(function (r) { return r.id; }).map(function (r) {
    return {
      id: String(r.id).trim(),
      title: String(r.title || "").trim(),
      body: String(r.body || "").trim(),
      pinned: String(r.pinned || "").toLowerCase() === "yes",
      posted_at: r.posted_at ? new Date(r.posted_at).getTime() : null,
      posted_by: String(r.posted_by || "").trim()
    };
  }).sort(function (a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.posted_at || 0) - (a.posted_at || 0);
  });
}

function addNotice(body) {
  var me = session(body);
  if (me.role !== "committee") throw new Error("Only the committee can post a notice.");
  var title = String(body.title || "").trim();
  var text  = String(body.body || "").trim();
  if (!title) throw new Error("Give the notice a heading.");
  if (!text)  throw new Error("Write the notice itself.");

  var n = 0;
  rows(SHEET_NOTICES).forEach(function (r) {
    var m = String(r.id).match(/NTC-(\d+)/);
    if (m) n = Math.max(n, Number(m[1]));
  });
  var id = "NTC-" + String(n + 1).padStart(4, "0");

  tab(SHEET_NOTICES).appendRow([
    id, title, text, body.pinned ? "yes" : "", new Date(), me.name
  ]);
  audit(me.login, "notice", id, title);
  return { id: id };
}

function editNotice(body) {
  var me = session(body);
  if (me.role !== "committee") throw new Error("Only the committee can change a notice.");
  var id = String(body.id || "");
  var s = tab(SHEET_NOTICES), hit = null;
  rows(SHEET_NOTICES).forEach(function (r) { if (String(r.id).trim() === id) hit = r; });
  if (!hit) throw new Error("That notice is no longer on the board.");

  if (body.remove) {
    s.deleteRow(hit._row);
    audit(me.login, "notice-remove", id, "");
    return { removed: true };
  }
  if (typeof body.pinned !== "undefined") {
    s.getRange(hit._row, colIndex(SHEET_NOTICES, "pinned")).setValue(body.pinned ? "yes" : "");
  }
  if (body.title) s.getRange(hit._row, colIndex(SHEET_NOTICES, "title")).setValue(String(body.title));
  if (body.body)  s.getRange(hit._row, colIndex(SHEET_NOTICES, "body")).setValue(String(body.body));
  audit(me.login, "notice-edit", id, "");
  return { id: id };
}

/* ───────────────────────── issues ─────────────────────────
   A resident reports a problem, with a photo where it helps. They see their own
   flat's issues; the committee sees all of them. */

function issues(me) {
  var all = rows(SHEET_ISSUES).filter(function (r) { return r.id; }).map(function (r) {
    return {
      id: String(r.id).trim(),
      unit: String(r.flat || "").trim(),
      resident: String(r.resident || "").trim(),
      category: String(r.category || "").trim(),
      detail: String(r.detail || "").trim(),
      status: String(r.status || "open").trim(),
      reply: String(r.reply || "").trim(),
      photo: r.photo_file_id ? { id: String(r.photo_file_id), name: String(r.photo_name || "photo") } : null,
      created_at: r.created_at ? new Date(r.created_at).getTime() : null,
      closed_at: r.closed_at ? new Date(r.closed_at).getTime() : null
    };
  });
  if (me.role === "committee") return all;
  return all.filter(function (i) { return i.unit === me.unit; });
}

function raiseIssue(body) {
  var me = session(body);
  var unit = me.role === "committee" ? String(body.unit || "").trim() : me.unit;
  if (!unit) throw new Error("Which flat is this for?");
  var detail = String(body.detail || "").trim();
  if (!detail) throw new Error("Describe the problem.");

  var n = 0;
  rows(SHEET_ISSUES).forEach(function (r) {
    var m = String(r.id).match(/ISS-(\d+)/);
    if (m) n = Math.max(n, Number(m[1]));
  });
  var id = "ISS-" + String(n + 1).padStart(4, "0");

  var fileId = "", fileName = "";
  if (body.dataUrl) {
    var m2 = String(body.dataUrl).match(/^data:([^;]+);base64,(.*)$/);
    if (!m2) throw new Error("Could not read that photo. Try a JPG or PNG.");
    fileName = String(body.name || "photo.jpg");
    var blob = Utilities.newBlob(Utilities.base64Decode(m2[2]), m2[1], unit + "-" + id + "-" + fileName);
    fileId = issueFolder().createFile(blob).getId();
  }

  tab(SHEET_ISSUES).appendRow([
    id, unit, me.name, String(body.category || "Other"), detail,
    "open", fileId, fileName, "", new Date(), ""
  ]);
  audit(me.login, "issue", id, String(body.category || "Other"));
  return { id: id };
}

function issueUpdate(body) {
  var me = session(body);
  if (me.role !== "committee") throw new Error("Only the committee can update an issue.");
  var id = String(body.id || ""), status = String(body.status || "");
  if (["open", "in_progress", "closed"].indexOf(status) < 0) throw new Error("Unknown status.");

  var s = tab(SHEET_ISSUES), hit = null;
  rows(SHEET_ISSUES).forEach(function (r) { if (String(r.id).trim() === id) hit = r; });
  if (!hit) throw new Error("That issue is no longer in the list.");

  s.getRange(hit._row, colIndex(SHEET_ISSUES, "status")).setValue(status);
  if (typeof body.reply === "string") {
    s.getRange(hit._row, colIndex(SHEET_ISSUES, "reply")).setValue(body.reply);
  }
  s.getRange(hit._row, colIndex(SHEET_ISSUES, "closed_at")).setValue(status === "closed" ? new Date() : "");
  audit(me.login, "issue-" + status, id, "");
  return { id: id, status: status };
}

function issuePhoto(body) {
  var me = session(body);
  var id = String(body.id || "");
  var hit = null;
  rows(SHEET_ISSUES).forEach(function (r) { if (String(r.id).trim() === id) hit = r; });
  if (!hit || !hit.photo_file_id) throw new Error("No photo on that issue.");
  if (me.role !== "committee" && String(hit.flat).trim() !== me.unit) throw new Error("That is not your issue.");

  var blob = DriveApp.getFileById(String(hit.photo_file_id)).getBlob();
  return { dataUrl: "data:" + blob.getContentType() + ";base64," + Utilities.base64Encode(blob.getBytes()) };
}

function issueFolder() {
  var it = DriveApp.getFoldersByName(ISSUE_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ISSUE_FOLDER);
}

/* ───────────────────────── payment proof ───────────────────────── */

function saveProof(body) {
  var me = session(body);
  var id = String(body.id || "");
  var hit = null;
  rows(SHEET_BOOKINGS).forEach(function (r) { if (String(r.id).trim() === id) hit = r; });
  if (!hit) throw new Error("That booking is no longer in the register.");

  var b = toBooking(hit);
  if (me.role !== "committee" && b.unit !== me.unit) throw new Error("That is not your booking.");
  if (b.status !== "approved") throw new Error("This booking is not waiting for payment.");

  var name = String(body.name || "receipt.jpg");
  var data = String(body.dataUrl || "");
  var m = data.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error("Could not read that picture. Try a JPG or PNG.");

  var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], b.unit + "-" + id + "-" + name);
  var file = proofFolder().createFile(blob);

  writeRow(hit._row, {
    status: "paid_pending", proof_file_id: file.getId(),
    proof_name: name, proof_at: new Date(), note: ""
  });
  audit(me.login, "proof", id, file.getId());
  return { fileId: file.getId() };
}
/* Hands the picture back to the app as a data URL. The Drive file itself stays
   private to the sheet's owner; this is the only way in, and it needs a token. */
function proofImage(body) {
  var me = session(body);
  var id = String(body.id || "");
  var hit = null;
  rows(SHEET_BOOKINGS).forEach(function (r) { if (String(r.id).trim() === id) hit = r; });
  if (!hit || !hit.proof_file_id) throw new Error("No payment picture on that booking.");
  var b = toBooking(hit);
  if (me.role !== "committee" && b.unit !== me.unit) throw new Error("That is not your booking.");

  var file = DriveApp.getFileById(String(hit.proof_file_id));
  var blob = file.getBlob();
  return { dataUrl: "data:" + blob.getContentType() + ";base64," + Utilities.base64Encode(blob.getBytes()) };
}

function proofFolder() {
  var it = DriveApp.getFoldersByName(PROOF_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PROOF_FOLDER);
}

/* ───────────────────────── the 48-hour rule ───────────────────────── */

/* Runs on every read, and should also be set up as a time-driven trigger
   (Apps Script → Triggers → Add trigger → expireUnpaid → Hour timer) so the
   rule holds even when nobody has the app open. */
function expireUnpaid() {
  var cutoff = Date.now() - WINDOW_HOURS * 36e5;
  var s = tab(SHEET_BOOKINGS);
  rows(SHEET_BOOKINGS).forEach(function (r) {
    if (String(r.status).trim() !== "approved") return;
    if (!r.approved_at) return;
    if (new Date(r.approved_at).getTime() > cutoff) return;
    s.getRange(r._row, colIndex(SHEET_BOOKINGS, "status")).setValue("cancelled_nopay");
    s.getRange(r._row, colIndex(SHEET_BOOKINGS, "note"))
     .setValue("No payment picture within " + WINDOW_HOURS + " hours of approval.");
    audit("system", "auto-cancel", String(r.id).trim(), "");
  });
}
