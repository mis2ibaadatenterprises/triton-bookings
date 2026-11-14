/* Triton — data layer.
   One API for the app, two backends behind it:
     • sheets — the Google Sheet, through its Apps Script web app. Shared by every
       phone: residents see which slots are taken, the committee sees everything.
     • demo   — this browser only. Used when no API URL is configured, so the app
       still opens and can be shown to somebody.
   The app code never talks to either directly; it only calls Data.*  */
(function (global) {
  "use strict";

  var CFG = global.TRITON_CONFIG || {};
  var API = (CFG.SHEETS_API_URL || "").trim();

  var Data = {
    mode: API ? "sheets" : "demo",
    ready: false,
    spaces: null,
    notices: [],
    issues: [],
    _session: null,
    _token: null
  };

  var TOKEN_KEY = "triton.token";
  var DEMO_KEY = "triton.demo.v2";
  var DEMO_SESSION = "triton.demo.session";

  function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  /* ───────────── talking to the sheet ─────────────
     Apps Script web apps answer a cross-origin POST only as a "simple" request,
     so the body goes as text/plain and the script parses it itself. */
  function call(action, payload) {
    var body = Object.assign({ action: action, token: Data._token || "" }, payload || {});
    return fetch(API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow"
    }).then(function (r) {
      if (!r.ok) throw new Error("The booking server did not answer (" + r.status + "). Try again in a moment.");
      return r.text();
    }).then(function (t) {
      var j;
      try { j = JSON.parse(t); }
      catch (e) { throw new Error("The booking server sent something unexpected. Check that the Apps Script is deployed for 'Anyone'."); }
      if (!j.ok) throw new Error(j.error || "Something went wrong.");
      return j.data;
    }, function (e) {
      if (e instanceof TypeError) throw new Error("No connection to the booking server. Check the internet and try again.");
      throw e;
    });
  }

  Data.init = function () {
    Data.ready = true;
    Data._token = read(TOKEN_KEY);
    return Promise.resolve();
  };

  /* ───────────── session ───────────── */
  Data.session = function () {
    if (Data.mode === "demo") {
      if (!Data._session) {
        try { var raw = read(DEMO_SESSION); if (raw) Data._session = JSON.parse(raw); } catch (e) {}
      }
      return Promise.resolve(Data._session);
    }
    if (!Data._token) return Promise.resolve(null);
    /* The list call also validates the token and returns who we are. */
    return call("list", {}).then(function (d) {
      Data._session = d.me;
      Data.spaces = d.spaces;
      Data._cache = d.bookings;
      return d.me;
    }).catch(function () {
      Data._token = null; store(TOKEN_KEY, null);
      return null;
    });
  };

  Data.signIn = function (kind, id, pin) {
    if (Data.mode === "demo") return demoSignIn(kind, id, pin);
    return call("signIn", { kind: kind, id: id, pin: pin }).then(function (d) {
      Data._token = d.token;
      store(TOKEN_KEY, d.token);
      Data._session = d.me;
      Data.spaces = d.spaces;
      return d.me;
    });
  };

  Data.signOut = function () {
    Data._session = null;
    Data._cache = null;
    if (Data.mode === "demo") { store(DEMO_SESSION, null); return Promise.resolve(); }
    var p = Data._token ? call("signOut", {}).catch(function () {}) : Promise.resolve();
    Data._token = null; store(TOKEN_KEY, null);
    return p;
  };

  /* ───────────── bookings ───────────── */
  Data.list = function () {
    if (Data.mode === "demo") return Promise.resolve(readDemo().bookings.slice());
    if (Data._cache) { var c = Data._cache; Data._cache = null; return Promise.resolve(c); }
    return call("list", {}).then(function (d) {
      Data._session = d.me;
      Data.spaces = d.spaces;
      Data.notices = d.notices || [];
      Data.issues = d.issues || [];
      return d.bookings;
    });
  };

  Data.create = function (booking) {
    if (Data.mode === "demo") {
      var d = readDemo();
      booking.id = "BKG-" + String(d.seq++).padStart(4, "0");
      booking.created_at = Date.now();
      d.bookings.unshift(booking);
      writeDemo(d);
      return Promise.resolve(booking);
    }
    return call("create", { booking: booking });
  };

  /* The sheet decides what each action is allowed to change, so the app sends
     the intent ("approve") rather than a set of columns. */
  Data.act = function (id, act) {
    if (Data.mode === "demo") {
      var patch = {
        approve: { status: "approved", approved_at: Date.now(), note: "" },
        reject: { status: "rejected", note: "Not approved by the committee." },
        verify: { status: "confirmed", verified_at: Date.now(), note: "" },
        "reject-pay": { status: "approved", proof: null, note: "Proof returned — upload a clearer receipt before the clock runs out." },
        cancel: { status: "cancelled", note: "Cancelled by the resident." }
      }[act];
      if (!patch) return Promise.reject(new Error("Unknown action."));
      var d = readDemo();
      d.bookings.forEach(function (b) { if (b.id === id) Object.assign(b, patch); });
      writeDemo(d);
      return Promise.resolve();
    }
    return call("update", { id: id, act: act });
  };

  Data.uploadProof = function (booking, file) {
    return shrinkImage(file, 1400).then(function (dataUrl) {
      if (!dataUrl) throw new Error("Could not read that picture. Try a JPG or PNG.");
      if (Data.mode === "demo") {
        var d = readDemo();
        d.bookings.forEach(function (b) {
          if (b.id === booking.id) {
            b.status = "paid_pending"; b.note = "";
            b.proof = { name: file.name, at: Date.now(), dataUrl: dataUrl };
          }
        });
        writeDemo(d);
        return;
      }
      return call("proof", { id: booking.id, name: file.name, dataUrl: dataUrl });
    });
  };

  /* Proof pictures live in a Drive folder the script owns; it hands them back
     only against a valid token, so they are fetched one at a time on demand. */
  var proofCache = {};
  Data.proofUrl = function (booking) {
    if (!booking || !booking.proof) return Promise.resolve(null);
    if (booking.proof.dataUrl) return Promise.resolve(booking.proof.dataUrl);
    if (Data.mode === "demo") return Promise.resolve(null);
    if (proofCache[booking.id]) return Promise.resolve(proofCache[booking.id]);
    return call("proofImage", { id: booking.id }).then(function (d) {
      proofCache[booking.id] = d.dataUrl;
      return d.dataUrl;
    }).catch(function () { return null; });
  };

  /* ───────────── notice board ───────────── */
  Data.addNotice = function (title, body, pinned) {
    if (Data.mode === "demo") return Promise.reject(new Error("Not connected to the booking sheet."));
    return call("addNotice", { title: title, body: body, pinned: !!pinned });
  };
  Data.editNotice = function (id, patch) {
    if (Data.mode === "demo") return Promise.reject(new Error("Not connected to the booking sheet."));
    return call("editNotice", Object.assign({ id: id }, patch));
  };

  /* ───────────── issues ───────────── */
  Data.raiseIssue = function (category, detail, file) {
    if (Data.mode === "demo") return Promise.reject(new Error("Not connected to the booking sheet."));
    var send = function (dataUrl) {
      return call("raiseIssue", {
        category: category, detail: detail,
        dataUrl: dataUrl || "", name: file ? file.name : ""
      });
    };
    if (!file) return send(null);
    return shrinkImage(file, 1400).then(function (dataUrl) {
      if (!dataUrl) throw new Error("Could not read that photo. Try a JPG or PNG.");
      return send(dataUrl);
    });
  };
  Data.issueUpdate = function (id, status, reply) {
    return call("issueUpdate", { id: id, status: status, reply: reply });
  };

  var issuePhotoCache = {};
  Data.issuePhoto = function (issue) {
    if (!issue || !issue.photo) return Promise.resolve(null);
    if (issuePhotoCache[issue.id]) return Promise.resolve(issuePhotoCache[issue.id]);
    return call("issuePhoto", { id: issue.id }).then(function (d) {
      issuePhotoCache[issue.id] = d.dataUrl;
      return d.dataUrl;
    }).catch(function () { return null; });
  };

  function shrinkImage(file, max) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          try {
            var s = Math.min(1, max / Math.max(img.width, img.height));
            var c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(img.width * s));
            c.height = Math.max(1, Math.round(img.height * s));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL("image/jpeg", 0.78));
          } catch (e) { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = reader.result;
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  /* ───────────── demo backend ───────────── */
  var DEMO_USERS = { "B-1204": { pin: "1204", name: "Kanika Mehra", role: "resident", unit: "B-1204" } };
  var DEMO_STAFF = { "desk.manager": { pin: "triton", name: "Clubhouse Manager", role: "committee" } };

  function demoSignIn(kind, id, pin) {
    var table = kind === "committee" ? DEMO_STAFF : DEMO_USERS;
    var key = kind === "committee" ? String(id).trim().toLowerCase() : String(id).trim().toUpperCase();
    var u = table[key];
    if (!u || u.pin !== String(pin).trim()) {
      return Promise.reject(new Error(kind === "committee"
        ? "That committee ID and password do not match."
        : "That flat number and PIN do not match."));
    }
    Data._session = { role: u.role, name: u.name, unit: u.unit || null, login: key };
    store(DEMO_SESSION, JSON.stringify(Data._session));
    return Promise.resolve(Data._session);
  }
  function readDemo() {
    try {
      var raw = read(DEMO_KEY);
      if (raw) { var p = JSON.parse(raw); if (p && Array.isArray(p.bookings)) return p; }
    } catch (e) {}
    var fresh = { bookings: [], seq: 1 };
    writeDemo(fresh);
    return fresh;
  }
  function writeDemo(d) { store(DEMO_KEY, JSON.stringify(d)); }

  global.Data = Data;
})(window);
