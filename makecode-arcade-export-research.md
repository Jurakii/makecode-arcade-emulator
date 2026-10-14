# MakeCode Arcade: export formats for a custom desktop emulator

Research summary (2026-10-13) for a desktop emulator that runs MakeCode Arcade games offline and supports arcade controls and USB/other controllers.

## Short answer

Don't use `.uf2` as the emulator's input format. Use the **project source plus its assets** (the MakeCode project format: `pxt.json`, `main.ts`, optional `main.blocks`, `*.jres` / `*.g.jres` assets), packed into a single zip with a custom extension. Optionally include a prebuilt JS bundle so the emulator doesn't need the compiler.

## What each export looks like

| Format | What it is | Fit for a desktop emulator |
|---|---|---|
| `.uf2` | Flashing image for SAMD51 boards. 512-byte blocks, each with a 32-byte header, payload, and end magic. Contains native ARM machine code (a precompiled C++ runtime "base" plus the compiled program region) and embeds the project source. | **Poor** as primary input. It's device machine code, so running it on a PC would mean an ARM emulator. Its embedded source is a useful recovery path, but it's not a clean format to target. |
| `.hex` | Intel HEX, used by micro:bit-style targets. | Not confirmed for Arcade. Same problem as UF2 (device binary). |
| PNG (the "disk icon" share) | Project source encoded inside a PNG and re-importable by drag-and-drop. | Viable as a **transport** format, not a clean spec. Parsing it means reverse-engineering the encoding. |
| Share link / project JSON | Share URLs resolve to a project stored in MakeCode's cloud. The project is a set of named text files. | **Good** source of truth. The JSON map of filename to contents mirrors the project folder. Needs a network fetch once; after that it's local. |
| Project folder (`pxt.json`, `main.ts`, `main.blocks`, `*.jres`, `*.g.ts`, `*.g.jres`, `built/`) | The on-disk project layout used by the VS Code extension and the pxt tooling. | **Best** format to standardize on. Human-readable, versionable, and the same layout the editor understands. |
| `.mkcd` | Not an Arcade format. Associated with Minecraft / Chibi Chip editors. | Ignore. |

## Recommended design

1. **Container:** a zip file with a custom extension (for example `.arcade`), containing:
   - `pxt.json` (name, description, dependencies, file list)
   - `main.ts` (the game logic)
   - `main.blocks` (optional, only if the project uses blocks)
   - `*.jres` and `*.g.jres` (assets: images, tilemaps, animations, songs)
   - `*.g.ts` (generated asset bindings; can be regenerated)
   - optionally `game.js` (a prebuilt JS bundle of the compiled program, so the emulator can run without the compiler)
2. **Import path:** accept either a share URL / project JSON (fetch once, store as zip) or a local `.arcade` zip.
3. **Runtime:** build a web-based runtime (Electron or a native shell that embeds a browser engine). The forum discussion notes that the game and runtime are separate entities, and that the runtime is JavaScript-based, so a web-based wrapper is more natural than a native EXE.
4. **Controls:** map keyboard and gamepads to the Arcade button set (directions plus A/B, and any menu buttons). Use the Gamepad API for controllers.

## Open questions to verify before building

- Exact JSON shape of the share/project API (not documented in the sources I could reach).
- Whether the pxt-arcade simulator build output (`built/` / simulator bundle) can be reused as-is, and its license terms. The official sources are the `microsoft/pxt-arcade` and `microsoft/pxt` repos.
- Whether the PNG share encoding is stable enough to be worth supporting.
- Whether the embedded source in UF2 files is reliable enough to serve as a recovery path.

## Existing community work (for reference)

- Electron wrapper that converts Arcade games into an offline app (search GitHub for the converter; repo name not confirmed).
- McAirpos: a Linux executable approach discussed in the MakeCode forum (Raspberry Pi tested).
- arcade-uwp-demo (eanders-ms): a UWP app that runs games. The forum reports an access violation when swapping games. Experimental.
- Official MakeCode Arcade offline app (Windows and Mac, per AlternativeTo). Also self-hostable from the `pxt-arcade` repo.

## Sources

- Download/flash behavior, UF2 drag-and-drop: https://learn.adafruit.com/makecode/downloading-and-flashing?view=all
- Downloading games (CURRENT.UF2 embeds source): https://learn.adafruit.com/makecode-arcade-with-samd51-m4/downloading-games
- Forum: download file: https://forum.makecode.com/t/download-file/25603
- UF2 format spec: https://microsoft.github.io/uf2/ and https://github.com/microsoft/uf2
- PR on native Arcade UF2 base/program layout: https://github.com/CrispStrobe/brickwright-lite/pull/329
- Arcade VS Code extension (project layout, pxt.json, asset files, import by URL): https://arcade.makecode.com/vscode
- Arcade FAQ and publishing: https://arcade.makecode.com/faq , https://arcade.makecode.com/publishing-games
- Target/simulator structure: https://makecode.com/target-creation , https://www.makecode.com/targets/pxtarget
- Emulator discussions: https://forum.makecode.com/t/play-makecode-arcade-game-in-app/10787 , https://forum.makecode.com/t/converting-makecode-arcade-project-to-exe-file-which-can-be-run-as-an-emulator-on-a-computer/10786/4
- Offline app listing: https://alternativeto.net/software/microsoft-makecode-arcade/about
- Source repos: https://github.com/microsoft/pxt-arcade , https://github.com/microsoft/pxt

## Confidence

- High: project folder layout (pxt.json, main.ts, .jres/.g.jres), UF2 structure, and that UF2 files embed source.
- Medium: the native-ARM nature of Arcade UF2s (based on one PR and a forum post, not official docs).
- Low / unverified: exact share API JSON, PNG encoding details, and whether the simulator bundle can be reused directly.
