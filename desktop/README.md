# Arcade Player (desktop prototype)

A desktop app that plays MakeCode Arcade games full screen, works offline after a game's first load, and takes input from USB arcade controls.

## Run it

Needs Node.js. Electron installs on first run.

```bash
npm install
npm start
```

Or double-click `Arcade Player.cmd`.

| Option | What it does |
|---|---|
| `npm run start:kiosk` (or `--kiosk`) | Full screen, no window frame. Good for a cabinet. |
| `npm run start:offline` (or `--offline`) | Cache only, never touches the network. Use it to check which games will work offline. |
| `ARCADE_PLAYER_DATA=<folder>` | Keep the library, controls and cache in that folder instead of the user profile, e.g. for a portable install on a USB stick. |

## Using it

1. Paste a share link (`https://makecode.com/_xxxx` or `https://arcade.makecode.com/12345-...`) and press **Add game**. The game is saved for offline play in the background, and its card shows "Saved for offline" when that's done.
2. Or add a game from your computer with **Open file…** / **Open folder…**, or drop it onto the window (see [Local projects](#local-projects)).
3. Pick a game with the stick or arrow keys, then press **A** or Enter.
4. To leave a game, hold **Menu + B** for 1.5 seconds or press Esc. F11 toggles full screen.
5. **Controls** → **Learn all buttons**: press each control on your panel when asked. The "Connected controllers" panel shows the raw button numbers and axes, so you can check the wiring.

## Local projects

| What you have | Where it comes from |
|---|---|
| `.png` | The Arcade editor's save button (the project is hidden in the image) |
| `.uf2`, `.elf`, `.hex` | **Download** for hardware. The game's source is embedded in the firmware |
| Project folder | A folder with `pxt.json` and `main.ts`, as used by VS Code or a GitHub repo. A folder with just `main.ts` works too |
| `.zip`, `.arcade` | A zipped project folder. A GitHub **Download ZIP** works as-is |
| `.ts` | A single code file, such as `main.ts` copied out of the editor |
| `.mkcd`, `.json` | Project exports |

Every time you play a local game, its file is read again, so edits show up on the next play. A copy is also saved when you add it, so the game still plays if the original file is gone (for example, a USB stick that's been unplugged).

Local games compile in MakeCode's runner like any other game. The runner itself has to have been downloaded once, which happens the first time you play or add any game online.

## How it works

- **Games run in the official MakeCode simulator**, loaded from `arcade.makecode.com/---run?id=…`. That gives full compatibility, extensions included, with no compiler of our own. The page is restyled so only the game screen shows, scaled to the window.
- **Input bridge.** The official simulator has no gamepad support; it only reads the keyboard. The shell page (`shell/`) reads the keyboard and the Gamepad API and turns them into Arcade buttons. `main.js` then calls `pxsim.board().setButton(key, pressed)` inside the simulator frame, the same function the simulator's own keyboard handler uses. While a game is running, all keys go to the bridge, so one config controls everything.
- **Arcade encoders.** Zero Delay, DragonRise and Xin-Mo boards appear as generic HID gamepads. The defaults handle all three ways these report the stick: axes 0/1, d-pad buttons, or a POV hat packed into one axis (Chrome reports a centred hat as about 3.29). Keyboard encoders (I-PAC style) work through key bindings; MAME's L-Ctrl / L-Alt / 1 are bound by default.
- **Players.** Up to 4. Each player picks a controller slot; Arcade key codes are P1 1–7, +7 for each extra player.
- **Local projects** (`local-project.js`). Each format is turned into the same file map that MakeCode's share API returns. The game gets a made-up id (`local-…`), and the app answers the runner's `/api/<id>/text` request from the file, so local games use exactly the same compile path as shared ones. The id includes a hash of the contents, so the runner never reuses an old build. The decoders are ports of MakeCode's own code: `pxtlib/util.ts` `decodeBlobAsync` for PNGs, and `pxtlib/cpp.ts` for the source embedded in firmware. Decompression uses the same `lzma` library MakeCode uses.
- **Offline cache** (`cache.js`). Every request to MakeCode hosts is saved to disk. Content-addressed CDN files are cache-first; pages and project source are network-first with the cache as fallback, matched ignoring the query string because the runner adds a daily `?cdn=` parameter.

## Files

| File | Role |
|---|---|
| `main.js` | Window, offline cache hookup, game library, injecting into the simulator frame |
| `cache.js` | Disk cache for MakeCode requests |
| `local-project.js` | Reads local projects: folder, zip, png, uf2/elf/hex, mkcd, ts |
| `preload.js` | API the shell page can call |
| `shell/input.js` | Keyboard and controller mapping, hat decoding, Learn detection |
| `shell/app.js` | Library, in-game input loop, controls screen |

Data (library, `controls.json`, `offline-cache/`, `local-projects/`) is stored in `%APPDATA%\arcade-desktop-player` unless `ARCADE_PLAYER_DATA` is set.

## Tested so far

Tested with the sample game (`_DLxgpzWtWgkc`) on Windows 10:

- Adding the game, the background offline save, playing it, keyboard movement, and leaving with Esc.
- Keys release properly: the sprite stops when the key is let go. This was confirmed by hand on a real keyboard after fixing a bug where keys stuck down.
- A simulated arcade encoder (generic HID, hat on axis 9, 12 buttons):
  - Hat movement reaches the game.
  - **A** launches a game from the library.
  - Holding **Menu + B** quits.
  - Learn mode records hat directions and button numbers.
- Replaying the game in `--offline` mode.
- **Local projects.** Each of these was added through the same path as drag and drop, played in the runner, and checked by reading the game screen's colour:
  - a project folder, a GitHub-style zip, and a lone `.ts` file;
  - a `.png` made by MakeCode's own encoder (`pxt.Util.encodeBlobAsync`);
  - a `.uf2` and a `.hex` built to pxt's source-embedding layout.
- **Editing a local project.** After an edit, the next play shows the change, including in `--offline` mode.

**Not yet tested:**

- **Physical USB controllers.** This is the main open question. Real devices could behave differently from the simulated one.
- **Games that use A/B, multiple players, or extensions.** The sample game only uses movement.
- **A `.uf2` downloaded from the editor for real hardware.** MakeCode's `---run?hex=1` mode is broken upstream (`options is not defined`), so the test file was built from pxt's writer code instead.
- **"Open folder…" by hand.** The native dialog can't be automated here. Folders added through the drop path were tested.

## Known limits

- The first load of a game needs internet. After that, it plays offline. For local projects, only the runner needs to have been downloaded.
- Local projects that use GitHub extensions need internet the first time, to fetch the extension.
- Controller navigation in the library covers the game cards only. Use a mouse or keyboard for Add, Controls and Quit. In kiosk mode, Alt+F4 quits.
- Holding Menu to quit also opens the game's own menu briefly before the game closes.
- This depends on MakeCode's hosted runner and simulator internals (`pxsim.board().setButton`, the simulator's CSS class names). A MakeCode update could break the restyling or the input bridge, and both would need small fixes in `main.js`.
