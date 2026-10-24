// Shell: game library, the in-game input loop, and the controls setup screen.
(function () {
  const I = window.ArcadeInput;
  const $ = id => document.getElementById(id);
  const ARCADE = "https://arcade.makecode.com";
  const READY_POLL_MS = 500;
  const SLOW_LOAD_MS = 30000;
  const NAV_DELAY_MS = 350;   // stick held: first repeat
  const NAV_REPEAT_MS = 130;  // stick held: following repeats

  let info = {};
  let controls = null;
  let mapper = null;
  let mode = "library";       // "library" | "game" | "controls" | "settings"
  let games = [];
  let settings = {};

  // In-game state
  let currentGame = null;
  let lastSent = null;        // per player, what the simulator was last told
  let prevSystem = { exit: false, reset: false };
  let exitHoldStart = 0;
  let readyTimer = null;
  let startedAt = 0;
  let gameRunning = false;

  // Library navigation by controller
  let navHeld = null;
  let navNextAt = 0;
  let prevA = false;

  // Controls screen
  let controlsPlayer = 0;
  let learn = null;
  let padSignature = "";

  // ---------- startup ----------

  async function init() {
    info = await window.player.info();
    await window.player.stopGame(); // in case the page reloaded mid-game
    settings = await window.player.getSettings();
    applySettings();
    controls = I.normalizeControls(await window.player.getControls());
    mapper = new I.InputMapper(controls);

    window.player.onKey((code, down) => (down ? mapper.keyDown(code) : mapper.keyUp(code)));
    window.player.onClearInput(() => mapper.clearKeys());
    window.player.onLibraryChanged(refreshLibrary);

    document.addEventListener("keydown", onDomKeyDown, true);
    document.addEventListener("keyup", e => { if (mode !== "game") mapper.keyUp(e.code); }, true);
    window.addEventListener("online", updateNetStatus);
    window.addEventListener("offline", updateNetStatus);

    $("add-form").addEventListener("submit", onAddGame);
    $("open-settings").addEventListener("click", openSettings);
    $("close-settings").addEventListener("click", closeSettings);
    $("open-file").addEventListener("click", () => addLocal(() => window.player.openProject("file")));
    $("open-folder").addEventListener("click", () => addLocal(() => window.player.openProject("folder")));
    setUpDrop();
    $("open-controls").addEventListener("click", openControls);
    $("close-controls").addEventListener("click", closeControls);
    $("reset-controls").addEventListener("click", () => { controls = I.defaultControls(); saveControls(); renderControls(); });
    $("quit").addEventListener("click", () => window.player.quit());
    $("pad-select").addEventListener("change", e => {
      controls.players[controlsPlayer].gamepad = Number(e.target.value);
      saveControls();
    });
    $("learn-all").addEventListener("click", () => startLearn(controlsPlayer, I.ACTIONS.slice(), false));
    $("learn-skip").addEventListener("click", () => advanceLearn());
    $("learn-clear").addEventListener("click", () => { clearBinding(); advanceLearn(); });
    $("learn-cancel").addEventListener("click", () => finishLearn());

    $("update-button").addEventListener("click", () => window.player.installUpdate());
    window.player.onUpdate(showUpdate);
    showUpdate(await window.player.getUpdate());

    updateNetStatus();
    await refreshLibrary();
    focusGame(0);
    requestAnimationFrame(tick);
  }

  function onDomKeyDown(e) {
    // In a game, main.js forwards every key (down and up) over IPC; the DOM copy is ignored.
    if (mode === "game") { e.preventDefault(); return; }
    if (!e.repeat) mapper.keyDown(e.code);
    if (learn) {
      // Every key is a candidate binding while learning, so nothing else may react to it.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (mode === "settings" && e.key === "Escape") {
      closeSettings();
    } else if ((mode === "library" || mode === "settings") && !e.target.matches("input")) {
      const dir = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[e.key];
      if (dir) { e.preventDefault(); moveFocus(dir); }
    } else if (mode === "controls" && e.key === "Escape") {
      closeControls();
    }
  }

  function updateNetStatus() {
    const el = $("net-status");
    if (info.offline) { el.textContent = "Offline mode: saved games only"; el.className = "pill offline"; }
    else if (navigator.onLine) { el.textContent = "Online"; el.className = "pill online"; }
    else { el.textContent = "Offline: saved games only"; el.className = "pill offline"; }
  }

  // Version pill, download progress, and the restart button once an update is ready.
  // (A ready update also installs by itself the next time the app is closed.)
  function showUpdate(u) {
    const pill = $("update-status");
    const button = $("update-button");
    button.hidden = u.status !== "ready";
    if (u.status === "downloading") pill.textContent = `Downloading v${u.newVersion}… ${u.percent || 0}%`;
    else if (u.status === "ready") pill.textContent = `v${u.newVersion} ready`;
    else pill.textContent = `v${u.version}`;
    if (u.status === "ready") button.textContent = `Restart to update`;
    pill.title = u.status === "error" ? `Update check failed: ${u.error}` : "";
  }

  function tick(now) {
    if (mode === "game") gameTick(now);
    else if (learn) learnTick();
    else if (mode === "library" || mode === "settings") navTick(now);
    else if (mode === "controls") controlsTick();
    requestAnimationFrame(tick);
  }

  function showView(name) {
    $("library-view").hidden = name !== "library";
    $("game-view").hidden = name !== "game";
    $("controls-view").hidden = name !== "controls";
    $("settings-view").hidden = name !== "settings";
  }

  // ---------- library ----------

  async function refreshLibrary() {
    games = await window.player.listGames();
    games.sort((a, b) => String(b.lastPlayedAt || b.addedAt).localeCompare(String(a.lastPlayedAt || a.addedAt)));
    if (mode === "library") renderLibrary();
    if (mode === "settings") renderSettings();
  }

  function renderLibrary() {
    const focusedId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null;
    const list = $("games");
    list.textContent = "";
    $("empty").hidden = games.length > 0;

    for (const game of games) {
      const li = document.createElement("li");
      li.className = "game-item";

      const card = document.createElement("button");
      card.type = "button";
      card.className = "game";
      card.dataset.id = game.id;
      card.addEventListener("click", () => playGame(game));

      const img = document.createElement("img");
      img.alt = "";
      img.src = `${ARCADE}/api/${encodeURIComponent(game.id)}/thumb`;
      img.addEventListener("error", () => {
        const blank = document.createElement("span");
        blank.className = "thumb-empty";
        img.replaceWith(blank);
      });

      const meta = document.createElement("span");
      meta.className = "meta";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = game.title;
      const badge = document.createElement("span");
      const local = game.kind === "local";
      if (game.saving) { badge.className = "badge saving"; badge.textContent = local ? "Checking project…" : "Saving for offline…"; }
      else if (game.offlineReady) { badge.className = "badge ready"; badge.textContent = local ? "Local file · ready offline" : "Saved for offline"; }
      else { badge.className = "badge"; badge.textContent = local ? "Local file" : "Not saved for offline yet"; }
      meta.append(title, badge);
      if (local) {
        const source = document.createElement("span");
        source.className = "source";
        source.textContent = game.path.split(/[\\/]/).pop();
        source.title = game.path;
        meta.append(source);
      }
      card.append(img, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = "×";
      remove.title = "Remove from library";
      remove.setAttribute("aria-label", `Remove ${game.title}`);
      remove.addEventListener("click", async () => {
        await window.player.removeGame(game.id);
        await refreshLibrary();
        focusGame(0);
      });

      li.append(card, remove);
      list.append(li);
    }
    if (focusedId) {
      const again = list.querySelector(`.game[data-id="${CSS.escape(focusedId)}"]`);
      if (again) again.focus();
    }
  }

  async function onAddGame(e) {
    e.preventDefault();
    const input = $("add-input");
    const msg = $("add-msg");
    const value = input.value.trim();
    if (!value) return;
    msg.className = "msg";
    msg.textContent = "Looking up game…";
    $("add-button").disabled = true;
    const res = await window.player.addGame(value);
    $("add-button").disabled = false;
    if (res.ok) {
      msg.textContent = `Added "${res.game.title}". Saving it for offline play in the background.`;
      input.value = "";
      await refreshLibrary();
      const card = document.querySelector(`.game[data-id="${CSS.escape(res.game.id)}"]`);
      if (card) card.focus();
    } else {
      msg.className = "msg error";
      msg.textContent = res.error;
    }
  }

  // Adds a project from disk. `pick` returns the main process's {ok, game, error, canceled}.
  async function addLocal(pick) {
    const msg = $("add-msg");
    msg.className = "msg";
    msg.textContent = "Reading project…";
    const res = await pick();
    if (res.canceled) { msg.textContent = ""; return; }
    if (!res.ok) {
      msg.className = "msg error";
      msg.textContent = res.error;
      return;
    }
    msg.textContent = `Added "${res.game.title}" from ${res.game.path.split(/[\\/]/).pop()}.`;
    await refreshLibrary();
    const card = document.querySelector(`.game[data-id="${CSS.escape(res.game.id)}"]`);
    if (card) card.focus();
  }

  function setUpDrop() {
    let depth = 0;
    const overlay = $("drop-overlay");
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    document.addEventListener("dragenter", e => {
      if (mode !== "library" || !hasFiles(e)) return;
      depth++;
      overlay.hidden = false;
    });
    document.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    document.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener("drop", async e => {
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      if (mode !== "library") return;
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) await addLocal(() => window.player.addProjectFile(file));
    });
  }

  // Items the stick and arrow keys move between: game cards in the library, rows in settings.
  function navItem() { return mode === "settings" ? ".setting" : ".game"; }
  function cards() { return Array.from(document.querySelectorAll(navItem())); }

  function focusGame(index) {
    const list = cards();
    if (list.length) list[Math.max(0, Math.min(index, list.length - 1))].focus();
  }

  function moveFocus(dir) {
    const list = cards();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    if (at < 0) { list[0].focus(); return; }
    const cols = list.filter(c => c.offsetTop === list[0].offsetTop).length || 1;
    const step = { left: -1, right: 1, up: -cols, down: cols }[dir];
    const next = at + step;
    if (next >= 0 && next < list.length) {
      list[next].focus();
      list[next].scrollIntoView({ block: "nearest" });
    }
  }

  // Controller navigation of the library and settings: stick moves, A plays or toggles.
  function navTick(now) {
    const s = mapper.poll(false);
    const any = a => s.players.some(p => p[a]);
    const dir = ["up", "down", "left", "right"].find(any) || null;
    if (dir !== navHeld) {
      navHeld = dir;
      if (dir) { moveFocus(dir); navNextAt = now + NAV_DELAY_MS; }
    } else if (dir && now >= navNextAt) {
      moveFocus(dir);
      navNextAt = now + NAV_REPEAT_MS;
    }
    const a = any("a");
    if (a && !prevA) {
      if (document.activeElement && document.activeElement.matches(navItem())) document.activeElement.click();
      else focusGame(0);
    }
    prevA = a;
  }

  // ---------- playing ----------

  async function playGame(game) {
    if (mode === "game") return;
    currentGame = game;
    const start = await window.player.startGame(game.id);
    if (!start.ok) {
      const msg = $("add-msg");
      msg.className = "msg error";
      msg.textContent = `Can't start "${game.title}": ${start.error}`;
      return;
    }
    const url = start.url;
    mode = "game";
    gameRunning = false;
    showView("game");
    $("game-overlay").hidden = false;
    $("overlay-title").textContent = game.title;
    $("overlay-sub").textContent = "Starting…";

    // Whatever is held right now (e.g. the A that launched the game) must be
    // released and pressed again before the game sees it.
    const s = mapper.poll(true);
    lastSent = s.players.map(p => Object.assign({}, p));
    prevSystem = Object.assign({}, s.system);
    exitHoldStart = 0;

    $("game-frame").src = url;
    startedAt = Date.now();
    clearInterval(readyTimer);
    readyTimer = setInterval(checkReady, READY_POLL_MS);
  }

  async function checkReady() {
    if (mode !== "game" || gameRunning) return;
    if (await window.player.gameReady()) {
      gameRunning = true;
      clearInterval(readyTimer);
      $("game-overlay").hidden = true;
      window.player.markCached(currentGame.id);
      // Re-send anything held during loading, since the simulator wasn't listening yet.
      lastSent.forEach((st, p) => I.ACTIONS.forEach(a => { if (st[a]) window.player.setButton(I.SIM_KEY[a] + 7 * p, true); }));
    } else if (Date.now() - startedAt > SLOW_LOAD_MS) {
      $("overlay-sub").textContent = (navigator.onLine && !info.offline)
        ? "Still loading. Large games can take a while the first time. Press Esc or hold Menu + B to go back."
        : "This game hasn't been saved for offline play yet. Connect to the internet and play it once. Press Esc or hold Menu + B to go back.";
    }
  }

  function gameTick(now) {
    const s = mapper.poll(true);
    s.players.forEach((st, p) => {
      I.ACTIONS.forEach(a => {
        if (st[a] !== lastSent[p][a]) {
          lastSent[p][a] = st[a];
          window.player.setButton(I.SIM_KEY[a] + 7 * p, st[a]);
        }
      });
    });

    if (s.system.exit && !prevSystem.exit) { exitGame(); return; }
    if (s.system.reset !== prevSystem.reset) window.player.setButton(I.SIM_RESET, s.system.reset);
    prevSystem = Object.assign({}, s.system);

    // Hold P1 Menu + B to quit.
    const meter = $("exit-meter");
    const p1 = s.players[0];
    if (p1.menu && p1.b) {
      if (!exitHoldStart) exitHoldStart = now;
      const f = (now - exitHoldStart) / controls.exitHoldMs;
      meter.hidden = false;
      meter.firstElementChild.style.width = Math.min(100, f * 100) + "%";
      if (f >= 1) exitGame();
    } else if (exitHoldStart) {
      exitHoldStart = 0;
      meter.hidden = true;
    }
  }

  async function exitGame() {
    if (mode !== "game") return;
    mode = "library";
    clearInterval(readyTimer);
    exitHoldStart = 0;
    $("exit-meter").hidden = true;
    // A fresh iframe guarantees the old game is unloaded (sound included).
    const old = $("game-frame");
    const fresh = old.cloneNode(false);
    fresh.removeAttribute("src");
    old.replaceWith(fresh);
    await window.player.stopGame();
    mapper.clearKeys();
    navHeld = null;
    prevA = true; // the A/B still held from the game shouldn't launch something
    showView("library");
    await refreshLibrary();
    const card = currentGame && document.querySelector(`.game[data-id="${CSS.escape(currentGame.id)}"]`);
    if (card) card.focus(); else focusGame(0);
  }

  // ---------- settings screen ----------

  // [key, label, description] for the on/off settings. Saved to settings.json by main.js.
  const TOGGLES = [
    ["startWithWindows", "Start with Windows", "Opens Arcade Player when you sign in. Installed app only."],
    ["startFullscreen", "Start full screen", "Opens the window full screen. F11 still toggles it."],
    ["hideTips", "Hide tips", "Hides all the instructions for a cleaner look."],
    ["saveMissingOnStart", "Save missing games at startup", "Retries any game that isn't saved for offline yet, shortly after the app starts."],
    ["autoUpdate", "Check for updates automatically", "Looks for a new version on GitHub Releases every few hours."]
  ];

  function applySettings() {
    document.body.classList.toggle("hide-tips", !!settings.hideTips);
  }

  function openSettings() {
    mode = "settings";
    showView("settings");
    refreshLibrary(); // renders the settings once the game list is current
    renderSettings();
    $("close-settings").focus();
  }

  function closeSettings() {
    mode = "library";
    showView("library");
    renderLibrary();
    focusGame(0);
  }

  function settingRow(key, label, desc, value, onClick, pressed) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "setting setting-row";
    row.dataset.key = key;
    if (pressed !== undefined) row.setAttribute("aria-pressed", String(pressed));
    const text = document.createElement("span");
    text.className = "setting-text";
    const name = document.createElement("span");
    name.className = "setting-label";
    name.textContent = label;
    const note = document.createElement("span");
    note.className = "setting-desc";
    note.textContent = desc;
    text.append(name, note);
    const val = document.createElement("span");
    val.className = "setting-value";
    val.textContent = value;
    row.append(text, val);
    row.addEventListener("click", onClick);
    return row;
  }

  function settingsMsg(text, error) {
    const msg = $("settings-msg");
    msg.className = error ? "msg error" : "msg";
    msg.textContent = text;
  }

  function renderSettings() {
    // Re-rendering replaces the buttons, so keep the keyboard/controller focus on the same row.
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;

    const general = $("settings-general");
    general.textContent = "";
    for (const [key, label, desc] of TOGGLES) {
      const on = !!settings[key];
      general.append(settingRow(key, label, desc, on ? "On" : "Off", () => toggleSetting(key), on));
    }
    general.append(settingRow("check-updates", "Check for updates now",
      "Installed copies also check every few hours and install a new version on the next restart.",
      "Check", checkUpdatesNow));
    general.append(settingRow("controls", "Controls",
      "Keyboard and controller bindings, and which controller each player uses.", "Open", openControls));

    const missing = games.filter(g => !g.offlineReady).length;
    const offline = $("settings-offline");
    offline.textContent = "";
    offline.append(settingRow("save-offline", "Run Save For Offline",
      "Tries to download every game that isn't saved for offline yet, one at a time. Needs an internet connection.",
      missing ? `${missing} to save` : "All saved", runSaveOffline));

    $("about").textContent = `Arcade Player v${info.version}. Your library and offline files are in ${info.dataDir}.`;

    if (focusKey) {
      const again = document.querySelector(`#settings-view [data-key="${CSS.escape(focusKey)}"]`);
      if (again) again.focus();
    }
  }

  async function toggleSetting(key) {
    settings = await window.player.setSettings({ [key]: !settings[key] });
    applySettings();
    renderSettings();
  }

  async function checkUpdatesNow() {
    settingsMsg("Checking for updates…");
    const started = await window.player.checkForUpdates();
    settingsMsg(started ? "" : "Updates only run in the installed app.");
  }

  async function runSaveOffline() {
    const res = await window.player.saveAllOffline();
    if (!res.ok) settingsMsg(res.error, true);
    else if (res.alreadyRunning) settingsMsg(`Already saving games in the background (${res.queued} left).`);
    else if (res.queued) settingsMsg(`Saving ${res.queued} game${res.queued === 1 ? "" : "s"} in the background. Each card shows its progress in the library.`);
    else settingsMsg("Every game is already saved for offline.");
    await refreshLibrary();
  }

  // ---------- controls screen ----------

  function saveControls() {
    mapper.setControls(controls);
    window.player.setControls(controls);
  }

  let controlsFrom = "library"; // Controls can be opened from the library or from Settings

  function openControls() {
    controlsFrom = mode === "settings" ? "settings" : "library";
    mode = "controls";
    showView("controls");
    renderControls();
    $("close-controls").focus();
  }

  function closeControls() {
    if (learn) finishLearn();
    if (controlsFrom === "settings") { openSettings(); return; }
    mode = "library";
    showView("library");
    renderLibrary();
    focusGame(0);
  }

  function chips(items, label) {
    if (!items.length) return '<span class="none">none</span>';
    return items.map(x => `<span class="chip">${escapeHtml(label(x))}</span>`).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderControls() {
    const tabs = $("player-tabs");
    tabs.textContent = "";
    for (let p = 0; p < I.MAX_PLAYERS; p++) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(p === controlsPlayer));
      b.textContent = `Player ${p + 1}`;
      b.addEventListener("click", () => { controlsPlayer = p; renderControls(); });
      tabs.append(b);
    }

    renderPadSelect();

    const pl = controls.players[controlsPlayer];
    $("player-rows").innerHTML = I.ACTIONS.map(a => `
      <tr>
        <td>${I.ACTION_LABELS[a]}</td>
        <td>${chips(pl.keys[a], I.keyLabel)}</td>
        <td>${chips(pl.pad[a], I.bindingLabel)}</td>
        <td><span class="dot" id="live-${a}"></span></td>
        <td><button type="button" data-learn="${a}">Learn</button></td>
      </tr>`).join("");
    $("system-rows").innerHTML = I.SYSTEM_ACTIONS.map(a => `
      <tr>
        <td>${I.SYSTEM_LABELS[a]}</td>
        <td>${chips(controls.system[a].keys, I.keyLabel)}</td>
        <td>${chips(controls.system[a].pad, I.bindingLabel)}</td>
        <td><span class="dot" id="live-sys-${a}"></span></td>
        <td><button type="button" data-learn-system="${a}">Learn</button></td>
      </tr>`).join("");

    document.querySelectorAll("[data-learn]").forEach(b =>
      b.addEventListener("click", () => startLearn(controlsPlayer, [b.dataset.learn], false)));
    document.querySelectorAll("[data-learn-system]").forEach(b =>
      b.addEventListener("click", () => startLearn(0, [b.dataset.learnSystem], true)));
  }

  function renderPadSelect() {
    const pads = mapper.pads();
    const sel = $("pad-select");
    sel.textContent = "";
    for (let i = 0; i < 4; i++) {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `Controller ${i + 1}: ${pads[i] ? pads[i].id : "not connected"}`;
      sel.append(o);
    }
    sel.value = String(controls.players[controlsPlayer].gamepad);
  }

  function controlsTick() {
    const s = mapper.poll(true);
    const st = s.players[controlsPlayer];
    I.ACTIONS.forEach(a => { const d = $("live-" + a); if (d) d.classList.toggle("on", !!st[a]); });
    I.SYSTEM_ACTIONS.forEach(a => { const d = $("live-sys-" + a); if (d) d.classList.toggle("on", !!s.system[a]); });
    renderPadMonitor(s.pads);
  }

  // Raw view of every controller, so you can see which number each panel button sends.
  function renderPadMonitor(pads) {
    const present = pads.filter(Boolean);
    const sig = present.map(gp => `${gp.index}:${gp.id}:${gp.buttons.length}:${gp.axes.length}`).join("|");
    const box = $("pad-monitor");
    if (sig !== padSignature) {
      padSignature = sig;
      renderPadSelect();
      if (!present.length) {
        box.innerHTML = '<p class="none">No controllers seen yet. Plug one in and press a button.</p>';
        return;
      }
      box.innerHTML = present.map(gp => `
        <div class="pad-card" data-pad="${gp.index}">
          <div class="pad-name">Controller ${gp.index + 1}: ${escapeHtml(gp.id)}</div>
          <div class="pad-sub">${gp.mapping === "standard" ? "Standard layout" : "Non-standard layout (typical for arcade encoders)"}
            · ${gp.buttons.length} buttons · ${gp.axes.length} axes</div>
          <div class="pad-buttons">${gp.buttons.map((_, i) => `<span>${i + 1}</span>`).join("")}</div>
          <div class="pad-axes"></div>
        </div>`).join("");
    }
    present.forEach(gp => {
      const card = box.querySelector(`[data-pad="${gp.index}"]`);
      if (!card) return;
      const spans = card.querySelectorAll(".pad-buttons span");
      gp.buttons.forEach((b, i) => spans[i] && spans[i].classList.toggle("on", b.pressed || b.value > 0.5));
      card.querySelector(".pad-axes").textContent = gp.axes.map((v, i) => {
        const hatNote = mapper.isHat(gp.index, i) ? ` (hat ${I.hatDirs(v).join("+") || "centre"})` : "";
        return `axis ${i}: ${v.toFixed(2)}${hatNote}`;
      }).join("   ");
    });
  }

  // ---------- Learn ----------

  function startLearn(playerIndex, actions, system) {
    learn = { player: playerIndex, actions, index: 0, system, phase: "release", snap: null };
    $("learn").hidden = false;
    updateLearnPrompt("");
    $("learn-skip").focus();
  }

  function updateLearnPrompt(detail) {
    const action = learn.actions[learn.index];
    $("learn-player").textContent = learn.system ? "System (player 1's controller)" : `Player ${learn.player + 1}`;
    $("learn-prompt").textContent = learn.system ? I.SYSTEM_LABELS[action] : `Press ${I.ACTION_LABELS[action].toUpperCase()}`;
    const count = learn.actions.length > 1 ? ` (${learn.index + 1} of ${learn.actions.length})` : "";
    $("learn-detail").textContent = detail || (learn.phase === "release"
      ? "Let go of everything…"
      : `Press a key, or push the stick / press a button on the controller${count}.`);
  }

  function learnTick() {
    if (learn.phase === "release") {
      if (mapper.idle()) {
        learn.snap = mapper.snapshot();
        learn.phase = "listen";
        updateLearnPrompt("");
      }
      return;
    }
    const got = mapper.detect(learn.snap);
    if (!got) return;
    const action = learn.actions[learn.index];
    if (learn.system) {
      const target = controls.system[action];
      if (got.kind === "key") target.keys = [got.code];
      else target.pad = [got.binding];
    } else {
      const pl = controls.players[learn.player];
      if (got.kind === "key") pl.keys[action] = [got.code];
      else { pl.pad[action] = [got.binding]; pl.gamepad = got.gamepad; }
    }
    saveControls();
    renderControls();
    advanceLearn();
  }

  function clearBinding() {
    if (!learn) return;
    const action = learn.actions[learn.index];
    if (learn.system) controls.system[action] = { keys: [], pad: [] };
    else { controls.players[learn.player].keys[action] = []; controls.players[learn.player].pad[action] = []; }
    saveControls();
    renderControls();
  }

  function advanceLearn() {
    if (!learn) return;
    learn.index++;
    if (learn.index >= learn.actions.length) { finishLearn(); return; }
    learn.phase = "release";
    updateLearnPrompt("");
  }

  function finishLearn() {
    learn = null;
    $("learn").hidden = true;
    mapper.clearKeys();
    renderControls();
    $("learn-all").focus();
  }

  init();
})();
