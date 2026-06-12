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
  readProduction: (file, opts) => SAVE.readProduction(file, opts),
  readProductionRecords: (file) => SAVE.readProductionRecords(file),
  // Durable plan storage in userData (see main.js). loadPlans is synchronous so the
  // renderer can read it during its boot load(); savePlans is fire-and-forget.
  loadPlans: () => { try { return ipcRenderer.sendSync('plans:load'); } catch (_) { return null; } },
  savePlans: (json) => { try { ipcRenderer.send('plans:save', json); } catch (_) {} },
  // Blocking save for the renderer's beforeunload flush — the async path can be
  // outrun by app quit, dropping the last edit (see main.js plans:save-sync).
  savePlansSync: (json) => { try { return ipcRenderer.sendSync('plans:save-sync', json); } catch (_) { return false; } },
  // Open external (http/https) links in the OS browser; ignore anything else so a
  // crafted string can't drive shell.openExternal to a file:/custom-scheme handler.
  openExternal: (url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url); },
  // Update notifier: main.js sends 'update-available' after polling GitHub Releases.
  // Forward the (cloned) payload to the renderer's callback; never expose ipcRenderer.
  onUpdateAvailable: (cb) => { if (typeof cb === 'function') ipcRenderer.on('update-available', (_e, info) => cb(info)); },
  // Newest-save notifier: main.js watches the save folder and sends 'save-newest' when a
  // new/updated .sav appears, so the renderer can auto-reload alternates + map.
  onSaveNewest: (cb) => { if (typeof cb === 'function') ipcRenderer.on('save-newest', (_e, info) => cb(info)); },
  // Re-launch notifier: main.js sends 'second-instance' when another copy of the app
  // was started and got folded into this window — the renderer uses it to self-heal
  // a blank-fallback session before the user sees it (see healFromDiskIfRicher).
  onSecondInstance: (cb) => { if (typeof cb === 'function') ipcRenderer.on('second-instance', () => cb()); },
});
