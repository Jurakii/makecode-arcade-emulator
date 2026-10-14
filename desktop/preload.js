// The shell page's only door into the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("player", {
  listGames: () => ipcRenderer.invoke("library:list"),
  addGame: input => ipcRenderer.invoke("library:add", input),
  openProject: kind => ipcRenderer.invoke("library:openDialog", kind),
  addProjectFile: file => ipcRenderer.invoke("library:addPath", webUtils.getPathForFile(file)),
  removeGame: id => ipcRenderer.invoke("library:remove", id),
  saveOffline: id => ipcRenderer.invoke("library:warm", id),
  getControls: () => ipcRenderer.invoke("controls:get"),
  setControls: value => ipcRenderer.invoke("controls:set", value),
  info: () => ipcRenderer.invoke("app:info"),

  startGame: id => ipcRenderer.invoke("game:start", id),
  stopGame: () => ipcRenderer.invoke("game:stop"),
  gameReady: () => ipcRenderer.invoke("game:ready"),
  markCached: id => ipcRenderer.invoke("game:markCached", id),
  setButton: (key, pressed) => ipcRenderer.send("game:button", key, pressed),
  quit: () => ipcRenderer.send("app:quit"),

  getUpdate: () => ipcRenderer.invoke("update:get"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdate: fn => ipcRenderer.on("update:status", (_e, state) => fn(state)),

  onKey: fn => ipcRenderer.on("input:key", (_e, code, down) => fn(code, down)),
  onClearInput: fn => ipcRenderer.on("input:clear", () => fn()),
  onLibraryChanged: fn => ipcRenderer.on("library:changed", () => fn())
});
