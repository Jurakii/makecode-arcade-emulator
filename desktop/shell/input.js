// Maps keyboard keys and USB controllers to MakeCode Arcade buttons.
//
// USB arcade encoders (Zero Delay / DragonRise / Xin-Mo and similar) show up as generic HID
// gamepads with no standard layout: the stick may arrive as axes, as d-pad buttons, or as a
// POV hat packed into one axis, and the button numbers depend on how the panel is wired.
// The defaults below cover all three stick styles; the setup screen's Learn mode records
// whatever the actual hardware sends. Keyboard encoders (I-PAC style) are just keys.
(function () {
  const ACTIONS = ["up", "down", "left", "right", "a", "b", "menu"];
  const ACTION_LABELS = { up: "Up", down: "Down", left: "Left", right: "Right", a: "A", b: "B", menu: "Menu" };
  const SYSTEM_ACTIONS = ["exit", "reset"];
  const SYSTEM_LABELS = { exit: "Quit to library", reset: "Restart game" };
  // pxsim.Key values for player 1; each further player adds 7.
  const SIM_KEY = { left: 1, up: 2, right: 3, down: 4, a: 5, b: 6, menu: 7 };
  const SIM_RESET = -3;
  const MAX_PLAYERS = 4;
  const AXIS_THRESHOLD = 0.5;

  const btn = i => ({ t: "button", i });
  const axis = (i, d) => ({ t: "axis", i, d });
  const hat = d => ({ t: "hat", d });

  // Works for standard pads (d-pad buttons 12-15, left stick) and most arcade encoders
  // (stick on axes 0/1 or on a hat axis, first buttons wired as A/B).
  function defaultPad() {
    return {
      up: [btn(12), axis(1, -1), hat("up")],
      down: [btn(13), axis(1, 1), hat("down")],
      left: [btn(14), axis(0, -1), hat("left")],
      right: [btn(15), axis(0, 1), hat("right")],
      a: [btn(0), btn(2)],
      b: [btn(1), btn(3)],
      menu: [btn(9)]
    };
  }

  function emptyKeys() {
    const keys = {};
    ACTIONS.forEach(a => { keys[a] = []; });
    return keys;
  }

  function defaultControls() {
    const players = [];
    for (let p = 0; p < MAX_PLAYERS; p++) players.push({ gamepad: p, keys: emptyKeys(), pad: defaultPad() });
    // Player 1 matches the simulator's own keys plus MAME-style encoder keys (L-Ctrl, L-Alt, 1).
    players[0].keys = {
      up: ["ArrowUp", "KeyW"], down: ["ArrowDown", "KeyS"], left: ["ArrowLeft", "KeyA"], right: ["ArrowRight", "KeyD"],
      a: ["Space", "KeyZ", "ControlLeft"], b: ["Enter", "KeyX", "AltLeft"], menu: ["Backquote", "Digit1"]
    };
    players[1].keys = {
      up: ["KeyI"], down: ["KeyK"], left: ["KeyJ"], right: ["KeyL"], a: ["KeyU"], b: ["KeyO"], menu: ["Digit2"]
    };
    return {
      version: 1,
      players,
      // System pad bindings are read from player 1's controller.
      system: { exit: { keys: ["Escape"], pad: [] }, reset: { keys: ["Backspace"], pad: [] } },
      // Holding P1 Menu + B this long quits the game, so a cabinet needs no keyboard.
      exitHoldMs: 1500
    };
  }

  // Fill in anything missing from a saved config (older version, hand edits).
  function normalizeControls(saved) {
    const base = defaultControls();
    if (!saved || typeof saved !== "object" || !Array.isArray(saved.players)) return base;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const sp = saved.players[p] || {};
      const bp = base.players[p];
      if (Number.isInteger(sp.gamepad)) bp.gamepad = sp.gamepad;
      ACTIONS.forEach(a => {
        if (sp.keys && Array.isArray(sp.keys[a])) bp.keys[a] = sp.keys[a].filter(k => typeof k === "string");
        if (sp.pad && Array.isArray(sp.pad[a])) bp.pad[a] = sp.pad[a].filter(validBinding);
      });
    }
    SYSTEM_ACTIONS.forEach(a => {
      const s = saved.system && saved.system[a];
      if (s && Array.isArray(s.keys)) base.system[a].keys = s.keys.filter(k => typeof k === "string");
      if (s && Array.isArray(s.pad)) base.system[a].pad = s.pad.filter(validBinding);
    });
    if (typeof saved.exitHoldMs === "number") base.exitHoldMs = saved.exitHoldMs;
    return base;
  }

  function validBinding(b) {
    return b && (b.t === "button" || b.t === "axis" || b.t === "hat");
  }

  // ---------- reading controllers ----------

  function readGamepads() {
    const list = window.__fakeGamepads || (navigator.getGamepads ? navigator.getGamepads() : []);
    const pads = [];
    for (const gp of list) if (gp) pads[gp.index] = gp;
    return pads;
  }

  // Chrome on Windows reports a DirectInput POV hat as one axis: -1 (up) to 1 (up-left) in
  // steps of 2/7 clockwise, and about 3.29 when centred. Axes seen outside [-1, 1] are hats.
  const HAT_DIRS = [["up"], ["up", "right"], ["right"], ["down", "right"], ["down"], ["down", "left"], ["left"], ["up", "left"]];
  function hatDirs(v) {
    if (typeof v !== "number" || v < -1.05 || v > 1.05) return [];
    return HAT_DIRS[Math.round((v + 1) * 3.5)] || [];
  }

  class InputMapper {
    constructor(controls) {
      this.controls = normalizeControls(controls);
      this.keys = new Set();
      this.hatAxes = {};      // gamepad index -> Set of axis indices that behave as hats
      this.lastKey = null;    // most recent keydown, for Learn mode
    }

    setControls(controls) { this.controls = normalizeControls(controls); }

    keyDown(code) { this.keys.add(code); this.lastKey = code; }
    keyUp(code) { this.keys.delete(code); }
    clearKeys() { this.keys.clear(); }

    pads() {
      const pads = readGamepads();
      pads.forEach(gp => {
        if (!gp) return;
        const set = this.hatAxes[gp.index] || (this.hatAxes[gp.index] = new Set());
        gp.axes.forEach((v, i) => { if (Math.abs(v) > 1.05) set.add(i); });
      });
      return pads;
    }

    isHat(gpIndex, axisIndex) {
      return !!(this.hatAxes[gpIndex] && this.hatAxes[gpIndex].has(axisIndex));
    }

    bindingActive(gp, b) {
      if (!gp || !b) return false;
      if (b.t === "button") {
        const x = gp.buttons[b.i];
        return !!x && (x.pressed || x.value > 0.5);
      }
      if (b.t === "axis") {
        if (this.isHat(gp.index, b.i)) return false;
        const v = gp.axes[b.i];
        return typeof v === "number" && v * b.d > AXIS_THRESHOLD;
      }
      if (b.t === "hat") {
        return gp.axes.some((v, i) => (b.i == null || b.i === i) && this.isHat(gp.index, i) && hatDirs(v).includes(b.d));
      }
      return false;
    }

    // Current state of every player's buttons and the system actions.
    // useKeys=false reads controllers only (menus get keyboard input from the DOM instead).
    poll(useKeys = true) {
      const pads = this.pads();
      const held = k => useKeys && this.keys.has(k);
      const players = this.controls.players.map(pl => {
        const gp = pads[pl.gamepad];
        const state = {};
        ACTIONS.forEach(a => {
          state[a] = pl.keys[a].some(held) || pl.pad[a].some(b => this.bindingActive(gp, b));
        });
        return state;
      });
      const p1pad = pads[this.controls.players[0].gamepad];
      const system = {};
      SYSTEM_ACTIONS.forEach(a => {
        const s = this.controls.system[a];
        system[a] = s.keys.some(held) || s.pad.some(b => this.bindingActive(p1pad, b));
      });
      return { players, system, pads };
    }

    // Menus: an action counts when any player's controller binding is active on any connected
    // controller, so changing which controller a player uses can't strand whoever holds the stick.
    menuState() {
      const pads = this.pads().filter(Boolean);
      const state = {};
      ACTIONS.forEach(a => {
        state[a] = this.controls.players.some(pl => pads.some(gp => pl.pad[a].some(b => this.bindingActive(gp, b))));
      });
      return state;
    }

    // ---------- Learn mode ----------

    // Remember what is currently held, so only a new press counts as the answer.
    snapshot() {
      const pads = this.pads();
      const snap = { keys: new Set(this.keys), pads: {} };
      pads.forEach(gp => {
        if (!gp) return;
        snap.pads[gp.index] = { buttons: gp.buttons.map(b => b.pressed || b.value > 0.5), axes: gp.axes.slice() };
      });
      this.lastKey = null;
      return snap;
    }

    // Returns {kind:"key", code} or {kind:"pad", gamepad, binding} for the first new input.
    detect(snap) {
      // lastKey (not keys) so a tap shorter than one frame still counts.
      if (this.lastKey && !snap.keys.has(this.lastKey)) {
        return { kind: "key", code: this.lastKey };
      }
      const pads = this.pads();
      for (const gp of pads) {
        if (!gp) continue;
        const base = snap.pads[gp.index] || { buttons: [], axes: [] };
        for (let i = 0; i < gp.buttons.length; i++) {
          const down = gp.buttons[i].pressed || gp.buttons[i].value > 0.5;
          if (down && !base.buttons[i]) return { kind: "pad", gamepad: gp.index, id: gp.id, binding: btn(i) };
        }
        for (let i = 0; i < gp.axes.length; i++) {
          const v = gp.axes[i];
          if (this.isHat(gp.index, i)) {
            const dirs = hatDirs(v);
            if (dirs.length === 1 && hatDirs(base.axes[i]).length === 0) {
              return { kind: "pad", gamepad: gp.index, id: gp.id, binding: { t: "hat", i, d: dirs[0] } };
            }
          } else if (Math.abs(v) > 0.6 && Math.abs(v - (base.axes[i] || 0)) > 0.6) {
            return { kind: "pad", gamepad: gp.index, id: gp.id, binding: axis(i, v > 0 ? 1 : -1) };
          }
        }
      }
      return null;
    }

    // True when nothing is held (sticks centred), so Learn can move to the next prompt.
    idle() {
      if (this.keys.size) return false;
      return this.pads().every(gp => {
        if (!gp) return true;
        if (gp.buttons.some(b => b.pressed || b.value > 0.5)) return false;
        return gp.axes.every((v, i) => this.isHat(gp.index, i) ? hatDirs(v).length === 0 : Math.abs(v) < 0.4);
      });
    }
  }

  // ---------- labels ----------

  const KEY_NAMES = {
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space", Enter: "Enter",
    Escape: "Esc", Backspace: "Backspace", Backquote: "`", ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl",
    AltLeft: "L-Alt", AltRight: "R-Alt", ShiftLeft: "L-Shift", ShiftRight: "R-Shift", Tab: "Tab"
  };
  function keyLabel(code) {
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad/.test(code)) return "Num " + code.slice(6);
    return code;
  }
  const DIR_ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };
  function bindingLabel(b) {
    if (b.t === "button") return `Button ${b.i + 1}`;
    if (b.t === "axis") return `Axis ${b.i} ${b.d < 0 ? "−" : "+"}`;
    if (b.t === "hat") return `Hat ${DIR_ARROWS[b.d] || b.d}`;
    return "?";
  }

  window.ArcadeInput = {
    ACTIONS, ACTION_LABELS, SYSTEM_ACTIONS, SYSTEM_LABELS, SIM_KEY, SIM_RESET, MAX_PLAYERS,
    InputMapper, defaultControls, normalizeControls, keyLabel, bindingLabel, hatDirs
  };
})();
