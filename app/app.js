/* Triton — app shell, two dashboards.
   Resident:  Book a space · My bookings · Rules
   Committee: Pending work · Approvals · Payments · Register · Day view */
(function () {
  "use strict";

  var CFG = window.TRITON_CONFIG || {};
  var HOUR = 36e5, WINDOW_H = CFG.PAYMENT_WINDOW_HOURS || 48;

  function p(h) { return (h < 10 ? "0" : "") + h + ":00"; }
  function hourSlots(a, b) { var o = []; for (var h = a; h < b; h++) o.push({ id: "H" + h, label: "1 hour", t: p(h) + "–" + p(h + 1) }); return o; }
  function spanSlots(list, len, label) { return list.map(function (h) { return { id: "S" + h, label: label, t: p(h) + "–" + p(h + len) }; }); }

  /* Fallback shapes, used only in demo mode. In normal use the Spaces tab of the
     sheet is the source of truth, so the committee can change rates and hours
     without anybody touching the code. */
  var BUILTIN = [
    { id: "banquet", name: "Banquet Hall", cap: "200 guests", rate: 15000, unit: "per half-day",
      slots: [{ id: "H1", label: "1st half", t: "09:00–15:00" }, { id: "H2", label: "2nd half", t: "16:00–23:00" }] },
    { id: "terrace", name: "Terrace", cap: "80 guests", rate: 9000, unit: "per half-day",
      slots: [{ id: "H1", label: "1st half", t: "09:00–15:00" }, { id: "H2", label: "2nd half", t: "16:00–23:00" }] },
    { id: "mr1", name: "Meeting Room 1", cap: "8 seats", rate: 400, unit: "per hour", slots: hourSlots(9, 21) },
    { id: "mr2", name: "Meeting Room 2", cap: "12 seats", rate: 500, unit: "per hour", slots: hourSlots(9, 21) },
    { id: "mr3", name: "Meeting Room 3", cap: "20 seats", rate: 700, unit: "per hour", slots: hourSlots(9, 21) },
    { id: "den", name: "The Den", cap: "14 guests", rate: 1200, unit: "per 3-hour slot", slots: spanSlots([9, 12, 15, 18], 3, "3 hours") },
    { id: "theatre", name: "Home Theatre", cap: "10 seats", rate: 2500, unit: "per 5-hour slot", slots: spanSlots([10, 16], 5, "5 hours") },
    { id: "golf", name: "Golf Room", cap: "4 players", rate: 1500, unit: "per 2-hour slot", slots: spanSlots([8, 10, 12, 14, 16, 18, 20], 2, "2 hours") }
  ];
  var FACILITIES = BUILTIN, FMAP = {};
  function useSpaces(list) {
    FACILITIES = (list && list.length) ? list : BUILTIN;
    FMAP = {};
    FACILITIES.forEach(function (f) { FMAP[f.id] = f; });
  }
  useSpaces(null);

  var LIVE = { requested: 1, approved: 1, paid_pending: 1, confirmed: 1 };
  var LABEL = {
    requested: "Awaiting approval", approved: "Awaiting payment", paid_pending: "Proof under review",
    confirmed: "Confirmed", rejected: "Rejected", cancelled_nopay: "Auto-cancelled", cancelled: "Cancelled"
  };

  var S = { me: null, tab: "", date: iso(new Date()), sel: { fac: null, slots: [] }, bookings: [], busy: false };

  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function addDays(s, n) { var d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); }
  function money(n) { return "₹" + Number(n || 0).toLocaleString("en-IN"); }
  function prettyDate(s) { return new Date(s + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }); }
  function stamp(t) { return new Date(t).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function deadline(b) { return b.approved_at ? b.approved_at + WINDOW_H * HOUR : null; }
  function countdown(ms) {
    if (ms <= 0) return "expired";
    var h = Math.floor(ms / HOUR), m = Math.floor((ms % HOUR) / 6e4);
    return h + "h " + String(m).padStart(2, "0") + "m left";
  }
  function isResident() { return S.me && S.me.role === "resident"; }
  function mine(b) { return S.me && b.unit === S.me.unit; }
  function slotTimes(b) {
    var f = FMAP[b.facility]; if (!f) return "";
    return f.slots.filter(function (s) { return (b.slots || []).indexOf(s.id) > -1; }).map(function (s) { return s.t; }).join(", ");
  }
  function slotHolder(fac, date, slotId) {
    var hit = null;
    S.bookings.forEach(function (b) {
      if (b.facility === fac && b.date === date && LIVE[b.status] && (b.slots || []).indexOf(slotId) > -1) hit = b;
    });
    return hit;
  }

  var loginEl = document.getElementById("login"), appEl = document.getElementById("app");
  var viewEl = document.getElementById("view"), tabsEl = document.getElementById("tabs");

  /* ───────────── login ───────────── */
  function showLogin() {
    loginEl.hidden = false; appEl.hidden = true;
    document.getElementById("demo-note").hidden = Data.mode !== "demo";
  }
  function wireLogin() {
    var segR = document.getElementById("seg-resident"), segC = document.getElementById("seg-committee");
    var formR = document.getElementById("form-resident"), formC = document.getElementById("form-committee");
    function pick(which) {
      var res = which === "resident";
      segR.setAttribute("aria-selected", res ? "true" : "false");
      segC.setAttribute("aria-selected", res ? "false" : "true");
      formR.hidden = !res; formC.hidden = res;
      document.getElementById("err-resident").hidden = true;
      document.getElementById("err-committee").hidden = true;
    }
    segR.onclick = function () { pick("resident"); };
    segC.onclick = function () { pick("committee"); };

    function submit(kind, idEl, pinEl, errEl, btn) {
      var err = document.getElementById(errEl);
      err.hidden = true;
      btn.disabled = true; btn.textContent = "Signing in…";
      Data.signIn(kind, document.getElementById(idEl).value, document.getElementById(pinEl).value)
        .then(function (me) { S.me = me; start(); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; })
        .then(function () { btn.disabled = false; btn.textContent = "Sign in"; });
    }
    formR.onsubmit = function (e) { e.preventDefault(); submit("resident", "li-flat", "li-pin", "err-resident", formR.querySelector("button[type=submit]")); };
    formC.onsubmit = function (e) { e.preventDefault(); submit("committee", "li-staff", "li-staffpin", "err-committee", formC.querySelector("button[type=submit]")); };
  }

  function start() {
    loginEl.hidden = true; appEl.hidden = false;
    document.getElementById("who-name").textContent = S.me.name;
    document.getElementById("who-role").textContent = isResident() ? S.me.unit : "Committee";
    document.getElementById("avatar").textContent = initials(S.me.name);
    document.getElementById("sub").textContent = isResident() ? "Your bookings" : "Clubhouse desk";
    S.tab = isResident() ? "book" : "pending";
    refresh();
  }
  function initials(n) {
    return String(n || "?").split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
  }

  document.getElementById("signout").onclick = function () {
    Data.signOut().then(function () { S.me = null; S.bookings = []; showLogin(); });
  };

  /* ───────────── data refresh ───────────── */
  function refresh() {
    return Data.list().then(function (list) {
      S.bookings = list;
      useSpaces(Data.spaces);
      return sweepExpired();
    }).then(render).catch(function (e) {
      viewEl.innerHTML = '<div class="empty"><strong>Could not load bookings</strong>' + esc(e.message) + '</div>';
    });
  }
  /* The sheet applies the 48-hour rule on every read and on an hourly trigger,
     so this only has to cover demo mode, which has no server. */
  function sweepExpired() {
    if (Data.mode !== "demo") return Promise.resolve();
    var now = Date.now();
    S.bookings.forEach(function (b) {
      if (b.status === "approved" && deadline(b) && now > deadline(b)) {
        b.status = "cancelled_nopay";
        b.note = "No payment picture within " + WINDOW_H + " hours of approval.";
      }
    });
    return Promise.resolve();
  }

  /* ───────────── tabs ───────────── */
  function tabDefs() {
    if (isResident()) {
      var due = S.bookings.filter(function (b) { return mine(b) && b.status === "approved"; }).length;
      return [{ id: "book", label: "Book a space" }, { id: "mine", label: "My bookings", cnt: due }, { id: "rules", label: "Rules" }];
    }
    var req = S.bookings.filter(function (b) { return b.status === "requested"; }).length;
    var ver = S.bookings.filter(function (b) { return b.status === "paid_pending"; }).length;
    return [
      { id: "pending", label: "Pending work", cnt: req + ver },
      { id: "approvals", label: "Approvals", cnt: req },
      { id: "payments", label: "Payments", cnt: ver },
      { id: "register", label: "Register" },
      { id: "day", label: "Day view" }
    ];
  }
  function renderTabs() {
    tabsEl.innerHTML = "";
    tabDefs().forEach(function (t) {
      var b = document.createElement("button");
      b.className = "tab"; b.type = "button"; b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", S.tab === t.id ? "true" : "false");
      b.innerHTML = esc(t.label) + (t.cnt ? ' <span class="cnt num">' + t.cnt + "</span>" : "");
      b.onclick = function () { S.tab = t.id; S.sel = { fac: null, slots: [] }; render(); };
      tabsEl.appendChild(b);
    });
  }

  function cell(k, v, s, cls) {
    return '<div><div class="k">' + k + '</div><div class="v num ' + (cls || "") + '">' + v + '</div><div class="s">' + s + "</div></div>";
  }
  function residentPipe() {
    var now = Date.now(), due = 0, wait = 0, conf = 0, soon = null;
    S.bookings.forEach(function (b) {
      if (!mine(b)) return;
      if (b.status === "approved") { due++; var l = deadline(b) - now; if (soon === null || l < soon) soon = l; }
      if (b.status === "requested" || b.status === "paid_pending") wait++;
      if (b.status === "confirmed") conf++;
    });
    return '<div class="pipe">' +
      cell("Payment due", due, soon !== null ? countdown(soon) + " on the soonest" : "nothing outstanding", due ? "alert" : "") +
      cell("With the desk", wait, "approval or proof check", "") +
      cell("Confirmed", conf, "slot held for you", "") + "</div>";
  }
  function committeePipe() {
    var now = Date.now(), req = 0, pay = 0, ver = 0, conf = 0, hot = 0, rev = 0;
    S.bookings.forEach(function (b) {
      if (b.status === "requested") req++;
      if (b.status === "approved") { pay++; if (deadline(b) - now < 12 * HOUR) hot++; }
      if (b.status === "paid_pending") ver++;
      if (b.status === "confirmed") { conf++; rev += Number(b.amount || 0); }
    });
    return '<div class="pipe">' +
      cell("To approve", req, "residents waiting", req ? "warn" : "") +
      cell("Approved, unpaid", pay, hot ? hot + " inside 12h" : WINDOW_H + "h clock running", hot ? "alert" : "") +
      cell("Proof to verify", ver, "check against bank", ver ? "warn" : "") +
      cell("Collected", money(rev), conf + " confirmed", "") + "</div>";
  }

  /* ───────────── committee: pending work ───────────── */
  function renderPending() {
    var now = Date.now();
    var toApprove = S.bookings.filter(function (b) { return b.status === "requested"; });
    var toVerify = S.bookings.filter(function (b) { return b.status === "paid_pending"; });
    var expiring = S.bookings.filter(function (b) { return b.status === "approved" && deadline(b) - now < 24 * HOUR; });
    var todays = S.bookings.filter(function (b) { return b.date === iso(new Date()) && b.status === "confirmed"; });

    var h = committeePipe() + '<div class="queue">';
    h += qcard("Requests to approve", toApprove, "approvals", "Nothing waiting for a decision.", false, function (b) {
      return esc(b.unit) + " · " + esc(FMAP[b.facility].name) + " · " + prettyDate(b.date);
    }, function (b) { return money(b.amount); });
    h += qcard("Proof to verify", toVerify, "payments", "No payment pictures waiting.", false, function (b) {
      return esc(b.unit) + " · " + money(b.amount) + " · " + esc(FMAP[b.facility].name);
    }, function (b) { return "sent " + stamp(b.proof ? b.proof.at : b.approved_at); });
    h += qcard("Clock running out", expiring, "payments", "No payment deadline inside 24 hours.", true, function (b) {
      return esc(b.unit) + " · " + money(b.amount) + " · " + esc(FMAP[b.facility].name);
    }, function (b) { return countdown(deadline(b) - now); });
    h += qcard("On today", todays, "day", "Nothing booked for today.", false, function (b) {
      return esc(b.unit) + " · " + esc(FMAP[b.facility].name);
    }, function (b) { return slotTimes(b); });
    h += "</div>";

    viewEl.innerHTML = h;
    Array.prototype.forEach.call(viewEl.querySelectorAll("[data-go]"), function (el) {
      el.onclick = function () { S.tab = el.dataset.go; render(); };
    });
  }
  function qcard(title, list, go, none, urgent, lineFn, metaFn) {
    var h = '<div class="qcard' + (urgent && list.length ? " urgent" : "") + '">' +
      "<h3>" + title + '<span class="qn">' + list.length + "</span></h3>";
    if (!list.length) { h += '<p class="qnone">' + none + "</p>"; return h + "</div>"; }
    h += '<div class="qlist">' + list.slice(0, 5).map(function (b) {
      return '<div class="qitem"><b>' + lineFn(b) + "</b><span>" + metaFn(b) + "</span></div>";
    }).join("") + "</div>";
    if (list.length > 5) h += '<p class="qnone">and ' + (list.length - 5) + " more</p>";
    h += '<div class="qgo"><button type="button" class="btn sm" data-go="' + go + '">Open</button></div>';
    return h + "</div>";
  }

  /* ───────────── resident: book a space ───────────── */
  function renderBook() {
    var d = S.date;
    var h = residentPipe() + '<div class="bar">' +
      '<div class="f"><label for="dt">Date</label><input type="date" id="dt" value="' + d + '"></div>' +
      '<button class="btn sm" id="prev" type="button">&larr; Prev</button>' +
      '<button class="btn sm" id="today" type="button">Today</button>' +
      '<button class="btn sm" id="next" type="button">Next &rarr;</button>' +
      '<p class="hint">Tap a free slot on ' + prettyDate(d) + ". Pick several slots of the same space for a longer booking.</p></div>";

    h += '<div class="facgrid">';
    FACILITIES.forEach(function (f) {
      var rail = "", taken = 0;
      f.slots.forEach(function (s) {
        var b = slotHolder(f.id, d, s.id), st = b ? b.status : "free";
        if (b) taken++;
        if (!b && S.sel.fac === f.id && S.sel.slots.indexOf(s.id) > -1) st = "sel";
        var sub = b ? (mine(b) ? "yours" : "taken") : (st === "sel" ? "selected" : s.label);
        rail += '<button class="chip" type="button" data-s="' + st + '" data-f="' + f.id + '" data-slot="' + s.id + '"' +
          (b ? ' disabled aria-disabled="true"' : "") + ' title="' + (b ? LABEL[b.status] : "Available") + '">' +
          '<span class="t">' + s.t + '</span><span class="l">' + sub + "</span></button>";
      });
      var full = taken === f.slots.length;
      h += '<div class="card' + (full ? " full" : "") + '"><div class="fhead"><h3>' + esc(f.name) +
        (full ? '<span class="fullflag">Fully booked</span>' : "") + '</h3><span class="frate num">' + money(f.rate) + "</span></div>" +
        '<div class="fmeta">' + f.cap + " &middot; " + f.unit + '</div><div class="rail">' + rail + "</div></div>";
    });
    h += '</div><div class="legend">' +
      '<span><i style="background:var(--surface-2);border:1px solid var(--line)"></i>Free</span>' +
      '<span><i style="background:var(--info-soft)"></i>Requested</span>' +
      '<span><i style="background:var(--warn-soft)"></i>Payment pending</span>' +
      '<span><i style="background:var(--ok-soft)"></i>Confirmed</span></div>';

    if (S.sel.fac && S.sel.slots.length) h += tray();
    viewEl.innerHTML = h;

    document.getElementById("dt").onchange = function (e) { S.date = e.target.value; S.sel = { fac: null, slots: [] }; render(); };
    document.getElementById("prev").onclick = function () { S.date = addDays(S.date, -1); S.sel = { fac: null, slots: [] }; render(); };
    document.getElementById("next").onclick = function () { S.date = addDays(S.date, 1); S.sel = { fac: null, slots: [] }; render(); };
    document.getElementById("today").onclick = function () { S.date = iso(new Date()); S.sel = { fac: null, slots: [] }; render(); };
    Array.prototype.forEach.call(viewEl.querySelectorAll(".chip:not([disabled])"), function (c) {
      c.onclick = function () {
        if (S.sel.fac !== c.dataset.f) S.sel = { fac: c.dataset.f, slots: [] };
        var i = S.sel.slots.indexOf(c.dataset.slot);
        if (i > -1) S.sel.slots.splice(i, 1); else S.sel.slots.push(c.dataset.slot);
        if (!S.sel.slots.length) S.sel.fac = null;
        render();
      };
    });
    wireTray();
  }
  function tray() {
    var f = FMAP[S.sel.fac], n = S.sel.slots.length, amt = f.rate * n;
    var times = f.slots.filter(function (s) { return S.sel.slots.indexOf(s.id) > -1; }).map(function (s) { return s.t; }).join(", ");
    return '<div class="tray"><h4>' + esc(f.name) + " &middot; " + prettyDate(S.date) + ' &middot; <span class="num">' + times + "</span></h4>" +
      '<div class="formrow">' +
      '<div class="f"><label for="bk-purpose">Purpose</label><input type="text" id="bk-purpose" placeholder="Birthday lunch"></div>' +
      '<div class="f"><label for="bk-guests">Expected guests</label><input type="number" id="bk-guests" min="1" value="10"></div></div>' +
      '<div class="actions"><button class="btn primary" id="bk-go" type="button">Request this slot</button>' +
      '<button class="btn ghost" id="bk-clear" type="button">Clear</button>' +
      '<span class="hint">' + n + " slot" + (n > 1 ? "s" : "") + ' &middot; <strong class="num">' + money(amt) +
      "</strong> payable within " + WINDOW_H + "h of approval</span></div></div>";
  }
  function wireTray() {
    var go = document.getElementById("bk-go"); if (!go) return;
    document.getElementById("bk-clear").onclick = function () { S.sel = { fac: null, slots: [] }; render(); };
    go.onclick = function () {
      if (S.busy) return;
      var f = FMAP[S.sel.fac];
      var booking = {
        facility: f.id, slots: S.sel.slots.slice(), date: S.date,
        resident: S.me.name, unit: S.me.unit,
        purpose: (document.getElementById("bk-purpose").value || "").trim() || "Private booking",
        guests: parseInt(document.getElementById("bk-guests").value, 10) || 1,
        amount: f.rate * S.sel.slots.length,
        status: "requested", approved_at: null, approved_by: null,
        verified_at: null, verified_by: null, proof: null, note: ""
      };
      S.busy = true; go.disabled = true; go.textContent = "Sending…";
      Data.create(booking)
        .then(function () {
          S.sel = { fac: null, slots: [] }; S.tab = "mine";
          toast("Request sent — the clubhouse desk reviews it next.");
          return refresh();
        })
        .catch(function (e) { toast(e.message); return refresh(); })
        .then(function () { S.busy = false; });
    };
  }

  /* ───────────── lists ───────────── */
  function renderList(pipeHTML, filter, emptyTitle, emptyBody) {
    var rank = { requested: 0, approved: 1, paid_pending: 2, confirmed: 3, cancelled_nopay: 4, cancelled: 5, rejected: 6 };
    var list = S.bookings.filter(filter).sort(function (a, b) {
      return (rank[a.status] - rank[b.status]) || (a.date < b.date ? -1 : 1);
    });
    if (!list.length) {
      viewEl.innerHTML = pipeHTML + '<div class="empty"><strong>' + emptyTitle + "</strong>" + emptyBody + "</div>";
      return;
    }
    viewEl.innerHTML = pipeHTML + '<div class="rows">' + list.map(rowHTML).join("") + "</div>";
    wireRows();
    hydrateProofs();
  }
  function rowHTML(b) {
    if (!b.id) return "";
    var f = FMAP[b.facility] || { name: b.facility, slots: [] }, now = Date.now();
    var h = '<div class="row" data-s="' + b.status + '" data-id="' + esc(b.id) + '"><div class="rmain">' +
      '<div class="rid">' + esc(b.id) + "</div>" +
      '<div class="rtitle">' + esc(f.name) + " &middot; " + prettyDate(b.date) + "</div>" +
      '<div class="rsub num">' + slotTimes(b) + " &middot; " + esc(b.purpose) + " &middot; " + esc(b.guests) + " guests</div>";

    if (isResident()) {
      var line = b.note || (b.status === "approved"
        ? "Pay " + money(b.amount) + " to " + esc(CFG.PAYMENT_UPI || "the clubhouse account") + " and upload the receipt before " + stamp(deadline(b))
        : "");
      if (line) h += '<div class="rsub">' + line + "</div>";
    } else {
      h += '<div class="rsub">' + esc(b.resident) + " (" + esc(b.unit) + ")" + (b.note ? " &middot; " + esc(b.note) : "") + "</div>";
    }

    if (b.proof) {
      h += '<div class="proof" data-proof="' + esc(b.id) + '"><div class="pn">Proof: ' + esc(b.proof.name) +
        "<br>uploaded " + stamp(b.proof.at) + "</div>";
      if (b.status === "paid_pending" && !isResident()) {
        h += '<div class="actions"><button class="btn sm primary" data-act="verify">Confirm booking</button>' +
          '<button class="btn sm danger" data-act="reject-pay">Proof not valid</button></div>';
      }
      h += "</div>";
    }
    if (b.status === "approved" && isResident() && mine(b)) {
      h += '<div class="proof"><label class="btn sm primary" for="up-' + esc(b.id) + '">Upload payment picture</label>' +
        '<input type="file" id="up-' + esc(b.id) + '" accept="image/*" hidden data-act="upload">' +
        '<span class="pn">A photo or screenshot of the UPI / NEFT receipt. ' + esc(CFG.PAYMENT_NOTE || "") + "</span></div>";
    }

    h += '</div><div class="rside"><span class="badge" data-s="' + b.status + '">' + LABEL[b.status] + "</span>" +
      '<span class="amt">' + money(b.amount) + "</span>";
    if (b.status === "approved") {
      var left = deadline(b) - now;
      h += '<span class="clock' + (left < 12 * HOUR ? " hot" : "") + '">' + countdown(left) + "</span>";
    }
    if (b.status === "requested" && !isResident()) {
      h += '<div class="actions"><button class="btn sm primary" data-act="approve">Approve</button>' +
        '<button class="btn sm danger" data-act="reject">Reject</button></div>';
    }
    if (isResident() && mine(b) && LIVE[b.status]) {
      h += '<button class="btn sm ghost" data-act="cancel">Cancel</button>';
    }
    return h + "</div></div>";
  }
  function wireRows() {
    Array.prototype.forEach.call(viewEl.querySelectorAll("[data-act]"), function (el) {
      var id = el.closest(".row").dataset.id, act = el.dataset.act;
      var b = S.bookings.filter(function (x) { return x.id === id; })[0];
      if (!b) return;

      if (act === "upload") {
        el.onchange = function (e) {
          var file = e.target.files[0]; if (!file) return;
          toast("Uploading…");
          Data.uploadProof(b, file)
            .then(function () { toast("Proof uploaded — the desk verifies it next."); return refresh(); })
            .catch(function (err) { toast(err.message); });
        };
        return;
      }
      el.onclick = function () {
        var msg = {
          approve: b.id + " approved — payment due within " + WINDOW_H + " hours",
          reject: b.id + " rejected.",
          verify: b.id + " confirmed.",
          "reject-pay": "Proof returned to the resident.",
          cancel: b.id + " cancelled."
        }[act];
        if (!msg) return;
        el.disabled = true;
        Data.act(b.id, act).then(function () { toast(msg); return refresh(); })
          .catch(function (e) { toast(e.message); el.disabled = false; });
      };
    });
  }
  function hydrateProofs() {
    Array.prototype.forEach.call(viewEl.querySelectorAll("[data-proof]"), function (box) {
      var b = S.bookings.filter(function (x) { return x.id === box.dataset.proof; })[0];
      if (!b || !b.proof) return;
      Data.proofUrl(b).then(function (url) {
        if (!url || box.querySelector("img")) return;
        var img = new Image();
        img.src = url; img.alt = "Payment proof for " + b.id;
        box.insertBefore(img, box.firstChild);
      });
    });
  }

  /* ───────────── committee: day view ───────────── */
  function renderDay() {
    var d = S.date;
    var h = committeePipe() + '<div class="bar">' +
      '<div class="f"><label for="dt">Date</label><input type="date" id="dt" value="' + d + '"></div>' +
      '<button class="btn sm" id="prev" type="button">&larr; Prev</button>' +
      '<button class="btn sm" id="today" type="button">Today</button>' +
      '<button class="btn sm" id="next" type="button">Next &rarr;</button>' +
      '<p class="hint">Occupancy for ' + prettyDate(d) + ". Hover a booked slot for the flat holding it.</p></div>";
    h += '<div class="facgrid">';
    FACILITIES.forEach(function (f) {
      var rail = "", taken = 0;
      f.slots.forEach(function (s) {
        var b = slotHolder(f.id, d, s.id), st = b ? b.status : "free";
        if (b) taken++;
        rail += '<button class="chip" type="button" data-s="' + st + '" disabled aria-disabled="true" title="' +
          (b ? esc(b.unit) + " · " + esc(b.resident) + " · " + LABEL[b.status] : "Available") + '">' +
          '<span class="t">' + s.t + '</span><span class="l">' + (b ? esc(b.unit) : "free") + "</span></button>";
      });
      var full = taken === f.slots.length;
      h += '<div class="card' + (full ? " full" : "") + '"><div class="fhead"><h3>' + esc(f.name) +
        (full ? '<span class="fullflag">Fully booked</span>' : "") + '</h3><span class="frate num">' +
        taken + "/" + f.slots.length + ' booked</span></div><div class="fmeta">' + f.cap + " &middot; " +
        money(f.rate) + " " + f.unit + '</div><div class="rail">' + rail + "</div></div>";
    });
    viewEl.innerHTML = h + "</div>";
    document.getElementById("dt").onchange = function (e) { S.date = e.target.value; render(); };
    document.getElementById("prev").onclick = function () { S.date = addDays(S.date, -1); render(); };
    document.getElementById("next").onclick = function () { S.date = addDays(S.date, 1); render(); };
    document.getElementById("today").onclick = function () { S.date = iso(new Date()); render(); };
  }

  /* ───────────── resident: rules ───────────── */
  function step(n, t, d) { return '<div class="step"><div class="sn">' + n + '</div><div class="st">' + t + '</div><div class="sd">' + d + "</div></div>"; }
  function renderRules() {
    var h = '<div class="doc"><section class="card"><h2>How a booking works</h2>' +
      '<p style="margin:6px 0 12px">Four steps. Only the last one happens on its own.</p><div class="flow">' +
      step("Step 1", "You request a slot", "Pick the space, date and timing. The slot is held so nobody else can take it while the desk looks at it.") +
      step("Step 2", "The committee approves", "You get the amount and the deadline. A " + WINDOW_H + "-hour payment clock starts.") +
      step("Step 3", "You upload the payment picture", "A photo of the UPI or NEFT receipt, from My bookings.") +
      step("Step 4", "Confirmed", "The desk checks the receipt against the bank and your slot is locked in.") +
      '</div><div class="note" style="margin-top:12px">If no payment picture arrives within ' + WINDOW_H +
      " hours of approval, the booking cancels itself and the slot goes back on the calendar.</div></section>";

    h += '<section class="card"><h2>Spaces and charges</h2><div class="scroller"><table><thead><tr>' +
      "<th>Space</th><th>Capacity</th><th>Slot</th><th>Charge</th></tr></thead><tbody>" +
      FACILITIES.map(function (f) {
        return "<tr><td><strong>" + esc(f.name) + "</strong></td><td>" + f.cap + "</td><td>" +
          f.slots[0].label + '</td><td class="num">' + money(f.rate) + " " + f.unit + "</td></tr>";
      }).join("") + "</tbody></table></div></section>";

    h += '<section class="card"><h2>Fair use</h2><ul>' +
      "<li>Banquet Hall and Terrace: <strong>one booking per flat per month</strong>, opens 60 days ahead.</li>" +
      "<li>Meeting rooms: <strong>three hours per flat per day</strong>, opens 14 days ahead.</li>" +
      "<li>The Den, Home Theatre, Golf Room: <strong>one slot per flat per week</strong>, opens 14 days ahead.</li>" +
      "<li>Two auto-cancellations in 90 days and your flat moves to manual approval only.</li>" +
      "<li>Cancel at least 72 hours ahead for a full refund; later than that, half.</li>" +
      "</ul></section>";

    h += '<section class="card"><h2>Paying</h2><ul>' +
      "<li>UPI: <code>" + esc(CFG.PAYMENT_UPI || "—") + "</code></li>" +
      "<li>" + esc(CFG.PAYMENT_NOTE || "") + "</li>" +
      "<li>Upload the screenshot from My bookings. The desk matches it against the bank statement.</li>" +
      "<li>Forgot your PIN? The clubhouse desk resets it at the office.</li>" +
      "</ul></section></div>";
    viewEl.innerHTML = h;
  }

  /* ───────────── render ───────────── */
  function render() {
    if (!S.me) return;
    renderTabs();
    var t = S.tab;
    if (t === "book") renderBook();
    else if (t === "mine") renderList(residentPipe(), function (b) { return mine(b); },
      "Nothing booked yet", "Open Book a space, pick a free slot and send a request.");
    else if (t === "pending") renderPending();
    else if (t === "approvals") renderList(committeePipe(),
      function (b) { return b.status === "requested" || b.status === "approved"; },
      "Nothing waiting", "New requests land here the moment a resident sends one.");
    else if (t === "payments") renderList(committeePipe(),
      function (b) { return b.status === "paid_pending" || b.status === "approved" || b.status === "cancelled_nopay"; },
      "No payments outstanding", "Approved bookings appear here with their clock running.");
    else if (t === "register") renderList(committeePipe(), function () { return true; },
      "The register is empty", "Every booking, in every state, is listed here.");
    else if (t === "day") renderDay();
    else if (t === "rules") renderRules();
  }

  function toast(msg) {
    var old = document.querySelector(".toast"); if (old) old.remove();
    var el = document.createElement("div");
    el.className = "toast"; el.textContent = msg; el.setAttribute("role", "status");
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 3600);
  }
  window.tritonToast = toast;

  /* Keep clocks honest and pull fresh data while the app is open. */
  setInterval(function () {
    if (!S.me) return;
    if (S.tab === "rules") return;
    if (document.visibilityState === "hidden") return;
    refresh();
  }, 60000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && S.me) refresh();
  });

  /* ───────────── boot ───────────── */
  wireLogin();
  Data.init().then(function () {
    return Data.session();
  }).then(function (me) {
    if (me) { S.me = me; start(); } else { showLogin(); }
  }).catch(function () { showLogin(); });
})();
