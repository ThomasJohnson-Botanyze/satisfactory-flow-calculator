'use strict';
// Preload bridge. The window runs with contextIsolation:true and nodeIntegration:
// false, so the renderer has no `require`/Node access. This file runs in an
// isolated context that DOES have Node, and exposes a small, explicit API on
// window.api via contextBridge — the only surface the renderer can reach.
//
// Only three read-only save helpers and an external-link opener are exposed; no
// generic fs/shell/ipc access leaks to the page. save-reader does the heavy
// fs+parse work here (off the page's global scope); its results are plain JSON
// objects, so they structured-clone cleanly across the bridge.
const { contextBridge, shell, ipcRenderer } = require('electron');
const SAVE = require('./save-reader');

contextBridge.exposeInMainWorld('api', {
  listSaves: (root) => SAVE.listSaves(root),
  readUnlockedAlternates: (file) => SAVE.readUnlockedAlternates(file),
  readMap: (file) => SAVE.readMap(file),
  // Open external (http/https) links in the OS browser; ignore anything else so a
  // crafted string can't drive shell.openExternal to a file:/custom-scheme handler.
  openExternal: (url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url); },
  // Update notifier: main.js sends 'update-available' after polling GitHub Releases.
  // Forward the (cloned) payload to the renderer's callback; never expose ipcRenderer.
  onUpdateAvailable: (cb) => { if (typeof cb === 'function') ipcRenderer.on('update-available', (_e, info) => cb(info)); },
});
