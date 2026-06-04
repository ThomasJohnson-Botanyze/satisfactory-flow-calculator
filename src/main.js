const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

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
  win.webContents.once('did-finish-load', () => checkForUpdate(win));
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
