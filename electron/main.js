// Electron wrapper for JobPilot.
//
// This turns the existing Express server into a normal desktop app:
//   • starts server/index.js on 127.0.0.1:4310 inside the app process
//   • opens it in a native window (no browser, no terminal, no localhost URL)
//   • keeps running in the system tray when the window is closed, so the
//     follow-up / inbox / auto-search schedulers keep working in the background
//   • checks for updates from GitHub Releases when packaged
//
// The server code is untouched — we just launch and frame it.
const path = require('path');
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron');

const PORT = process.env.PORT || 4310;
const APP_URL = `http://127.0.0.1:${PORT}`;
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

let mainWindow = null;
let tray = null;
let serverInstance = null;
let isQuitting = false;

// Only one copy of JobPilot at a time — a second launch just focuses the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init);
}

function init() {
  startServer();
  createTray();
  createWindow();
  app.on('activate', () => {
    // macOS dock click with no windows open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
  setupAutoUpdate();
}

function startServer() {
  try {
    const { start } = require(path.join(__dirname, '..', 'server', 'index.js'));
    serverInstance = start();
    serverInstance.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        // A JobPilot server is already listening on this port (e.g. started
        // from a terminal) — just frame it instead of failing.
        console.warn(`Port ${PORT} already in use — attaching to the existing server.`);
        return;
      }
      dialog.showErrorBox('JobPilot could not start', String((err && err.stack) || err));
    });
  } catch (err) {
    dialog.showErrorBox('JobPilot could not start', String((err && err.stack) || err));
  }
}

function createWindow() {
  if (mainWindow) return showWindow();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'JobPilot',
    icon: ICON_PATH,
    backgroundColor: '#0f1226',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loadAppWithRetry(mainWindow);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links (job postings, "get a free key" pages) in the real
  // browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides to tray so background schedulers keep running.
  // Real quit happens from the tray menu (sets isQuitting).
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// The server binds asynchronously; retry the load until it answers so the
// user never sees a "can't reach localhost" error on a cold start.
function loadAppWithRetry(win, attempt = 0) {
  win.loadURL(APP_URL).catch(() => {});
  win.webContents.once('did-fail-load', () => {
    if (attempt < 40 && !win.isDestroyed()) {
      setTimeout(() => loadAppWithRetry(win, attempt + 1), 250);
    }
  });
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  let img = nativeImage.createFromPath(ICON_PATH);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('JobPilot — running in the background');
  const menu = Menu.buildFromTemplate([
    { label: 'Open JobPilot', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Quit JobPilot',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

// Keep running in the tray after the window is closed (Windows/Linux).
app.on('window-all-closed', () => {
  // Intentionally do nothing: the app lives on in the tray so schedulers run.
  // Quit is driven from the tray menu.
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverInstance) {
    try { serverInstance.close(); } catch { /* non-fatal */ }
  }
});

function setupAutoUpdate() {
  if (!app.isPackaged) return; // updates only make sense for installed builds
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // electron-updater not installed — silently skip
  }
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', () => {
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        title: 'Update ready',
        message: 'A new version of JobPilot has been downloaded. Restart to update?'
      })
      .then(({ response }) => {
        if (response === 0) {
          isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
  });
  autoUpdater.checkForUpdatesAndNotify().catch(() => { /* offline etc. — ignore */ });
}
