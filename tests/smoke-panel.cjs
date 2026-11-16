const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

const operations = [];
let window;
let language = 'en';
let installedVersion = '1.3.0';
let pending = false;
const timer = setTimeout(() => { console.error('Electron smoke test timed out.'); app.exit(1); }, 60000);

/** Wait until initial settings, feed and status calls finish. */
async function waitUntilReady() {
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    const interval = setInterval(() => {
      if (document.querySelector('#webVersion')?.textContent === '1.3.0' && !document.querySelector('[data-page]').disabled) {
        clearInterval(interval); resolve();
      }
    }, 10);
  })`);
}

/** Switch through the actual selector and wait for preference persistence. */
async function selectLanguage(locale) {
  await window.webContents.executeJavaScript(`document.querySelector('#language').value='${locale}'; document.querySelector('#language').dispatchEvent(new Event('change'));`);
  await window.webContents.executeJavaScript(`new Promise(resolve => { const interval = setInterval(() => { if (!document.querySelector('#language').disabled && document.documentElement.lang === '${locale}') { clearInterval(interval); resolve(); } }, 10); })`);
}

/** Exercise actual renderer navigation and forms through the sandboxed preload bridge. */
async function smoke() {
  ipcMain.handle('manager:invoke', (event, action, input) => {
    operations.push({ action, input });
    if (action === 'setLanguage') {
      language = input.language;
    }
    if (action === 'update') {
      installedVersion = '1.4.0';
    }
    const results = {
      setLanguage: { language },
      sqlInspect: { selectedInstance: 'SQLEXPRESS', instances: [{ name: 'SQLEXPRESS', state: 'Running', version: '15.0.1', tcp: { listenAll: true, sections: [{ name: 'IPAll', port: '1433', dynamicPort: '' }] } }] },
      sqlDiagnose: { schema: 1, createdAt: '2026-11-17T10:00:00Z', steps: [{ id: 'docker.game.sql', status: 'failed', category: 'authentication', reason: 'loginRejected', action: 'loginRejected', evidence: { database: 'MuOnline', nativeCode: 18456 } }] },
      sqlPlan: { id: 'test-sql-plan', instance: 'SQLEXPRESS', port: 1433, command: "Restart-Service -Name 'MSSQL$SQLEXPRESS'", disconnectsSessions: true, changes: [] },
      sqlApply: { applied: true, changed: true, reason: 'serviceRestarted' },
      sqlCopyReport: { copied: true },
      sqlCopyPlan: { copied: true },
      settings: { cdn: 'https://cdn.interweb.bg', webChannel: 'muonline-web/releases/v1.3.0', managerChannel: 'muonline-web/manager/stable', trustedKeys: [], language },
      updates: { web: pending ? { latestVersion: '1.5.0', newTag: true, installedVersion, installationKnown: true, error: 'Release is not ready.', ready: false, available: false } : { version: '1.4.0', latestVersion: '1.4.0', installedVersion, installationKnown: true, ready: true, available: installedVersion !== '1.4.0', profiles: ['registry_profile'] }, manager: { error: 'Not published' } },
      status: { installed: true, phase: 'ready', version: installedVersion, access: { mode: 'local', url: 'http://localhost' } }
    };
    return { ok: true, result: results[action] ?? 'Completed test operation' };
  });
  ipcMain.handle('manager:link', () => {});
  window = new BrowserWindow({ show: true, width: 1280, height: 1000, webPreferences: { preload: path.resolve('src/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadFile(path.resolve('src/renderer/index.html'));
  await waitUntilReady();
  assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
  await fs.mkdir('artifacts/review', { recursive: true });
  for (const locale of ['en', 'bg']) {
    await selectLanguage(locale);
    for (const page of ['overview', 'install', 'access', 'admins', 'sql', 'backup', 'updates']) {
      await window.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
      const state = await window.webContents.executeJavaScript(`({ links: [...document.querySelectorAll('footer a')].map(a => a.href), bottom: document.querySelector('footer').getBoundingClientRect().bottom, height: innerHeight, heading: document.querySelector('h1').textContent, body: document.querySelector('#content').textContent, lang: document.documentElement.lang })`);
      assert.equal(state.links.length, 3);
      assert.ok(state.bottom <= state.height + 1);
      assert.ok(state.heading.length > 0);
      assert.equal(state.lang, locale);
      assert.equal(/[А-Яа-я]/.test(state.body), locale === 'bg', 'Page should be fully translated: ' + page);
      if (page === 'sql') {
        await window.webContents.executeJavaScript(`new Promise(resolve => { const timer=setInterval(()=>{ if(!document.querySelector('#language').disabled){clearInterval(timer);resolve();}},10); })`);
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#sqlInstance').value`), 'SQLEXPRESS');
      }
      if (page === 'admins') {
        const validation = await window.webContents.executeJavaScript(`document.querySelector('[name="adminName"]').checkValidity(); document.querySelector('[name="adminName"]').validationMessage`);
        assert.equal(validation, locale === 'bg' ? 'Попълнете това поле.' : 'Complete this field.');
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      const screenshot = await window.webContents.capturePage();
      assert.ok(screenshot.getSize().width > 900, 'Expected a rendered desktop screenshot');
      await fs.writeFile('artifacts/review/' + page + '-' + locale + '.png', screenshot.toPNG());
    }
  }
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="sql"]').click(); document.querySelector('[name="adminPassword"]').value='Never-report-this-secret'; document.querySelector('#sqlForm').requestSubmit();`);
  await window.webContents.executeJavaScript(`new Promise(resolve => {const timer=setInterval(()=>{if(!document.querySelector('#language').disabled && document.querySelector('#sqlResults .sql-step')){clearInterval(timer);resolve();}},10);})`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="adminPassword"]').value`), '');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#sqlResults').textContent.includes('Never-report-this-secret')`), false);
  for (const locale of ['en', 'bg']) {
    await selectLanguage(locale);
    const resultText = await window.webContents.executeJavaScript(`document.querySelector('#sqlResults').textContent`);
    assert.equal(/[А-Яа-я]/.test(resultText), locale === 'bg', 'SQL explanations must follow the selected language');
    assert.ok(!resultText.includes('sql.reason.'));
    assert.ok(!resultText.includes('sql.action.'));
    await window.webContents.executeJavaScript(`document.querySelector('#sqlResults').scrollIntoView()`);
    await fs.writeFile('artifacts/review/sql-results-' + locale + '.png', (await window.webContents.capturePage()).toPNG());
  }
  const changesBefore = operations.filter(operation => operation.action === 'sqlApply').length;
  await window.webContents.executeJavaScript(`document.querySelector('[data-sql-change="restart"]').click()`);
  await window.webContents.executeJavaScript(`new Promise(resolve => {const timer=setInterval(()=>{if(!document.querySelector('#language').disabled && document.querySelector('#sqlApplyButton')){clearInterval(timer);resolve();}},10);})`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#sqlApplyButton').disabled`), true);
  assert.equal(operations.filter(operation => operation.action === 'sqlApply').length, changesBefore);
  await window.webContents.executeJavaScript(`document.querySelector('#sqlPlan').scrollIntoView()`);
  await fs.writeFile('artifacts/review/sql-preview-bg.png', (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('[name="confirmSqlChange"]').checked=true; document.querySelector('[name="confirmSqlChange"]').dispatchEvent(new Event('change')); document.querySelector('#sqlApplyButton').click()`);
  await window.webContents.executeJavaScript(`new Promise(resolve => {const timer=setInterval(()=>{if(!document.querySelector('#language').disabled && !document.querySelector('#sqlApplyButton')){clearInterval(timer);resolve();}},10);})`);
  assert.equal(operations.filter(operation => operation.action === 'sqlApply').length, changesBefore + 1);
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="install"]').click(); document.querySelector('[name="sqlHost"]').value='192.0.2.8'; document.querySelector('[name="sqlPassword"]').value='Unsent-test-secret'; document.querySelector('[name="httpAcknowledged"]').checked=true;`);
  await selectLanguage('en');
  const values = await window.webContents.executeJavaScript(`({ host: document.querySelector('[name="sqlHost"]').value, password: document.querySelector('[name="sqlPassword"]').value, checked: document.querySelector('[name="httpAcknowledged"]').checked })`);
  assert.deepEqual(values, { host: '192.0.2.8', password: 'Unsent-test-secret', checked: true });
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#profiles').options.length`), 1);
  const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await reloaded;
  await waitUntilReady();
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.lang'), 'en');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-page="settings"]')`), null);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#updateNotice').hidden`), false);
  const rejected = await window.webContents.executeJavaScript(`window.manager.invoke('exec', { command: 'dangerous' }).then(() => false, () => true)`);
  assert.equal(rejected, true);
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="admins"]').click(); document.querySelector('[name="adminName"]').value='Owner'; document.querySelector('[name="adminEmail"]').value='owner@example.invalid'; document.querySelector('[name="adminPassword"]').value='Test-only-password123!'; document.querySelector('#adminForm').requestSubmit();`);
  await window.webContents.executeJavaScript(`new Promise(resolve => { const interval = setInterval(() => { if (!document.querySelector('[data-page]').disabled) { clearInterval(interval); resolve(); } }, 10); })`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="adminPassword"]').value`), '');
  assert.ok(operations.some(operation => operation.action === 'admin' && operation.input.administrator.email === 'owner@example.invalid'));
  assert.ok(!operations.some(operation => ['install', 'update', 'updateManager'].includes(operation.action)));
  await window.webContents.executeJavaScript(`document.querySelector('#updateNotice').click(); document.querySelector('[name="backupUsername"]').value='test'; document.querySelector('[name="backupPassword"]').value='Test-backup-secret'; document.querySelector('[name="backupDirectory"]').value='/backups'; document.querySelector('[name="migrationAcknowledged"]').checked=true; document.querySelector('#updateForm').requestSubmit();`);
  await window.webContents.executeJavaScript(`new Promise(resolve => { const interval = setInterval(() => { if (!document.querySelector('#language').disabled && document.querySelector('#webFeed').textContent.includes('1.4.0') && document.querySelector('#updateForm button').disabled) { clearInterval(interval); resolve(); } }, 10); })`);
  assert.equal(operations.filter(operation => operation.action === 'update').length, 1);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#updateNotice').hidden`), true);
  pending = true;
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="updates"]').click()`);
  await window.webContents.executeJavaScript(`new Promise(resolve => { const interval = setInterval(() => { if (!document.querySelector('#language').disabled && document.querySelector('#webFeed').textContent.includes('1.5.0')) { clearInterval(interval); resolve(); } }, 10); })`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#updateForm button').disabled`), true);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#updateNotice').hidden`), false);
  console.log('PASS: all seven pages in EN/BG, SQL diagnostic evidence and explicit change confirmation, persistent language, preserved unsent fields, permanent donate footer, sandbox bridge, administrator form, password cleanup and check-only updates. Screenshots: artifacts/review/.');
}
app.whenReady().then(smoke).then(() => { clearTimeout(timer); app.exit(0); }).catch(error => { clearTimeout(timer); console.error(error); app.exit(1); });
