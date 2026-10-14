# MakeCode Arcade Desktop Emulator: research and prototype

Goal: play MakeCode Arcade games offline on a desktop emulator with arcade controls and other controllers.

## Contents

| Path | What it is |
|---|---|
| [makecode-arcade-export-research.md](makecode-arcade-export-research.md) | Research on export formats (UF2, HEX, PNG, share JSON, project folder), community emulators, and a recommended container design |
| [sample-project/main.ts](sample-project/main.ts) | The sample project's code, copied from the editor. It's the full `main.ts`, including the 16x16 sprite literal |
| [desktop/](desktop/README.md) | **Current prototype.** Electron app that runs Arcade games in the official simulator, from share links or local files (`.png` saves, `.uf2` downloads, project folders, zips). It works offline after a game's first load and maps USB arcade controls (with a Learn screen) |
| [emulator.html](emulator.html) | First prototype: a single-file emulator (canvas, keyboard and gamepad input). It runs the sample project's rules, hand-translated |

Live prototype: https://claude.ai/artifact/UqG5GNMSmGfTDTXMGMKsaN (private to its owner until shared)

## Sample project

- Share link: https://makecode.com/_DLxgpzWtWgkc (redirects to `https://arcade.makecode.com/33433-94119-69965-93942`)
- The share page is a loader, so the code was read from the editor's Monaco model in the browser.
- Not captured: `pxt.json` (project name, dependencies) and any `.jres` assets. The sample uses no separate assets.

## Key findings

1. **Use project source, not UF2, as the emulator's input.** UF2 files are device firmware (native ARM code plus embedded source). They can't run on a PC without an ARM emulator. The research note lists the other formats and why each was rejected.
2. **Container:** a zip with a custom extension holding `pxt.json`, `main.ts`, optional `main.blocks`, `*.jres` / `*.g.jres` assets, and optionally a prebuilt JS bundle. The file layout matches what the editor and VS Code extension already use.
3. **Palette:** the editor's runtime palette (`pxtTargetBundle.palette`) is a 16-color list. Image literal characters map to indices: `.` is transparent, and hex digits `0-9`, `a-f` map to indices 0 to 15. Background `scene.setBackgroundColor(9)` is `#87f2ff`.
4. **Sprite speed and bounds:** `controller.moveSprite` defaults to 100 px per second here. `setStayInScreen(true)` clamps the sprite to the 160x120 screen.
5. **The official simulator has no gamepad support.** Its `sim.js` reads only the keyboard. Its keymap is P1 WASD/arrows, Space/Z/Q = A, Enter/X/E = B; P2 IJKL, U/O. Button state goes through `pxsim.board().setButton(key, pressed)`, where key is 1–7 for P1 Left/Up/Right/Down/A/B/Menu, +7 per extra player. The desktop app injects input there. The simulator source is in a separate repo, `pxt-arcade-sim`, which isn't public, so this comes from the shipped bundle.
6. **Running real games doesn't need our own compiler.** `arcade.makecode.com/---run?id=<id>` fetches `/api/<id>/text`, compiles in the browser, and runs the result in a `---simulator` iframe. It first tries `/api/<id>/js?v=<version>` (404 for the sample). Caching those responses on disk is enough for offline play.

## Desktop prototype (desktop/)

See [desktop/README.md](desktop/README.md). To run it: `cd desktop`, `npm install`, `npm start`.

## First prototype notes (emulator.html)

- The emulator's game logic is a hand translation of `main.ts`. It is not a compiler. A real emulator would run the compiled JS from the simulator build.
- Controls: arrows, WASD, or gamepad D-pad or stick to move. Space, P, or gamepad Start to pause. R or Select to reset. F for fullscreen. `?` shows the key list.
- Buttons A and B aren't used by the sample game, so they do nothing yet.

## Open questions

- Exact share/project JSON shape (not documented in the sources reached).
- License terms for redistributing the simulator. The desktop app avoids this question by loading MakeCode's hosted runner and caching it locally, rather than shipping the bundle. `pxt-arcade` itself is MIT; `pxt-arcade-sim`'s license is unknown.
- How physical USB arcade encoders behave in the desktop app. Only a simulated encoder has been tested.
- Whether the PNG share encoding is stable enough to support.
- Whether the embedded source in UF2 files is reliable as a recovery path.

## Sources

Full source list is in [makecode-arcade-export-research.md](makecode-arcade-export-research.md#sources).
