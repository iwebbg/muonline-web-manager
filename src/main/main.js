import { app, BrowserWindow, ipcMain, shell, session, dialog } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Backend } from './backend.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(directory, '../renderer/index.html');
const rendererUrl = pathToFileURL(renderer).href;
const links = new Set(['https://buymeacoffee.com/interweb.bg', 'https://ko-fi.com/interwebltd', 'https://paypal.me/interwebltd']);
let window;
let backend;

/** Verify the exact main frame and bound IPC payloads before privileged dispatch. */
function validateSender(event, input) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl) {
    throw new Error('Untrusted IPC sender.');
  }
  if (JSON.stringify(input ?? {}).length > 32768) {
    throw new Error('IPC payload exceeds limit.');
  }
}

/** Open the persistent panel with a sandboxed renderer and a minimal preload bridge. */
function createWindow() {
  window = new BrowserWindow({ width: 1240, height: 900, minWidth: 950, minHeight: 700, backgroundColor: '#0c1423', webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (backend?.busy) {
      event.preventDefault();
      dialog.showMessageBox(window, { type: 'info', message: 'An operation is running. Wait for it to finish before closing the panel.' });
    }
  });
  window.loadFile(renderer);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      window.show();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    const resources = app.isPackaged ? process.resourcesPath : path.resolve(directory, '../..');
    backend = new Backend(resources, app.getPath('userData'), app.isPackaged ? path.join(resources, 'trust.json') : path.join(resources, 'build/trust.json'));
    await backend.initialize();
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle('manager:invoke', async (event, action, input) => {
      try {
        validateSender(event, input);
        const result = await backend.invoke(action, input);
        if (action === 'updateManager') {
          setTimeout(() => app.quit(), 200);
        }
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    ipcMain.handle('manager:link', async (event, target) => {
      validateSender(event, target);
      if (!links.has(target)) {
        throw new Error('External link is not allowed.');
      }
      await shell.openExternal(target);
    });
    createWindow();
  }).catch(() => {
    dialog.showErrorBox('Manager startup failed', 'Cannot load the manager resources or trust configuration. Reinstall the manager or inspect the public trust JSON.');
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
