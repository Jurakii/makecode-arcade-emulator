// Arcade Desktop Player: runs MakeCode Arcade games in the official simulator,
// caches everything for offline play, and drives the game from USB arcade controls.
//
// Input path: the shell page (shell/) reads keyboard + gamepads and decides which Arcade
// button is pressed; main.js forwards each change into the simulator frame by calling
// pxsim.board().setButton(key, pressed), the same entry point the sim's own keyboard uses.
const { app, BrowserWindow, ipcMain, session, webFrameMain, Menu, net, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { RequestCache } = require("./cache");
const { readLocalProject, ProjectError } = require("./local-project");

const ARCADE = "https://arcade.makecode.com";
const OFFLINE = process.argv.includes("--offline");   // cache only, for testing offline play
const KIOSK = process.argv.includes("--kiosk");

// Sound must start without a click on a cabinet.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Library, controls and offline cache live here. Override for a portable install (e.g. a USB stick).
if (process.env.ARCADE_PLAYER_DATA) app.setPath("userData", path.resolve(process.env.ARCADE_PLAYER_DATA));

let win = null;
let cache = null;
let inGame = false;
let dataDir = "";

// ---------- persistence ----------

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8")); }
  catch (e) { return fallback; }
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2));
}

// ---------- game library ----------

// Accepts a share link (makecode.com/_xxx, arcade.makecode.com/12345-...), a ---run URL, or a bare id.
function parseGameId(input) {
  const m = String(input || "").trim()
    .match(/(?:^|[\/=#?])(_[A-Za-z0-9]{8,16}|S?\d{5}-\d{5}-\d{5}-\d{5})(?=$|[\/?#&])/);
  return m ? m[1] : null;
}

function runUrl(id) {
  return `${ARCADE}/---run?id=${encodeURIComponent(id)}`;
}

function textUrl(id) {
  return `${ARCADE}/api/${encodeURIComponent(id)}/text`;
}

function libraryWithStatus() {
  return readJson("library.json", []).map(g => ({
    ...g,
    // A local project's source is always on disk; it only needs the runner cached.
    offlineReady: !!g.cachedAt && (g.kind === "local" || cache.has(textUrl(g.id))),
    saving: warming.has(g.id)
  }));
}

async function addGame(input) {
  const id = parseGameId(input);
  if (!id) throw new Error("That doesn't look like a MakeCode Arcade share link or game id.");

  const res = await net.fetch(`${ARCADE}/api/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.status === 404 ? "Game not found (is it shared publicly?)" : `MakeCode returned ${res.status}`);
  const meta = await res.json();
  if (meta.target && meta.target !== "arcade") throw new Error(`That project is for ${meta.target}, not Arcade.`);

  const library = readJson("library.json", []);
  const existing = library.find(g => g.id === id || g.longId === meta.id);
  if (existing) return existing;
  const game = { id, longId: meta.id, title: meta.name || id, description: meta.description || "", addedAt: new Date().toISOString() };
  library.push(game);
  writeJson("library.json", library);
  warmCache(game.id); // download in the background so it plays offline
  return game;
}

function updateGame(id, patch) {
  const library = readJson("library.json", []);
  const game = library.find(g => g.id === id);
  if (!game) return;
  Object.assign(game, patch);
  writeJson("library.json", library);
}

function removeGame(id) {
  writeJson("library.json", readJson("library.json", []).filter(g => g.id !== id));
  if (/^local-[0-9a-f]+$/.test(id)) {
    for (const ext of [".json", ".png"]) fs.rmSync(localSnapshotPath(id, ext), { force: true });
  }
}

// ---------- local projects ----------
//
// The runner loads a game id by fetching https://arcade.makecode.com/api/<id>/text, a JSON map
// of the project's files. A local project gets a made-up id ("local-...") and that request is
// answered from the file on disk (see handleLocalApi), so it runs through exactly the same
// compile path as a shared game. Each play re-reads the file and uses an id that includes a
// hash of the contents, so edits show up and the runner never reuses a stale build.

const LOCAL_API = /^https:\/\/([a-z0-9-]+\.)?makecode\.com\/api\/(local-[0-9a-f]{10}(?:-[0-9a-f]{10})?)(?:\/([a-z]+))?(?:[?#].*)?$/;
const localRuns = new Map(); // run id -> files map as JSON text

function localSnapshotPath(id, ext) {
  return path.join(dataDir, "local-projects", id + ext);
}

function saveLocalSnapshot(id, project) {
  fs.mkdirSync(path.join(dataDir, "local-projects"), { recursive: true });
  fs.writeFileSync(localSnapshotPath(id, ".json"), JSON.stringify(project.files));
  if (project.thumbnail) fs.writeFileSync(localSnapshotPath(id, ".png"), project.thumbnail);
}

async function addLocalGame(filePath) {
  const project = await readLocalProject(filePath);
  const library = readJson("library.json", []);
  const existing = library.find(g => g.kind === "local" && g.path === filePath);
  if (existing) {
    saveLocalSnapshot(existing.id, project);
    return existing;
  }
  const game = {
    id: "local-" + crypto.randomBytes(5).toString("hex"),
    kind: "local",
    path: filePath,
    title: project.title,
    description: "",
    addedAt: new Date().toISOString()
  };
  saveLocalSnapshot(game.id, project);
  library.push(game);
  writeJson("library.json", library);
  warmCache(game.id); // compile once now: checks the project and caches the runner for offline use
  return game;
}

// Re-read the original file when it's still there (so edits show up); otherwise play the
// copy saved when it was added, e.g. after the USB stick it came from is gone.
async function prepareLocalRun(game) {
  let files = null;
  try {
    const project = await readLocalProject(game.path);
    files = project.files;
    saveLocalSnapshot(game.id, project);
  } catch (e) {
    try { files = JSON.parse(fs.readFileSync(localSnapshotPath(game.id, ".json"), "utf8")); }
    catch (e2) { throw e instanceof ProjectError ? e : new Error(`Can't read ${game.path}`); }
  }
  const text = JSON.stringify(files);
  const runId = `${game.id}-${crypto.createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
  localRuns.set(runId, text);
  return runId;
}

async function playUrl(id) {
  const game = readJson("library.json", []).find(g => g.id === id);
  if (game && game.kind === "local") return runUrl(await prepareLocalRun(game));
  return runUrl(id);
}

// Answers the runner's API requests for local ids. Returns null for anything else.
function handleLocalApi(request) {
  const m = LOCAL_API.exec(request.url);
  if (!m) return null;
  const [, , id, what] = m;
  // no-store: the file on disk (and its thumbnail) can change between requests.
  const reply = (body, type, status = 200) => new Response(body, { status, headers: { "content-type": type, "cache-control": "no-store" } });
  if (what === "text" && localRuns.has(id)) return reply(localRuns.get(id), "application/json; charset=utf-8");
  if (what === "thumb") {
    try { return reply(fs.readFileSync(localSnapshotPath(id, ".png")), "image/png"); }
    catch (e) { /* no thumbnail */ }
  }
  if (!what) return reply(JSON.stringify({ kind: "script", id, target: "arcade", name: id, meta: {} }), "application/json; charset=utf-8");
  return reply("Not found", "text/plain", 404);
}

// Load the game once in a hidden window so the runner, compiler, simulator and
// project source all land in the cache. Resolves when the simulator is running.
const warming = new Set();
async function warmCache(id) {
  if (OFFLINE || warming.has(id)) return;
  warming.add(id);
  const hidden = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  hidden.webContents.setAudioMuted(true);
  let ok = false;
  try {
    await hidden.loadURL(await playUrl(id));
    ok = await waitForSim(hidden.webContents, 90000);
    if (ok && id.startsWith("local-")) await saveScreenThumbnail(id, hidden.webContents);
  } catch (e) {
    console.warn("warm cache failed", id, e.message);
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
    warming.delete(id);
  }
  if (ok) updateGame(id, { cachedAt: new Date().toISOString() });
  send("library:changed");
}

// Local projects have no MakeCode thumbnail, so use the game's opening screen
// (unless the project came with a picture, e.g. a .png save).
async function saveScreenThumbnail(id, contents) {
  const file = localSnapshotPath(id, ".png");
  if (fs.existsSync(file)) return;
  const frame = findSimFrame(contents);
  if (!frame) return;
  await new Promise(r => setTimeout(r, 1500)); // let the first frames draw
  try {
    const url = await frame.executeJavaScript(`(function(){
      var c = document.getElementById("game-screen");
      if (!c || !c.width) return null;
      var d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (var i = 3; i < d.length; i += 4) if (d[i]) return c.toDataURL("image/png");
      return null;
    })()`);
    if (url) fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
  } catch (e) { /* no thumbnail is fine */ }
}

// ---------- simulator frame access ----------

function findSimFrame(contents) {
  if (!contents || contents.isDestroyed()) return null;
  return contents.mainFrame.framesInSubtree.find(f => !f.detached && f.url.includes("---simulator")) || null;
}

async function simReady(contents) {
  const frame = findSimFrame(contents);
  if (!frame) return false;
  try {
    return await frame.executeJavaScript(
      "(function(){try{return !!(window.pxsim&&pxsim.runtime&&pxsim.runtime.running&&pxsim.board())}catch(e){return false}})()");
  } catch (e) { return false; }
}

async function waitForSim(contents, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await simReady(contents)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// Strip the console skin so only the game screen shows, scaled to the window.
// Constructed stylesheets are used because the pages' CSP may block <style> tags.
const RUN_CSS = `
html, body { margin: 0 !important; height: 100% !important; background: #000 !important; overflow: hidden !important; }
#wrap, #simulators { height: 100% !important; margin: 0 !important; padding: 0 !important; }
.simframe { position: fixed !important; inset: 0 !important; padding: 0 !important; margin: 0 !important; width: 100vw !important; height: 100vh !important; }
.simframe > iframe { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; border: 0 !important; }
#footer, .videoplay { display: none !important; }
`;
const SIM_CSS = `
html, body { margin: 0 !important; background: #000 !important; overflow: hidden !important; cursor: none !important; }
/* The skin's wrappers clip and (via transform) re-anchor position:fixed, so flatten them. */
#wrap, .game-player, .game-embed { transform: none !important; filter: none !important; contain: none !important;
  clip-path: none !important; mask: none !important;
  overflow: visible !important; background: transparent !important; border: 0 !important; border-radius: 0 !important;
  box-shadow: none !important; padding: 0 !important; margin: 0 !important; }
.game-sys-button-group, #game-buttons-container, #joystick-container, .game-player-background,
.game-player-msft, #debug-stats, #safari-enable-game { display: none !important; }
#game-screen { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important;
  object-fit: contain !important; image-rendering: pixelated !important; border: 0 !important;
  border-radius: 0 !important; box-shadow: none !important; transform: none !important;
  background: #000 !important; z-index: 1000 !important; }
`;

function cssInjector(css) {
  return `(function(){
    if (window.__arcadeCss) return true;
    window.__arcadeCss = true;
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(${JSON.stringify(css)});
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
    return true;
  })()`;
}

// Keeps keyboard events away from the game pages' own handlers. Without it a focused
// simulator would also act on its built-in keymap, on top of the shell's bindings.
// Text fields are left alone so game.askForString can still be typed into.
const KEY_BLOCKER = `(function(){
  if (window.__arcadeKeysBlocked) return true;
  window.__arcadeKeysBlocked = true;
  var block = function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  ["keydown", "keyup", "keypress"].forEach(function (type) { window.addEventListener(type, block, true); });
  return true;
})()`;

function onFrameLoaded(_event, _isMainFrame, processId, routingId) {
  const frame = webFrameMain.fromId(processId, routingId);
  if (!frame) return;
  const css = frame.url.includes("---simulator") ? SIM_CSS : frame.url.includes("---run") ? RUN_CSS : null;
  if (!css) return;
  frame.executeJavaScript(cssInjector(css)).catch(() => {});
  frame.executeJavaScript(KEY_BLOCKER).catch(() => {});
}

// Arcade key codes from the simulator (pxsim.Key): P1 Left..Menu = 1..7, +7 per extra player.
// Reset (-3) restarts the game on release.
function setSimButton(key, pressed) {
  const frame = findSimFrame(win && win.webContents);
  if (!frame) return;
  const code = `(function(){try{var b=pxsim.board();b&&b.setButton(${key | 0},${pressed ? "true" : "false"})}catch(e){}})()`;
  frame.executeJavaScript(code).catch(() => {});
}

// ---------- window + IPC ----------

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1024,
    height: 800,
    backgroundColor: "#000000",
    title: "Arcade Player",
    kiosk: KIOSK,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, "shell", "index.html"));
  win.webContents.on("did-frame-finish-load", onFrameLoaded);
  // Key-ups are lost while the window is unfocused; drop held keys so nothing sticks.
  win.on("blur", () => send("input:clear"));

  // All keyboard input passes through here first, whichever frame has focus.
  // In a game, keys go to the shell's input mapper, so every binding comes from one config.
  // Don't preventDefault() game keys here: Chromium then drops the matching keyUp before
  // this handler sees it, and keys stick down. The page-side copies are blocked instead
  // (the shell ignores them in game; KEY_BLOCKER stops them inside the game frames).
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.code === "F11" && !KIOSK) {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
      return;
    }
    if (input.type === "keyDown" && input.code === "F12" && input.control && input.shift) {
      win.webContents.toggleDevTools();
      return;
    }
    if (!inGame || input.isAutoRepeat) return;
    if (input.type === "keyDown" || input.type === "keyUp") send("input:key", input.code, input.type === "keyDown");
  });
}

ipcMain.handle("library:list", () => libraryWithStatus());
ipcMain.handle("library:add", async (_e, input) => {
  try { return { ok: true, game: await addGame(input) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("library:addPath", async (_e, filePath) => {
  try { return { ok: true, game: await addLocalGame(filePath) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("library:openDialog", async (_e, kind) => {
  const result = await dialog.showOpenDialog(win, kind === "folder"
    ? { title: "Open a MakeCode project folder", properties: ["openDirectory"] }
    : {
      title: "Open a MakeCode Arcade project",
      properties: ["openFile"],
      filters: [
        { name: "MakeCode projects", extensions: ["png", "uf2", "zip", "arcade", "mkcd", "ts", "elf", "hex", "json"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  try { return { ok: true, game: await addLocalGame(result.filePaths[0]) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("library:remove", (_e, id) => { removeGame(id); return true; });
ipcMain.handle("library:warm", (_e, id) => { warmCache(id); return true; });
ipcMain.handle("controls:get", () => readJson("controls.json", null));
ipcMain.handle("controls:set", (_e, value) => { writeJson("controls.json", value); return true; });
ipcMain.handle("app:info", () => ({ offline: OFFLINE, kiosk: KIOSK, dataDir }));

ipcMain.handle("game:start", async (_e, id) => {
  let url;
  try { url = await playUrl(id); }
  catch (e) { return { ok: false, error: e.message }; }
  inGame = true;
  updateGame(id, { lastPlayedAt: new Date().toISOString() });
  return { ok: true, url };
});
ipcMain.handle("game:stop", () => { inGame = false; return true; });
ipcMain.handle("game:ready", () => simReady(win && win.webContents));
ipcMain.handle("game:markCached", (_e, id) => { updateGame(id, { cachedAt: new Date().toISOString() }); return true; });
ipcMain.on("game:button", (_e, key, pressed) => setSimButton(key, pressed));
ipcMain.on("app:quit", () => app.quit());

app.whenReady().then(() => {
  dataDir = app.getPath("userData");
  cache = new RequestCache(path.join(dataDir, "offline-cache"), { offline: OFFLINE });
  session.defaultSession.protocol.handle("https", req => handleLocalApi(req) || cache.handle(req));
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on("window-all-closed", () => app.quit());
