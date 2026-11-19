import { app, BrowserWindow, ipcMain, shell, session, dialog, Menu, clipboard } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Backend } from './backend.js';
import { acquireDevLock } from './dev-lock.js';
import { runtimeProfile } from './runtime-profile.js';
import { externalLinks } from '../shared/links.js';
import { resolveLocale, translate } from '../shared/i18n.js';

const profile = runtimeProfile(app.isPackaged, process.argv.includes('--dev-wsl'));
if (profile.development) {
  app.setPath('userData', path.join(app.getPath('appData'), 'MuOnline-Web-Manager-Dev'));
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(directory, '../renderer/index.html');
const rendererUrl = pathToFileURL(renderer).href;
const icon = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.resolve(directory, '../../icon.png');
if (process.platform === 'win32') {
  app.setAppUserModelId('bg.interweb.muonline.manager');
}
const links = new Set(Object.values(externalLinks));
let window;
let backend;
let language = 'en';

/** Translate native chrome using the same saved language as the renderer. */
function t(key) {
  return translate(language, key);
}

/** Rebuild native menu labels without adding privileged renderer actions. */
function updateMenu() {
  const roleItem = (role, key) => ({ role, label: t(key) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: t('menuFile'), submenu: [roleItem('quit', 'menuQuit')] },
    { label: t('menuEdit'), submenu: [roleItem('undo', 'menuUndo'), roleItem('redo', 'menuRedo'), { type: 'separator' }, roleItem('cut', 'menuCut'), roleItem('copy', 'menuCopy'), roleItem('paste', 'menuPaste'), roleItem('selectAll', 'menuSelectAll')] },
    { label: t('menuView'), submenu: [...(!app.isPackaged ? [roleItem('reload', 'menuReload'), roleItem('toggleDevTools', 'menuDevtools'), { type: 'separator' }] : []), roleItem('resetZoom', 'menuResetZoom'), roleItem('zoomIn', 'menuZoomIn'), roleItem('zoomOut', 'menuZoomOut'), roleItem('togglefullscreen', 'menuFullscreen')] },
    { label: t('menuWindow'), submenu: [roleItem('minimize', 'menuMinimize'), roleItem('close', 'menuClose')] }
  ]));
}

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
  window = new BrowserWindow({ width: 1240, height: 900, minWidth: 950, minHeight: 700, icon, backgroundColor: '#0c1423', webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (backend?.busy) {
      event.preventDefault();
      dialog.showMessageBox(window, { type: 'info', message: t('closeBusy'), buttons: [t('ok')] });
    }
  });
  if (profile.development) {
    window.on('page-title-updated', event => event.preventDefault());
    window.setTitle('MuOnline DEV — MuOnline-Dev WSL — real runtime operations');
  }
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
    if (profile.development) {
      const releaseDevLock = acquireDevLock(app.getPath('appData'));
      app.once('will-quit', releaseDevLock);
    }
    const resources = app.isPackaged ? process.resourcesPath : path.resolve(directory, '../..');
    language = resolveLocale(app.getLocale());
    backend = new Backend(resources, app.getPath('userData'), app.isPackaged ? path.join(resources, 'trust.json') : path.join(resources, 'build/trust.json'), language, profile);
    await backend.initialize();
    language = backend.language;
    updateMenu();
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle('manager:invoke', async (event, action, input) => {
      try {
        validateSender(event, input);
        const result = await backend.invoke(action, input);
        if (action === 'logs' || action === 'openLogs') {
          const error = await shell.openPath(result.logsDirectory);
          if (error) throw new Error('Could not open the support log folder.');
          return { ok: true, result: { logsOpened: true } };
        }
        if (action === 'openWebsite' || action === 'openAdmin') {
          await shell.openExternal(result);
          return { ok: true, result: { opened: true } };
        }
        if (action === 'sqlCopyReport') {
          const text = result.steps.map(step => '[' + t('sql.status.' + step.status) + '] ' + t('sql.reason.' + step.reason) + '\n' + t('sql.action.' + step.action) + '\n' + JSON.stringify(step.evidence)).join('\n\n');
          clipboard.writeText(JSON.stringify({ createdAt: result.createdAt, instance: result.selectedInstance, target: result.target }) + '\n\n' + text);
          return { ok: true, result: { copied: true } };
        }
        if (action === 'sqlCopyPlan') {
          clipboard.writeText(result);
          return { ok: true, result: { copied: true } };
        }
        if (action === 'setLanguage') {
          language = backend.language;
          updateMenu();
        }
        if (action === 'updateManager') {
          setTimeout(() => app.quit(), 200);
        }
        return { ok: true, result, logUnavailable: backend.logUnavailable === true };
      } catch (error) {
        if (!error.logFile && !error.logUnavailable && backend) {
          try {
            const log = await backend.supportLogs.begin(typeof action === 'string' ? action : 'operation', input);
            await log.append('ERROR: ' + error.message);
            if (log.failed) error.logUnavailable = true;
            else error.logFile = log.file;
          } catch { error.logUnavailable = true; }
        }
        return { ok: false, error: error.message.split('\n')[0].slice(0, 350), logFile: error.logFile, logUnavailable: error.logUnavailable === true, sqlSuggestion: error.sqlSuggestion ?? null, sqlResolvedEndpoint: error.sqlResolvedEndpoint ?? null, bootstrapSqlEndpoint: error.bootstrapSqlEndpoint ?? null };
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
  }).catch(async error => {
    let logFile = '';
    try {
      const log = await backend.supportLogs.begin('startup');
      await log.append('ERROR: ' + error.message);
      if (!log.failed) logFile = log.file;
    } catch { /* The startup dialog still explains that startup failed. */ }
    dialog.showErrorBox(t('startupTitle'), (profile.development ? error.message.split('\n')[0] : t('startupError')) + (logFile ? '\n\n' + logFile : ''));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
