// Auto-update from GitHub Releases (published by .github/workflows/release.yml).
//
// Checks shortly after launch and every few hours, downloads in the background, and installs
// when the app quits, so a cabinet updates itself on its next restart. The shell can also
// offer "Restart to update" once a download is ready. Only runs in the installed app: a dev
// checkout (npm start) has no release to compare against.
//
// ARCADE_UPDATE_URL=<url> points at a generic update server instead (folder with latest.yml
// and the installer), for testing the update flow without publishing a release.
const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

const CHECK_DELAY_MS = 5000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let state = { status: "idle", version: app.getVersion() };
let notify = () => {};

function setState(patch) {
  state = Object.assign({}, state, patch);
  notify(state);
}

function initUpdater({ onChange, offline }) {
  notify = onChange;
  const testFeed = process.env.ARCADE_UPDATE_URL;
  if ((!app.isPackaged && !testFeed) || offline) {
    setState({ status: "disabled" });
    return;
  }
  if (testFeed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: testFeed });
  }
  autoUpdater.disableWebInstaller = true; // releases ship the full NSIS installer
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: m => console.log("[updater]", m), warn: m => console.warn("[updater]", m), error: m => console.error("[updater]", m), debug: () => {} };

  autoUpdater.on("checking-for-update", () => setState({ status: "checking" }));
  autoUpdater.on("update-not-available", () => setState({ status: "current" }));
  autoUpdater.on("update-available", info => setState({ status: "downloading", newVersion: info.version, percent: 0 }));
  autoUpdater.on("download-progress", p => setState({ status: "downloading", percent: Math.round(p.percent || 0) }));
  autoUpdater.on("update-downloaded", info => setState({ status: "ready", newVersion: info.version }));
  // Offline or GitHub unreachable: stay quiet and try again at the next check.
  autoUpdater.on("error", err => setState({ status: "error", error: String(err && err.message || err).split("\n")[0] }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, CHECK_DELAY_MS);
  setInterval(check, CHECK_EVERY_MS);
}

function updateState() {
  return state;
}

function installUpdate() {
  if (state.status !== "ready") return false;
  // isSilent: no installer UI; isForceRunAfter: reopen the app when done.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

module.exports = { initUpdater, updateState, installUpdate };
