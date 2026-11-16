const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

const operations = [];
let window;
const timer = setTimeout(() => { console.error('Electron smoke test timed out.'); app.exit(1); }, 60000);

/** Exercise actual renderer navigation and forms through the sandboxed preload bridge. */
async function smoke() {
  ipcMain.handle('manager:invoke', (event, action, input) => {
    operations.push({ action, input });
    const results = {
      settings: { cdn: 'https://cdn.interweb.bg', webChannel: 'muonline-web/releases/v1.3.0', managerChannel: 'muonline-web/manager/stable', trustedKeys: [] },
      updates: { web: { version: '1.3.0', profiles: ['registry_profile'] }, manager: { error: 'Not published' } },
      status: { installed: true, phase: 'ready', version: '1.3.0', access: { mode: 'local', url: 'http://localhost' } }
    };
    return { ok: true, result: results[action] ?? 'Completed test operation' };
  });
  ipcMain.handle('manager:link', () => {});
  window = new BrowserWindow({ show: true, width: 1280, height: 1000, webPreferences: { preload: path.resolve('src/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadFile(path.resolve('src/renderer/index.html'));
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    const interval = setInterval(() => {
      if (document.querySelector('#webVersion')?.textContent === '1.3.0' && !document.querySelector('[data-page]').disabled) {
        clearInterval(interval); resolve();
      }
    }, 10);
  })`);
  assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
  await fs.mkdir('artifacts/review', { recursive: true });
  for (const page of ['overview', 'install', 'access', 'admins', 'backup', 'updates', 'settings']) {
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
    const footer = await window.webContents.executeJavaScript(`({ links: [...document.querySelectorAll('footer a')].map(a => a.href), bottom: document.querySelector('footer').getBoundingClientRect().bottom, height: innerHeight, heading: document.querySelector('h1').textContent })`);
    assert.equal(footer.links.length, 3);
    assert.ok(footer.bottom <= footer.height + 1);
    assert.ok(footer.heading.length > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    const screenshot = await window.webContents.capturePage();
    assert.ok(screenshot.getSize().width > 900, 'Expected a rendered desktop screenshot');
    await fs.writeFile('artifacts/review/' + page + '.png', screenshot.toPNG());
  }
  const rejected = await window.webContents.executeJavaScript(`window.manager.invoke('exec', { command: 'dangerous' }).then(() => false, () => true)`);
  assert.equal(rejected, true);
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="admins"]').click(); document.querySelector('[name="adminName"]').value='Owner'; document.querySelector('[name="adminEmail"]').value='owner@example.invalid'; document.querySelector('[name="adminPassword"]').value='Test-only-password123!'; document.querySelector('#adminForm').requestSubmit();`);
  await window.webContents.executeJavaScript(`new Promise(resolve => { const interval = setInterval(() => { if (!document.querySelector('[data-page]').disabled) { clearInterval(interval); resolve(); } }, 10); })`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="adminPassword"]').value`), '');
  assert.ok(operations.some(operation => operation.action === 'admin' && operation.input.administrator.email === 'owner@example.invalid'));
  assert.ok(!operations.some(operation => ['install', 'update', 'updateManager'].includes(operation.action)));
  console.log('PASS: seven panel pages, permanent donate footer, sandbox bridge, administrator form, password cleanup, and check-only automatic updates. Screenshots: artifacts/review/.');
}
app.whenReady().then(smoke).then(() => { clearTimeout(timer); app.exit(0); }).catch(error => { clearTimeout(timer); console.error(error); app.exit(1); });
