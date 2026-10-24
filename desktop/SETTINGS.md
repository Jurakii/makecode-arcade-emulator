# Settings: how it's built

The Settings screen is opened from the **Settings** button in the library header. Each row is a button, so it works with the keyboard, the mouse and the arcade stick (move with the stick, press **A** to toggle or run it, **Done** or **Esc** to go back).

Settings are saved to `settings.json` in the data folder (`%APPDATA%\arcade-desktop-player`, or `ARCADE_PLAYER_DATA`). Only the keys listed below are used; missing keys take their defaults.

## The settings

| Key | Label in the app | Default | What it does |
|---|---|---|---|
| `startWithWindows` | Start with Windows | off | Registers the app as a login item (`app.setLoginItemSettings`). Installed app only: a dev checkout would register `electron.exe`. |
| `startFullscreen` | Start full screen | off | Opens the window full screen. F11 still toggles it while running. Ignored in `--kiosk`, which is always full screen. |
| `hideTips` | Hide tips | off | Hides every instruction line (anything marked `tip`). The page sets a `hide-tips` class on `<body>`. |
| `saveMissingOnStart` | Save missing games at startup | on | 15 seconds after launch, runs the same job as **Run Save For Offline** for every game not yet saved. |
| `autoUpdate` | Check for updates automatically | on | Turns off the 5-second and 6-hourly timed update checks. "Check for updates now" still works. |
| `verbose` | Verbose (Advanced section) | off | Game cards show their offline status and source file as text. Off shows a dot before the title: green = ready offline, yellow = not saved yet (pulses while saving). |

Two actions sit next to them:

- **Check for updates now** calls the updater directly.
- **Run Save For Offline** saves every game that isn't saved yet. It shows "N to save" on its row and "All saved" when there's nothing left to do.
- **Controls** opens the existing controls screen.
- **Games** lists every game with a **Remove** row, and **System** has **Shut down this PC** and **Restart this PC** (Windows `shutdown /s` or `/r /t 0`, via `system:power` in `main.js`). Both need a second press: the row turns red and reads "Press again to …". Pressing any other row cancels it.

## Where the code lives

| Piece | File |
|---|---|
| Defaults, read/write, login item | `main.js`: `DEFAULT_SETTINGS`, `getSettings`, `setSettings`, `applyLoginItem` |
| Fullscreen at start | `main.js`: `createWindow`, the `fullscreen:` option |
| Offline save of all games | `main.js`: `saveAllOffline`, `queuedSaves`; `warmCache` now returns whether the save worked |
| Startup retry | `main.js`: the `whenReady` handler (`setTimeout(saveAllOffline, 15000)`) |
| Update on/off and manual check | `updater.js`: `initUpdater({ autoCheckEnabled })`, `checkForUpdatesNow` |
| IPC bridge | `preload.js`: `getSettings`, `setSettings`, `saveAllOffline`, `checkForUpdates` |
| Screen and rows | `shell/index.html` (`#settings-view`), `shell/app.js` (`TOGGLES`, `renderSettings`), `shell/style.css` (`.setting-row`, `body.hide-tips .tip`) |
| Controller navigation (every screen) | `shell/app.js`: `navTargets`, `moveFocus`, `goBack`, `navTick`; `shell/input.js`: `menuState` |

To add another on/off setting:

1. Add its default to `DEFAULT_SETTINGS` in `main.js`.
2. Add a `[key, label, description]` entry to `TOGGLES` in `shell/app.js`.
3. Act on it where it matters. For a setting read on each use, call `getSettings()` at that point. For one that applies at startup, read it in `createWindow` or `whenReady`.
4. Mark any instruction text you add with `class="tip"` so **Hide tips** covers it.

No IPC change is needed for a toggle: `setSettings({ [key]: value })` merges the patch and saves it.

## The offline save bug

**Symptom:** some games never became "Saved for offline", and nothing in the app would retry them.

**Cause:** a game is saved once, in the background, when it's added (`addGame` / `addLocalGame` call `warmCache`). If that attempt failed (no network, the 90-second load timeout, or a MakeCode error), the failure was only logged. Nothing retried it, and the `saveOffline` bridge that could have started a retry had no button behind it.

**Fix:**

- **Run Save For Offline** calls `saveAllOffline`. It saves games one at a time (each opens a hidden window, so running them together would be heavy on a cabinet PC), and each card shows "Saving for offline…" while it runs.
- It runs again 15 seconds after startup if **Save missing games at startup** is on.
- A second run while one is in progress reports how many games are left instead of starting another.

I couldn't reproduce the exact failing games, so this fix covers the retry path, not the specific MakeCode response that caused the failure. If a game still won't save, check its card and the console output of `npm start` (the `warm cache failed` line gives the reason).

## Auto-updates (already in place)

The app already updates itself from GitHub, through `updater.js` (electron-updater) and `.github/workflows/release.yml`. It checks the GitHub Releases feed for the repository, not the source tree, because installed copies need a built installer and `latest.yml`. Pushing a `v*` tag, or running the **Release** workflow, publishes the installer. Installed copies download the update in the background and install it on the next restart. The release steps are in the [README](README.md#updates-and-releases).

So the setting only controls whether the app checks on its own. Two things a cabinet owner might still expect:

- Updates **only work for a public repository**, because electron-updater reads the releases without a token.
- Turning off **Check for updates automatically** doesn't cancel an update that has already downloaded. It still installs on quit.

## Testing

1. `npm start`, then open **Settings**. Check that each toggle flips between On and Off, and that the choice survives a restart (look in `settings.json`).
2. Set **Hide tips** on. The footer hint, the drop hint and the Controls notes should disappear.
3. Set **Start full screen** on, restart, and confirm the window opens full screen.
4. Packaged build only: set **Start with Windows** on and check the Windows startup list (Settings → Apps → Startup).
5. Add a game while offline, so its save fails. Go back online, run **Run Save For Offline**, and check that its card goes from "Local file" or "Not saved for offline yet" to "Saved for offline".
6. Run it with the arcade stick only, to confirm the settings rows can be reached and toggled without a keyboard.
