/**
 * OneRoundModHost — sandboxed presentation / assist surface for ORML mods.
 * ONE ROUND Mod Launcher system © 2026 Aidiotic — LICENSE-MOD-LAUNCHER
 * Does not expose scoring, fire mutation, upgrades, or raw engine objects.
 * Online mode fail-closes: only capabilities() allowlist is honored.
 */
(function (global) {
  "use strict";

  var CAPS_OFFLINE = ["visual", "assist"];
  var CAPS_ONLINE = ["visual", "assist"]; // no authority in v1 ABI

  var listeners = Object.create(null);
  var panels = Object.create(null);
  var overlays = Object.create(null);
  var badges = Object.create(null);
  var bound = null;
  var lastPreview = null;
  var lastPreviewRaw = null;

  function emptyListeners() {
    return { aim: [], fire: [], resolve: [], upgrade: [], frame: [] };
  }
  listeners = emptyListeners();

  function urlFlag(name) {
    try {
      return new URLSearchParams(location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  var mode = urlFlag("online") === "1" ? "online" : "offline";
  var replaceBuiltins = urlFlag("modHost") === "1" || urlFlag("mods") === "1";
  var modsActive = false;

  // Launcher postMessage allowlist. Same-origin always (dev.sh serves
  // launcher + game together); add others with ?modHostOrigin=.
  function buildAllowedOrigins() {
    var out = [];
    function add(o) {
      if (!o || o === "null") return;
      if (out.indexOf(o) < 0) out.push(o);
    }
    try {
      add(location.origin);
    } catch (e) {}
    try {
      var params = new URLSearchParams(location.search);
      var list = params.getAll("modHostOrigin");
      for (var i = 0; i < list.length; i++) {
        var raw = list[i];
        if (!raw) continue;
        var parts = raw.split(",");
        for (var j = 0; j < parts.length; j++) {
          var p = parts[j].trim();
          if (!p) continue;
          try {
            add(new URL(p).origin);
          } catch (e2) {
            add(p);
          }
        }
      }
    } catch (e3) {}
    return out;
  }
  var allowedOrigins = buildAllowedOrigins();

  function originAllowed(origin) {
    if (!origin || origin === "null") return false;
    for (var i = 0; i < allowedOrigins.length; i++) {
      if (allowedOrigins[i] === origin) return true;
    }
    return false;
  }

  function parentTargetOrigins() {
    var targets = [];
    function add(o) {
      if (!originAllowed(o)) return;
      if (targets.indexOf(o) < 0) targets.push(o);
    }
    try {
      if (location.ancestorOrigins) {
        for (var i = 0; i < location.ancestorOrigins.length; i++) {
          add(location.ancestorOrigins[i]);
        }
      }
    } catch (e) {}
    try {
      if (document.referrer) add(new URL(document.referrer).origin);
    } catch (e2) {}
    try {
      add(location.origin);
    } catch (e3) {}
    return targets;
  }

  function postTo(source, payload, targetOrigin) {
    if (!source || !targetOrigin || !originAllowed(targetOrigin)) return;
    try {
      source.postMessage(payload, targetOrigin);
    } catch (e) {}
  }

  function caps() {
    return mode === "online" ? CAPS_ONLINE.slice() : CAPS_OFFLINE.slice();
  }

  function hasCap(need) {
    var c = caps();
    for (var i = 0; i < c.length; i++) if (c[i] === need) return true;
    return false;
  }

  function deny(why) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[OneRoundModHost] denied:", why);
    }
    return null;
  }

  function requireBound() {
    if (!bound) throw new Error("OneRoundModHost not bound yet");
    return bound;
  }

  function cloneVec(v) {
    if (!v) return null;
    return { x: +v.x || 0, y: +v.y || 0, z: +v.z || 0 };
  }

  function serializePath(pv) {
    if (!pv) return null;
    var pts = [];
    for (var i = 0; i < pv.pts.length; i++) pts.push(cloneVec(pv.pts[i]));
    var events = [];
    for (var e = 0; e < pv.events.length; e++) {
      var ev = pv.events[e];
      events.push({
        type: ev.type,
        at: ev.at,
        i: ev.i,
        head: !!ev.head,
        armored: !!ev.armored,
        nb: ev.nb,
        left: ev.left,
        p: cloneVec(ev.p),
        n: cloneVec(ev.n)
      });
    }
    return {
      pts: pts,
      events: events,
      kills: pv.kills | 0,
      bounces: pv.bounces | 0,
      length: pv.length || 0,
      spareBounce: pv.spareBounce | 0
    };
  }

  function emit(event, payload) {
    var list = listeners[event];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        if (typeof console !== "undefined" && console.error) {
          console.error("[OneRoundModHost] listener error", event, err);
        }
      }
    }
  }

  var Host = {
    version: 1,
    get mode() {
      return mode;
    },
    set mode(v) {
      mode = v === "online" ? "online" : "offline";
    },
    get replaceBuiltins() {
      return replaceBuiltins && modsActive;
    },
    set replaceBuiltins(v) {
      replaceBuiltins = !!v;
    },
    get modsActive() {
      return modsActive;
    },
    setModsActive: function (on) {
      modsActive = !!on;
      if (!modsActive && bound && bound.hideTracerPreview) bound.hideTracerPreview();
    },

    resetListeners: function () {
      listeners = emptyListeners();
    },

    capabilities: function () {
      return caps();
    },

    bind: function (api) {
      bound = api;
      Host.ready = true;
      try {
        global.dispatchEvent(new CustomEvent("oneround-modhost-ready"));
      } catch (e) {}
      if (global.parent && global.parent !== global) {
        var readyMsg = {
          type: "oneround-modhost-ready",
          capabilities: caps(),
          mode: mode
        };
        var targets = parentTargetOrigins();
        for (var ti = 0; ti < targets.length; ti++) {
          postTo(global.parent, readyMsg, targets[ti]);
        }
      }
      return Host;
    },

    subscribe: function (event, fn) {
      if (!listeners[event]) return function () {};
      listeners[event].push(fn);
      return function unsubscribe() {
        var list = listeners[event];
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },

    _emit: emit,

    getPhase: function () {
      return requireBound().getPhase();
    },
    getLevel: function () {
      return requireBound().getLevel();
    },
    getStats: function () {
      var s = requireBound().getStats();
      return {
        pierce: s.pierce | 0,
        bounces: s.bounces | 0,
        radius: +s.radius || 0,
        guide: s.guide | 0,
        tracer: !!s.tracer,
        scope: !!s.scope,
        chrono: s.chrono | 0,
        retries: s.retries | 0,
        frag: !!s.frag,
        bloom: !!s.bloom,
        pads: s.pads | 0,
        crit: +s.crit || 0
      };
    },
    getPlayerPose: function () {
      var p = requireBound().getPlayerPose();
      return {
        x: +p.x || 0,
        y: +p.y || 0,
        z: +p.z || 0,
        yaw: +p.yaw || 0,
        pitch: +p.pitch || 0
      };
    },
    getEnemies: function () {
      var list = requireBound().getEnemies();
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        out.push({
          i: i,
          x: +e.x || 0,
          z: +e.z || 0,
          alive: !!e.alive,
          armored: !!e.armored,
          span: +e.span || 0,
          axis: !!e.axis
        });
      }
      return out;
    },
    getAimRay: function () {
      var r = requireBound().getAimRay();
      return { origin: cloneVec(r.origin), dir: cloneVec(r.dir) };
    },
    getRoom: function () {
      return requireBound().getRoom();
    },
    getBlocks: function () {
      if (!hasCap("assist") && !hasCap("visual")) return deny("blocks");
      return requireBound().getBlocks();
    },

    previewPath: function (opts) {
      if (!hasCap("assist") && !hasCap("visual")) return deny("previewPath");
      var raw = requireBound().previewPath(opts || {});
      lastPreviewRaw = raw;
      lastPreview = serializePath(raw);
      return lastPreview;
    },

    framePerfect: function () {
      if (!hasCap("assist")) return deny("framePerfect");
      // Always use host-side last solve (or re-solve). Never trust mod-supplied path data.
      var raw = lastPreviewRaw;
      if (!raw) {
        raw = requireBound().previewPath({});
        lastPreviewRaw = raw;
        lastPreview = serializePath(raw);
      }
      return requireBound().framePerfect(raw);
    },

    ui: {
      setPanel: function (id, spec) {
        if (!hasCap("visual")) return deny("ui.setPanel");
        panels[id] = spec || null;
        return requireBound().uiSetPanel(id, spec);
      },
      clearPanel: function (id) {
        if (!hasCap("visual")) return deny("ui.clearPanel");
        delete panels[id];
        return requireBound().uiClearPanel(id);
      },
      drawPlanView: function (pv, frameTight) {
        if (!hasCap("visual")) return deny("ui.drawPlanView");
        var raw = lastPreviewRaw;
        if (!raw) return false;
        return requireBound().drawPlanView(raw, frameTight || false);
      },
      showTracerPanel: function (on) {
        if (!hasCap("visual")) return deny("ui.showTracerPanel");
        return requireBound().showTracerPanel(!!on);
      }
    },

    scene: {
      setOverlay: function (id, spec) {
        if (!hasCap("visual")) return deny("scene.setOverlay");
        overlays[id] = spec || null;
        if (spec && (spec.fromPreview || spec.usePreview) && lastPreviewRaw) {
          return requireBound().applyPreviewOverlay(lastPreviewRaw);
        }
        return requireBound().setOverlay(id, spec);
      },
      clearOverlay: function (id) {
        if (!hasCap("visual")) return deny("scene.clearOverlay");
        delete overlays[id];
        return requireBound().clearOverlay(id);
      },
      hidePreview: function () {
        if (!hasCap("visual")) return deny("scene.hidePreview");
        return requireBound().hideTracerPreview();
      }
    },

    hud: {
      setBadge: function (id, text, pulse) {
        if (!hasCap("visual")) return deny("hud.setBadge");
        badges[id] = { text: text || "", pulse: !!pulse };
        return requireBound().setBadge(id, text || "", !!pulse);
      },
      clearBadge: function (id) {
        if (!hasCap("visual")) return deny("hud.clearBadge");
        delete badges[id];
        return requireBound().clearBadge(id);
      }
    },

    ready: false
  };

  global.addEventListener("message", function (ev) {
    if (!originAllowed(ev.origin)) return;
    var data = ev.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "oneround-modhost-config") {
      if (data.mode === "online" || data.mode === "offline") mode = data.mode;
      if (typeof data.replaceBuiltins === "boolean") replaceBuiltins = data.replaceBuiltins;
      if (typeof data.modsActive === "boolean") Host.setModsActive(data.modsActive);
      postTo(
        ev.source,
        { type: "oneround-modhost-config-ack", capabilities: caps(), mode: mode },
        ev.origin
      );
    }
  });

  global.OneRoundModHost = Host;
})(typeof window !== "undefined" ? window : globalThis);
