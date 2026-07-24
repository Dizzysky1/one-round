/**
 * ONE ROUND online leaderboard via Firebase Realtime Database.
 * Falls back to local Store when Firebase is unavailable.
 * Online Leaderboard system © 2026 Aidiotic — LICENSE-ONLINE-LEADERBOARD
 */
(function (global) {
  "use strict";

  var BOARD_MAX = 30;
  var COL = "leaderboard";
  var ready = null;
  var db = null;
  var online = false;
  var lastError = null;

  function sanitizeCallsign(n) {
    return String(n || "RECRUIT")
      .toUpperCase()
      .replace(/[^A-Z0-9 _-]/g, "")
      .trim()
      .slice(0, 12) || "RECRUIT";
  }

  function callsignKey(n) {
    return sanitizeCallsign(n).replace(/ /g, "_");
  }

  function asInt(v, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback || 0;
    return Math.max(0, Math.floor(n));
  }

  function normalizeEntry(e) {
    if (!e || typeof e !== "object") return null;
    var ts = asInt(e.t, 0);
    if (!ts) ts = Date.now();
    return {
      n: sanitizeCallsign(e.n),
      s: asInt(e.s, 0),
      l: asInt(e.l, 0),
      k: asInt(e.k, 0),
      b: asInt(e.b, 0),
      w: String(e.w || "ranger").slice(0, 32),
      // Do NOT use bitwise |0 on timestamps — overflows 32-bit and goes negative
      t: ts
    };
  }

  function listFromSnapshot(snap) {
    var list = [];
    if (!snap || typeof snap.exists !== "function" || !snap.exists()) return list;
    snap.forEach(function (child) {
      var e = normalizeEntry(child.val());
      if (e) list.push(e);
    });
    list.sort(function (a, b) {
      return b.s - a.s;
    });
    if (list.length > BOARD_MAX) list.length = BOARD_MAX;
    return list;
  }

  function init(config) {
    // Allow retry after a failed init (e.g. transient network / bad probe)
    if (ready && online) return ready;
    ready = new Promise(function (resolve) {
      try {
        if (!global.firebase || !config) {
          lastError = "firebase SDK or config missing";
          online = false;
          resolve(false);
          return;
        }
        if (!firebase.apps.length) firebase.initializeApp(config);
        db = firebase.database();
        // Prove we can read the board (must include orderBy if using limit*)
        db.ref(COL)
          .orderByChild("s")
          .limitToLast(1)
          .once("value")
          .then(function () {
            online = true;
            lastError = null;
            resolve(true);
          })
          .catch(function (err) {
            lastError = String(err && err.message ? err.message : err);
            console.warn("[OneRoundBoard] init failed", err);
            online = false;
            resolve(false);
          });
      } catch (err) {
        lastError = String(err && err.message ? err.message : err);
        console.warn("[OneRoundBoard] init failed", err);
        online = false;
        resolve(false);
      }
    });
    return ready;
  }

  function loadFromFirebase() {
    return db
      .ref(COL)
      .orderByChild("s")
      .limitToLast(BOARD_MAX)
      .once("value")
      .then(listFromSnapshot);
  }

  function submitToFirebase(entry) {
    var e = normalizeEntry(entry);
    if (!e) return Promise.reject(new Error("bad entry"));
    var ref = db.ref(COL + "/" + callsignKey(e.n));
    return ref
      .transaction(function (cur) {
        if (!cur) return e;
        return {
          n: e.n,
          s: Math.max(asInt(cur.s), e.s),
          l: Math.max(asInt(cur.l), e.l),
          k: Math.max(asInt(cur.k), e.k),
          b: Math.max(asInt(cur.b), e.b),
          w: e.w,
          t: e.t
        };
      })
      .then(function (result) {
        if (result && result.committed === false) {
          throw new Error("transaction not committed");
        }
        return loadFromFirebase();
      });
  }

  global.OneRoundBoard = {
    init: init,
    isOnline: function () {
      return online;
    },
    lastError: function () {
      return lastError;
    },
    load: function () {
      if (!db) return Promise.reject(new Error("offline"));
      return loadFromFirebase().catch(function (err) {
        lastError = String(err && err.message ? err.message : err);
        throw err;
      });
    },
    submit: function (entry) {
      if (!db) return Promise.reject(new Error("offline"));
      return submitToFirebase(entry).catch(function (err) {
        lastError = String(err && err.message ? err.message : err);
        console.warn("[OneRoundBoard] submit failed", err, entry);
        throw err;
      });
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
