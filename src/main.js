const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const SAVE = require('./save-reader');

// ---------- durable plan storage ----------
// Plans used to live only in the renderer's localStorage. On file:// pages Chromium
// can reset that store on repackage/relaunch (the Local Storage leveldb gets a fresh
// MANIFEST), which silently wiped saved factories across app updates. We now persist
// to a plain JSON file in userData — outside the app bundle, untouched by reinstalls —
// with localStorage kept only as a fallback/migration source in the renderer.
function plansPath() {
  return path.join(app.getPath('userData'), 'plans.json');
}
// Synchronous load (renderer calls this once at boot via sendSync); returns the raw
// JSON string or null when the file is absent/unreadable.
ipcMain.on('plans:load', (e) => {
  try { e.returnValue = fs.readFileSync(plansPath(), 'utf8'); }
  catch (_) { e.returnValue = null; }
});
// Asynchronous, fire-and-forget save (renderer calls on change, debounced). Write to
// a temp file then rename, so a crash mid-write can never leave a truncated
// plans.json. Writes are SERIALIZED through a promise chain: overlapping saves used
// to race on one shared tmp path (two fds truncating the same file; rename EPERM on
// Windows while the other writer held it open) and failures were silently dropped.
let saveChain = Promise.resolve();
ipcMain.on('plans:save', (_e, json) => {
  if (typeof json !== 'string') return;
  saveChain = saveChain.then(() => new Promise((done) => {
    try {
      const p = plansPath();
      const tmp = p + '.tmp';
      fs.writeFile(tmp, json, (err) => {
        if (err) return done();
        fs.rename(tmp, p, () => done());
      });
    } catch (_) { done(); } /* best-effort; localStorage still holds a copy */
  }));
});
// Synchronous save for quit: the async write above can be outrun by app.quit()
// (window-all-closed fires before the rename lands), silently reverting the last
// edit on next launch. The renderer's beforeunload flush calls this and blocks
// until the bytes are on disk.
ipcMain.on('plans:save-sync', (e, json) => {
  try {
    if (typeof json !== 'string') { e.returnValue = false; return; }
    const p = plansPath();
    const tmp = p + '.tmp-quit';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, p);
    e.returnValue = true;
  } catch (_) { e.returnValue = false; }
});

// GitHub repo polled for the latest published release (update notifier).
const UPDATE_REPO = 'ThomasJohnson-Botanyze/satisfactory-flow-calculator';

// Numeric semver-ish compare: returns >0 if a is newer than b. Tolerates
// missing/extra segments ("1.3" vs "1.2.1") and non-numeric junk (treated 0),
// so a "1.10.0" tag correctly beats "1.9.0" (string compare would not).
function cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Poll GitHub Releases once on launch. If the latest published (non-draft,
// non-prerelease) tag is newer than this build, tell the renderer so it can
// show the "update available" toast. Network / rate-limit failures stay silent
// — a missed check is never worth an error in the user's face.
async function checkForUpdate(win) {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'satisfactory-flow-calculator', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return; // no releases yet (404), rate-limited (403), etc.
    const rel = await res.json();
    if (rel.draft || rel.prerelease) return;
    const latest = String(rel.tag_name || '').replace(/^v/i, '').trim();
    if (latest && cmpVer(latest, app.getVersion()) > 0 && !win.isDestroyed()) {
      win.webContents.send('update-available', { version: latest, url: rel.html_url });
    }
  } catch (_) {
    /* offline, DNS failure, or anon 60-req/hr rate limit — skip silently */
  }
}

// Watch the Satisfactory save folder; when a new/updated .sav lands (e.g. an autosave),
// tell the renderer the newest save so it can auto-reload unlocked alternates + the map.
// Debounced (a save is written over a beat) and best-effort: the folder may be absent and
// recursive watch is platform-limited — a missed event just means a manual reload.
let saveWatcher = null;
function startSaveWatcher(win) {
  let info;
  try { info = SAVE.listSaves(); } catch (_) { return; }
  if (!info || !info.exists || !info.root) return;
  let timer = null;
  try {
    saveWatcher = fs.watch(info.root, { recursive: true }, (_evt, filename) => {
      if (filename && !/\.sav$/i.test(String(filename))) return; // ignore non-save churn
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const cur = SAVE.listSaves();
          const newest = cur && cur.saves && cur.saves[0]; // listSaves sorts newest-first
          if (newest && !win.isDestroyed()) win.webContents.send('save-newest', newest);
        } catch (_) { /* mid-write / folder vanished — next event retries */ }
      }, 1500);
    });
  } catch (_) { /* recursive watch unsupported or root removed */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#15171c',
    title: 'Satisfactory Flow Calculator',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      // Hardened: the page gets no Node access. A small allow-list of save helpers
      // is bridged in via preload.js (contextBridge -> window.api). sandbox stays
      // off so the preload can require the Node-side save-reader (fs + parser).
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ])
  );

  // Hardening (defense-in-depth on top of contextIsolation): the app is a single
  // local page, so open external links in the OS browser rather than an in-app
  // window, and block any navigation away from index.html — so injected content
  // can't load a remote page into the app window at all.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  // Check for a newer release once the page is live and its IPC listener is up.
  win.webContents.once('did-finish-load', () => { checkForUpdate(win); startSaveWatcher(win); });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
