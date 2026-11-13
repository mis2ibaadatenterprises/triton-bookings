/* Triton — data layer.
   Two interchangeable backends behind one API:
     • demo     — everything in this browser's localStorage. No server needed.
     • supabase — shared Postgres + Auth + Storage, so every phone sees the same data.
   The app code never touches either directly; it only calls Data.*  */
(function (global) {
  "use strict";

  var CFG = global.TRITON_CONFIG || {};
  var LIVE = { requested: 1, approved: 1, paid_pending: 1, confirmed: 1 };

  var Data = {
    mode: CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY ? "supabase" : "demo",
    ready: false,
    client: null,
    _session: null,
    LIVE: LIVE
  };

  /* ───────────── demo backend ───────────── */
  var DEMO_KEY = "triton.demo.v1";
  var DEMO_SESSION = "triton.demo.session";
  var DEMO_USERS = {
    "B-1204": { pin: "1204", name: "Kanika Mehra", role: "resident", unit: "B-1204" },
    "A-0703": { pin: "0703", name: "Rohit Nair", role: "resident", unit: "A-0703" },
    "C-0905": { pin: "0905", name: "Sana Qureshi", role: "resident", unit: "C-0905" }
  };
  var DEMO_STAFF = {
    "desk.manager": { pin: "triton", name: "Clubhouse Manager", role: "committee" },
    "secretary": { pin: "triton", name: "Hon. Secretary", role: "committee" }
  };

  function readDemo() {
    try {
      var raw = localStorage.getItem(DEMO_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.bookings) && parsed.bookings.length) return parsed;
      }
    } catch (e) {}
    var fresh = { bookings: seedBookings(), seq: 8 };
    writeDemo(fresh);
    return fresh;
  }
  function writeDemo(d) {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(d)); } catch (e) {}
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function shift(iso, n) {
    var d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function seedBookings() {
    var H = 36e5, D = 24 * H, now = Date.now(), t = todayISO(), n = 0;
    function row(o) {
      n += 1;
      return Object.assign({
        id: "BKG-" + String(n).padStart(4, "0"),
        created_at: now - 6 * D, approved_at: null, approved_by: null,
        verified_at: null, verified_by: null, proof: null, note: ""
      }, o);
    }
    return [
      row({ facility: "banquet", slots: ["H2"], date: shift(t, 9), resident: "Kanika Mehra", unit: "B-1204",
            purpose: "Anniversary dinner", guests: 120, amount: 15000, status: "approved",
            approved_at: now - 41 * H, approved_by: "desk.manager" }),
      row({ facility: "theatre", slots: ["S16"], date: shift(t, 2), resident: "Rohit Nair", unit: "A-0703",
            purpose: "Movie night", guests: 9, amount: 2500, status: "approved",
            approved_at: now - 46.4 * H, approved_by: "desk.manager" }),
      row({ facility: "terrace", slots: ["H1"], date: shift(t, 4), resident: "Sana Qureshi", unit: "C-0905",
            purpose: "Baby shower brunch", guests: 60, amount: 9000, status: "paid_pending",
            approved_at: now - 20 * H, approved_by: "secretary",
            proof: { name: "upi-ref-884102.jpg", at: now - 3 * H, url: null } }),
      row({ facility: "mr2", slots: ["H10", "H11"], date: t, resident: "Devika Rao", unit: "D-1501",
            purpose: "Society AGM prep", guests: 10, amount: 1000, status: "confirmed",
            approved_at: now - 5 * D, approved_by: "secretary", verified_at: now - 4 * D, verified_by: "secretary",
            proof: { name: "neft-receipt.jpg", at: now - 4.6 * D, url: null } }),
      row({ facility: "golf", slots: ["S18"], date: shift(t, 1), resident: "Arjun Shetty", unit: "B-0402",
            purpose: "Practice session", guests: 2, amount: 1500, status: "requested" }),
      row({ facility: "den", slots: ["S15"], date: shift(t, 3), resident: "Meera Iyer", unit: "A-1108",
            purpose: "Book club", guests: 12, amount: 1200, status: "requested" }),
      row({ facility: "mr1", slots: ["H14"], date: t, resident: "Kanika Mehra", unit: "B-1204",
            purpose: "Client call", guests: 4, amount: 400, status: "confirmed",
            approved_at: now - 3 * D, approved_by: "desk.manager", verified_at: now - 2.8 * D,
            verified_by: "desk.manager", proof: { name: "upi-ref-771930.jpg", at: now - 2.9 * D, url: null } })
    ];
  }

  /* ───────────── supabase backend ───────────── */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = function () { rej(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }
  function emailFor(flat) {
    return String(flat).trim().toLowerCase().replace(/\s+/g, "") + "@" + (CFG.AUTH_EMAIL_DOMAIN || "triton.invalid");
  }

  Data.init = function () {
    if (Data.mode === "demo") { Data.ready = true; return Promise.resolve(); }
    return loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js")
      .then(function () {
        Data.client = global.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
        Data.ready = true;
      })
      .catch(function (e) {
        Data.mode = "demo"; Data.ready = true; Data.initError = e.message;
      });
  };

  /* ───────────── session ───────────── */
  Data.session = function () {
    if (Data._session) return Promise.resolve(Data._session);
    if (Data.mode === "demo") {
      try {
        var raw = localStorage.getItem(DEMO_SESSION);
        if (raw) Data._session = JSON.parse(raw);
      } catch (e) {}
      return Promise.resolve(Data._session);
    }
    return Data.client.auth.getSession().then(function (r) {
      var s = r.data && r.data.session;
      if (!s) return null;
      return Data.client.from("members").select("*").eq("auth_id", s.user.id).single().then(function (m) {
        if (m.error || !m.data) return null;
        Data._session = { role: m.data.role, name: m.data.name, unit: m.data.unit, login: m.data.login };
        return Data._session;
      });
    });
  };

  Data.signIn = function (kind, id, pin) {
    if (Data.mode === "demo") {
      var table = kind === "committee" ? DEMO_STAFF : DEMO_USERS;
      var key = kind === "committee" ? String(id).trim().toLowerCase() : String(id).trim().toUpperCase();
      var u = table[key];
      if (!u || u.pin !== String(pin).trim()) {
        return Promise.reject(new Error(kind === "committee"
          ? "That committee ID and password do not match."
          : "That flat number and PIN do not match."));
      }
      Data._session = { role: u.role, name: u.name, unit: u.unit || null, login: key };
      try { localStorage.setItem(DEMO_SESSION, JSON.stringify(Data._session)); } catch (e) {}
      return Promise.resolve(Data._session);
    }

    var email = kind === "committee"
      ? String(id).trim().toLowerCase() + "@" + (CFG.AUTH_EMAIL_DOMAIN || "triton.invalid")
      : emailFor(id);

    return Data.client.auth.signInWithPassword({ email: email, password: String(pin) })
      .then(function (r) {
        if (r.error) throw new Error(kind === "committee"
          ? "That committee ID and password do not match."
          : "That flat number and PIN do not match.");
        return Data.client.from("members").select("*").eq("auth_id", r.data.user.id).single();
      })
      .then(function (m) {
        if (m.error || !m.data) throw new Error("This login has no member record. Ask the clubhouse desk to finish setting it up.");
        if (kind === "committee" && m.data.role !== "committee") throw new Error("This login is a resident account. Use the Resident tab.");
        if (kind !== "committee" && m.data.role !== "resident") throw new Error("This is a committee login. Use the Committee tab.");
        Data._session = { role: m.data.role, name: m.data.name, unit: m.data.unit, login: m.data.login };
        return Data._session;
      });
  };

  Data.signOut = function () {
    Data._session = null;
    if (Data.mode === "demo") {
      try { localStorage.removeItem(DEMO_SESSION); } catch (e) {}
      return Promise.resolve();
    }
    return Data.client.auth.signOut();
  };

  /* ───────────── bookings ───────────── */
  Data.list = function () {
    if (Data.mode === "demo") {
      var d = readDemo();
      return Promise.resolve(d.bookings.slice());
    }
    return Data.client.from("bookings").select("*").order("date", { ascending: true })
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data.map(function (b) {
          b.approved_at = b.approved_at ? Date.parse(b.approved_at) : null;
          b.verified_at = b.verified_at ? Date.parse(b.verified_at) : null;
          b.created_at = b.created_at ? Date.parse(b.created_at) : null;
          return b;
        });
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
    return Data.client.from("bookings").insert([booking]).select().single().then(function (r) {
      if (r.error) {
        if (/duplicate|unique/i.test(r.error.message)) throw new Error("Somebody took that slot a moment ago. Pick another.");
        throw new Error(r.error.message);
      }
      return r.data;
    });
  };

  Data.update = function (id, patch) {
    if (Data.mode === "demo") {
      var d = readDemo(), hit = null;
      d.bookings.forEach(function (b) { if (b.id === id) { Object.assign(b, patch); hit = b; } });
      writeDemo(d);
      return Promise.resolve(hit);
    }
    var out = Object.assign({}, patch);
    ["approved_at", "verified_at"].forEach(function (k) {
      if (typeof out[k] === "number") out[k] = new Date(out[k]).toISOString();
    });
    return Data.client.from("bookings").update(out).eq("id", id).select().single().then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return r.data;
    });
  };

  /* Payment proof. Demo keeps a shrunken data URL; Supabase puts the file in
     the private "proofs" bucket and stores its path. */
  Data.uploadProof = function (booking, file) {
    return shrinkImage(file).then(function (small) {
      if (Data.mode === "demo") {
        return Data.update(booking.id, {
          status: "paid_pending", note: "",
          proof: { name: file.name, at: Date.now(), url: small }
        });
      }
      var path = booking.unit + "/" + booking.id + "-" + Date.now() + ".jpg";
      return Data.client.storage.from("proofs").upload(path, file, { contentType: file.type || "image/jpeg" })
        .then(function (r) {
          if (r.error) throw new Error("Upload failed: " + r.error.message);
          return Data.update(booking.id, {
            status: "paid_pending", note: "",
            proof: { name: file.name, at: Date.now(), path: path }
          });
        });
    });
  };

  Data.proofUrl = function (proof) {
    if (!proof) return Promise.resolve(null);
    if (proof.url) return Promise.resolve(proof.url);
    if (Data.mode !== "supabase" || !proof.path) return Promise.resolve(null);
    return Data.client.storage.from("proofs").createSignedUrl(proof.path, 600)
      .then(function (r) { return r.data ? r.data.signedUrl : null; })
      .catch(function () { return null; });
  };

  function shrinkImage(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          try {
            var s = Math.min(1, 220 / Math.max(img.width, img.height));
            var c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(img.width * s));
            c.height = Math.max(1, Math.round(img.height * s));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL("image/jpeg", 0.7));
          } catch (e) { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = reader.result;
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  global.Data = Data;
})(window);
