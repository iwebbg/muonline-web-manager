const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

const operations = [];
const openedLinks = [];
let window;
let language = 'en';
let installedVersion = '1.3.0';
let pending = false;
let adminError = null;
let runtimeInstalled = true;
let runtimePhase = 'ready';
let runtimeAccess = {mode:'local',host:'localhost',url:'http://localhost',email:''};
let runtimeServiceState='running';
let runtimeWrites='disabled';
let identities = [
  {id:1,name:'Owner',email:'owner@example.test',role:'administrator',is_active:true},
  {id:2,name:'Game Master',email:'gm@example.test',role:'game_master',is_active:true},
  {id:3,name:'Second admin',email:'second@example.test',role:'administrator',is_active:true}
];
let heldAction = null;
let releaseHeld = null;
let heldSetupStage = null;
let heldError = null;
let bootstrapMode = null;
let savedBootstrapEndpoint = { host: '127.0.0.1', port: 1433, gameHost: '127.0.0.1', gamePort: 1433 };
let refuseUninstall = true;
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
    if (action === heldAction) {
      return new Promise(resolve => {
        releaseHeld = () => {
          if (heldError) { resolve({ ok: false, error: heldError }); return; }
          if (action === 'stop') runtimeServiceState = 'exited';
          if (['start', 'restart'].includes(action)) runtimeServiceState = 'running';
          resolve({ ok: true, result: action === 'status' ? { installed: true, phase: 'ready', version: installedVersion, access: runtimeAccess, services: '[]', gameWrites: runtimeWrites } : 'Completed test operation' });
        };
      });
    }
    if (action === 'setupStatus' && heldSetupStage) return { ok: true, result: { schema: 1, stage: heldSetupStage, status: 'running', completed: [] } };
    if (action === 'sqlSuggest') return { ok: true, result: { suggestion: { host: '172.20.48.1', port: 1433, instance: 'SQLEXPRESS' } } };
    if (action === 'resumeInstall' && bootstrapMode) {
      if (bootstrapMode === 'first') {
        runtimePhase = 'bootstrap-pending';
        return { ok: false, error: 'SQL connection failed.', bootstrapSqlEndpoint: savedBootstrapEndpoint,
          sqlSuggestion: { host: '172.20.48.1', port: 1433, instance: 'SQLEXPRESS' } };
      }
      assert.equal(input.settings.sqlHost, '172.20.48.1');
      assert.equal(input.settings.sqlAdmin, 'Correct-SQL-Admin');
      assert.equal(input.settings.sqlPassword, 'Correct-SQL-Private-Password');
      assert.deepEqual(input.settings.sqlEndpointChange, { confirmed: true, expected: savedBootstrapEndpoint });
      runtimePhase = 'ready';
      bootstrapMode = null;
      return { ok: true, result: 'Installation complete.' };
    }
    if (action === 'setLanguage') {
      language = input.language;
    }
    if (action === 'uninstallRuntime') { assert.equal(input.distributionConfirmation, 'MuOnline-Dev'); assert.equal(input.confirmed, true); assert.equal(input.sqlRemoval.confirmed, true); assert.equal(input.sqlRemoval.target.database, 'MuOnline_Web'); assert.equal(input.sqlRemoval.admin_password, 'Private-Password/42!'); if (refuseUninstall) return { ok: false, error: 'SQL cleanup incomplete: code=sql_operation_failed; database=removed; login=retained' }; runtimeInstalled=false; }
    if (action === 'setGameWrites') {
      assert.equal(input.gameWrites.confirmed, true);
      runtimeWrites = input.gameWrites.enabled ? 'enabled' : 'disabled';
    }
    if (action === 'stop') runtimeServiceState='exited';
    if (['start','restart'].includes(action)) runtimeServiceState='running';
    if (action === 'update') {
      installedVersion = '1.4.0';
    }
    if (action === 'adminUpdate') {
      const details = input.administrator;
      if (details.password === 'Rejected-password123!') return {ok:true,result:{code:'validation',errors:{password:['The password must contain at least one symbol.']}}};
      if (details.email === 'duplicate@example.test') return {ok:true,result:{code:'validation',errors:{email:['The email has already been taken.']}}};
      const row = identities.find(row=>row.id===details.id);
      for (const key of ['name','email','is_active']) if (Object.hasOwn(details,key)) row[key]=details[key];
      return {ok:true,result:{administrator:{...row}}};
    }
    const results = {
      uninstallRuntime: { removed: true, distribution: 'MuOnline-Dev' },
      logs: { logsOpened: true },
      openLogs: { logsOpened: true },
      setGameWrites: { gameWrites: runtimeWrites, restarted: true },
      setupStatus: { schema: 1, distribution: 'MuOnline-Dev', linuxUser: 'muonline', stage: 'ready', status: 'complete', completed: [], configuration: {} },
      adminList: adminError ? {code:adminError} : {administrators:identities},
      setLanguage: { language },
      openWebsite: { opened: true },
      openAdmin: { opened: true },
      sqlInspect: { selectedInstance: 'SQLEXPRESS', instances: [{ name: 'SQLEXPRESS', state: 'Running', version: '15.0.1', tcp: { listenAll: true, sections: [{ name: 'IPAll', port: '1433', dynamicPort: '' }] } }] },
      sqlDiagnose: { schema: 1, createdAt: '2026-11-17T10:00:00Z', steps: [{ id: 'docker.game.sql', status: 'failed', category: 'authentication', reason: 'loginRejected', action: 'loginRejected', evidence: { database: 'MuOnline', nativeCode: 18456 } }] },
      sqlPlan: { id: 'test-sql-plan', instance: 'SQLEXPRESS', port: 1433, command: "Restart-Service -Name 'MSSQL$SQLEXPRESS'", disconnectsSessions: true, changes: [] },
      sqlApply: { applied: true, changed: true, reason: 'serviceRestarted' },
      sqlCopyReport: { copied: true },
      sqlCopyPlan: { copied: true },
      settings: { distribution: 'MuOnline-Dev', setup: { schema: 1, distribution: 'MuOnline-Dev', linuxUser: 'muonline', stage: 'ready', status: 'complete', completed: [], configuration: {} }, cdn: 'https://cdn.interweb.bg', webChannel: 'muonline-web/releases/v1.3.0', managerChannel: 'muonline-web/manager/stable', trustedKeys: [], language },
      updates: { web: pending ? { latestVersion: '1.5.0', newTag: true, installedVersion, installationKnown: true, error: 'Release is not ready.', ready: false, available: false } : { version: '1.4.0', latestVersion: '1.4.0', installedVersion, installationKnown: true, ready: true, available: installedVersion !== '1.4.0', profiles: ['registry_profile', 'darksteam_97d99i', 'darksteam_1_0m', 'muemu_season_6', 'mudevs_season_21'] }, manager: { error: 'Not published' } },
      status: { bootstrapSqlEndpoint: runtimePhase === 'bootstrap-pending' ? savedBootstrapEndpoint : null, uninstallTarget: { host: 'sql.example', port: 1433, database: 'MuOnline_Web', login: 'web_app' }, gameWrites: runtimeWrites, installed: runtimeInstalled, phase: runtimePhase, version: installedVersion, access: runtimeAccess, services:JSON.stringify([{Service:'app',State:runtimeServiceState}]) }
    };
    return { ok: true, result: results[action] ?? 'Completed test operation' };
  });
  ipcMain.handle('manager:link', (event, target) => { openedLinks.push(target); });
  window = new BrowserWindow({ show: true, width: 1280, height: 1000, webPreferences: { preload: path.resolve('src/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadFile(path.resolve('src/renderer/index.html'));
  await waitUntilReady();
  assert.doesNotMatch(await window.webContents.executeJavaScript('document.querySelector("#setupNotice").textContent'), /wsl -d/);
  assert.equal(window.getTitle(), 'MuOnline Web Manager - Powered by InterWeb Ltd.');
  assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
  await fs.mkdir('artifacts/review', { recursive: true });
  for (const locale of ['en', 'bg']) {
    await selectLanguage(locale);
    for (const page of ['overview', 'install', 'access', 'admins', 'sql', 'backup', 'updates', 'support']) {
      await window.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
      await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(!document.querySelector('#language').disabled){clearInterval(timer);resolve();}},10);})`);
      const state = await window.webContents.executeJavaScript(`({ links: [...document.querySelectorAll('footer a')].map(a => a.href), bottom: document.querySelector('footer').getBoundingClientRect().bottom, height: innerHeight, heading: document.querySelector('h1').textContent, body: document.querySelector('#content').textContent, lang: document.documentElement.lang })`);
      assert.equal(state.links.length, 3);
      assert.ok(state.bottom <= state.height + 1);
      assert.ok(state.heading.length > 0);
      assert.equal(state.lang, locale);
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.workspace')`), null);
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#copyrightYear').textContent`), String(new Date().getFullYear()));
      assert.equal(/[А-Яа-я]/.test(state.body), locale === 'bg', 'Page should be fully translated: ' + page);
      if (page === 'overview') {
        assert.ok(!/Linux|WSL|Docker|Electron/.test(state.body), 'Overview should use plain user-facing language');
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-action="openWebsite"]').disabled`),false);
        await window.webContents.executeJavaScript(`document.querySelector('[data-action="openWebsite"]').click()`);
        await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(!document.querySelector('#language').disabled){clearInterval(timer);resolve();}},10);})`);
        await window.webContents.executeJavaScript(`document.querySelector('[data-action="openAdmin"]').click()`);
        await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(!document.querySelector('#language').disabled){clearInterval(timer);resolve();}},10);})`);
        assert.ok(operations.some(op=>op.action==='openWebsite'));
        assert.ok(operations.some(op=>op.action==='openAdmin'));
        assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.lifecycle-note').closest('.panel'))`), true, 'Availability note belongs inside the service card');
      }
      if (page === 'install') {
        const profiles = await window.webContents.executeJavaScript(`Array.from(document.querySelector('#profiles').options, option => ({ value: option.value, label: option.textContent }))`);
        assert.deepEqual(profiles.map(option => option.value), ['registry_profile', 'darksteam_97d99i', 'darksteam_1_0m', 'muemu_season_6', 'mudevs_season_21']);
        assert.equal(profiles[0].label, 'registry_profile', 'Future registry entries remain available without invented compatibility claims');
        assert.equal(profiles[1].label, locale === 'en' ? '97d+99i (Tested and Works with DarksTeam 97d+99i)' : '97d+99i (Тестван и работи с DarksTeam 97d+99i)');
        assert.match(profiles[2].label, /^Season 1 \(1\.0M\)/);
        assert.match(profiles[3].label, /^Season 6 .*Louis Emulator Update 32/);
        assert.equal(profiles[4].label, 'Season 21 (MuDevs)');
        assert.match(await window.webContents.executeJavaScript(`document.querySelector('#profiles').parentElement.textContent`), /^MuServer Version/);
        await window.webContents.executeJavaScript(`document.querySelector('#profiles').value='darksteam_1_0m'`);
        assert.equal(await window.webContents.executeJavaScript(`new FormData(document.querySelector('#installForm')).get('profile')`), 'darksteam_1_0m');

        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.install-helpers').open`), false);
        assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('#installForm').compareDocumentPosition(document.querySelector('.install-helpers')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true);
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallButton').disabled`), true);
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="trustCertificate"]').checked`), true, 'Initial setup defaults to trusting the SQL server certificate');
      }
      if (page === 'updates') {
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#updateForm').getBoundingClientRect().top - document.querySelector('.update-panels > .panel').getBoundingClientRect().bottom >= 20`), true, 'Update cards need visible spacing');
      }
      if (page === 'support') {
        const linksBefore = openedLinks.length;
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.console').hidden`), true);
        assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.support-donations a').length`), 3);
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('nav button:last-child').dataset.page`), 'support');
        await window.webContents.executeJavaScript(`document.querySelector('a[href="https://github.com/iwebbg/muonline-web-laravel/issues/new"]').click(); document.querySelector('.aside-note a').click();`);
        await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,30))`);
        assert.deepEqual(openedLinks.slice(linksBefore), ['https://github.com/iwebbg/muonline-web-laravel/issues/new', 'https://interweb.bg']);
      }
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
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#profiles').options.length`), 5);
  const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await reloaded;
  await waitUntilReady();
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.lang'), 'en');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-page="settings"]')`), null);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#updateNotice').hidden`), false);
  const rejected = await window.webContents.executeJavaScript(`window.manager.invoke('exec', { command: 'dangerous' }).then(() => false, () => true)`);
  assert.equal(rejected, true);
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="admins"]').click()`);
  await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(!document.querySelector('#language').disabled){clearInterval(timer);resolve();}},10);})`);
  await window.webContents.executeJavaScript(`document.querySelector('[name="adminName"]').value='Owner'; document.querySelector('[name="adminEmail"]').value='owner@example.invalid'; document.querySelector('[name="adminPassword"]').value='Test-only-password123!'; document.querySelector('#adminForm').requestSubmit();`);
  await window.webContents.executeJavaScript(`new Promise(resolve => { const interval = setInterval(() => { if (!document.querySelector('[data-page]').disabled) { clearInterval(interval); resolve(); } }, 10); })`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="adminPassword"]').value`), '');
  assert.ok(operations.some(operation => operation.action === 'admin' && operation.input.administrator.email === 'owner@example.invalid'));
  await selectLanguage('bg');
  await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="2"] [data-admin-action="password"]').click(); document.querySelector('[name="managedPassword"]').checkValidity()`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="managedPassword"]').validationMessage`),'Попълнете това поле.');
  await selectLanguage('en');
  // Exercise live table actions through the sandbox bridge, including a refusal and list reloads.
  const idle = async () => window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(!document.querySelector('#language').disabled){clearInterval(timer);resolve();}},10);})`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('#administratorTable tbody tr').length`),3);
  await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="2"] [data-admin-action="edit"]').click(); document.querySelector('[name="managedName"]').value='Updated GM'; document.querySelector('#adminManageForm').requestSubmit();`);
  await idle();
  assert.ok(operations.some(op=>op.action==='adminUpdate' && op.input.administrator.name==='Updated GM'));
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="2"]').textContent.includes('Updated GM')`),true);
  await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="2"] [data-admin-action="edit"]').click(); document.querySelector('[name="managedEmail"]').value='duplicate@example.test'; document.querySelector('#adminManageForm').requestSubmit();`);
  await idle();
  assert.ok(await window.webContents.executeJavaScript(`document.querySelector('#adminMessages').textContent.includes('already been taken')`));
  const beforeDeactivate=operations.filter(op=>op.action==='adminUpdate').length;
  await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="2"] [data-admin-action="deactivate"]').click()`);
  assert.equal(operations.filter(op=>op.action==='adminUpdate').length,beforeDeactivate);
  await window.webContents.executeJavaScript(`document.querySelector('#adminConfirmDeactivation').click()`);
  await idle();
  assert.equal(operations.filter(op=>op.action==='adminUpdate').length,beforeDeactivate+1);
  assert.equal(identities.find(row=>row.id===2).is_active,false);
  await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="2"] [data-admin-action="activate"]').click()`);
  await idle();
  assert.equal(identities.find(row=>row.id===2).is_active,true);
  await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="2"] [data-admin-action="password"]').click(); document.querySelector('[name="managedPassword"]').value='Changed-password123!'; document.querySelector('[name="managedPasswordConfirmation"]').value='Changed-password123!'; document.querySelector('#adminManageForm').requestSubmit();`);
  await idle();
  assert.ok(operations.some(op=>op.action==='adminUpdate' && op.input.administrator.password==='Changed-password123!'));
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="managedPassword"]')?.value ?? ''`),'');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#output').textContent.includes('Changed-password123!')`),false);
  await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="2"] [data-admin-action="password"]').click(); document.querySelector('[name="managedPassword"]').value='Rejected-password123!'; document.querySelector('[name="managedPasswordConfirmation"]').value='Rejected-password123!'; document.querySelector('#adminManageForm').requestSubmit();`);
  await idle();
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="managedPassword"]').value`),'');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="managedPasswordConfirmation"]').value`),'');
  assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('Rejected-password123!')`),false);
  // A stale UI cannot bypass the server rule; after refresh only one full administrator remains.
  identities.find(row=>row.id===3).is_active=false;
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="adminList"]').click()`);
  await idle();
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-administrator-id="1"] [data-admin-action="deactivate"]').disabled`),true);

  adminError='releaseRequired';
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="adminList"]').click()`);
  await idle();
  assert.ok(await window.webContents.executeJavaScript(`document.querySelector('#adminMessages').textContent.includes('installed web release')`));
  adminError=null;
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
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="support"]').click(); document.querySelector('[data-open-page="sql"]').click();`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('nav .selected').dataset.page`), 'sql');
  window.setSize(950, 700);
  await window.webContents.executeJavaScript(`new Promise(resolve=>setTimeout(resolve,100))`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('nav button:last-child').getBoundingClientRect().bottom <= document.querySelector('.aside-note').getBoundingClientRect().top`), true, 'Support navigation must not overlap company attribution at minimum window size');
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="overview"]').click()`);
  for (const [installed, phase] of [[false,'ready'],[true,'bootstrap-pending'],[true,'ready']]) {
    runtimeInstalled=installed;
    runtimePhase=phase;
    await window.webContents.executeJavaScript(`document.querySelector('[data-action="status"]').click()`);
    await idle();
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-action="openWebsite"]').disabled`),!installed || phase!=='ready');
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-action="openAdmin"]').disabled`),!installed || phase!=='ready');
  }
  runtimeAccess={mode:'domain',host:'mu.example.test',email:'owner@example.test',url:'https://mu.example.test'};
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="status"]').click()`);
  await idle();
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="access"]').click()`);
  assert.deepEqual(await window.webContents.executeJavaScript(`({mode:document.querySelector('#accessForm [name="mode"]').value,host:document.querySelector('#accessForm [name="host"]').value,email:document.querySelector('#accessForm [name="acmeEmail"]').value})`),{mode:'domain',host:'mu.example.test',email:'owner@example.test'});
  await window.webContents.executeJavaScript(`document.querySelector('#accessForm [name="host"]').value='unsent.example.test'`);
  await selectLanguage('bg');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#accessForm [name="host"]').value`),'unsent.example.test');
  await selectLanguage('en');
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="overview"]').click()`);
  for (const action of ['stop','start','restart']) {
    const beforeStatus=operations.filter(op=>op.action==='status').length;
    await window.webContents.executeJavaScript(`document.querySelector('[data-action="${action}"]').click()`);
    await idle();
    assert.equal(operations.filter(op=>op.action==='status').length,beforeStatus+1);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-service="app"]').dataset.tone`), action === 'stop' ? 'failed' : 'running');
  }
  for (const action of ['start', 'stop', 'restart']) {
    heldAction = action;
    releaseHeld = null;
    await window.webContents.executeJavaScript(`document.querySelector('[data-action="${action}"]').click()`);
    await window.webContents.executeJavaScript(`new Promise(resolve => { const timer=setInterval(()=>{if(document.querySelector('#operationProgress').open){clearInterval(timer);resolve();}},10); })`);
    assert.match(await window.webContents.executeJavaScript(`document.querySelector('#progressTitle').textContent`), /Starting|Stopping|Restarting/);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-action="${action}"]').disabled`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#operationProgress').getBoundingClientRect().bottom <= document.querySelector('footer').getBoundingClientRect().top + 1`), true, 'Donation footer remains visible below the overlay');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#operationProgress').open`), true, 'Escape must not imply cancellation of a runtime operation');
    if (action === 'start') {
      await window.webContents.executeJavaScript(`new Promise(resolve => { const timer=setInterval(()=>{if(!document.querySelector('#progressElapsed').textContent.endsWith('0:00')){clearInterval(timer);resolve();}},10); })`);
      const finishStart = releaseHeld;
      heldAction = 'status';
      releaseHeld = null;
      finishStart();
      await new Promise(resolve => { const timer=setInterval(()=>{if(releaseHeld){clearInterval(timer);resolve();}},10); });
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#operationProgress').open`), true);
      assert.match(await window.webContents.executeJavaScript(`document.querySelector('#progressStep').textContent`), /Refreshing website status/);
    }
    heldAction = null;
    releaseHeld();
    await idle();
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#operationProgress').open`), false);
    assert.equal(await window.webContents.executeJavaScript(`document.body.classList.contains('operation-loading')`), false);
  }
  for (const locale of ['en', 'bg']) {
    await selectLanguage(locale);
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="install"]').click(); document.querySelector('.install-helpers').open=true;`);
    heldAction = 'installDocker';
    heldSetupStage = 'distribution';
    await window.webContents.executeJavaScript(`document.querySelector('[data-action="installDocker"]').click()`);
    const expected = locale === 'en' ? 'Preparing the website environment…' : 'Подготовка на средата за сайта…';
    await window.webContents.executeJavaScript(`new Promise(resolve => { const timer=setInterval(()=>{if(document.querySelector('#operationProgress').open && document.querySelector('#progressStep').textContent === ${JSON.stringify(expected)}){clearInterval(timer);resolve();}},10); })`);
    heldSetupStage = 'docker';
    const nextStep = locale === 'en' ? 'Installing the services needed by your website…' : 'Инсталиране на услугите, необходими за сайта…';
    await window.webContents.executeJavaScript(`new Promise(resolve => { const timer=setInterval(()=>{if(document.querySelector('#progressStep').textContent === ${JSON.stringify(nextStep)}){clearInterval(timer);resolve();}},10); })`);
    await fs.writeFile(`artifacts/review/progress-${locale}.png`, (await window.webContents.capturePage()).toPNG());
    heldSetupStage = null;
    heldAction = null;
    releaseHeld();
    await idle();
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#operationProgress').open`), false);
  }
  await selectLanguage('en');
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="overview"]').click()`);
  heldAction = 'restart';
  heldError = 'Runtime operation failed. No credentials were logged. Inspect installation state and the recovery guide.';
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="restart"]').click()`);
  await window.webContents.executeJavaScript(`new Promise(resolve => { const timer=setInterval(()=>{if(document.querySelector('#operationProgress').open){clearInterval(timer);resolve();}},10); })`);
  heldAction = null;
  releaseHeld();
  heldError = null;
  await idle();
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#operationProgress').open`), false);
  assert.equal(await window.webContents.executeJavaScript(`document.activeElement.id`), 'output');
  assert.equal(await window.webContents.executeJavaScript(`document.body.classList.contains('operation-loading')`), false);
  const writesBefore = operations.filter(op => op.action === 'setGameWrites').length;
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.service-tile').length`), 5);
  await window.webContents.executeJavaScript(`const toggle=document.querySelector('#gameWritesToggle'); toggle.checked=true; toggle.dispatchEvent(new Event('change'));`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#gameWritesApply').disabled`), true);
  assert.equal(operations.filter(op => op.action === 'setGameWrites').length, writesBefore);
  await window.webContents.executeJavaScript(`const confirmation=document.querySelector('#gameWritesConfirm'); confirmation.checked=true; confirmation.dispatchEvent(new Event('change')); document.querySelector('#gameWritesApply').click();`);
  await idle();
  assert.equal(operations.filter(op => op.action === 'setGameWrites').length, writesBefore + 1);
  assert.equal(runtimeWrites, 'enabled');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#gameWritesToggle').checked`), true);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#gameWritesConfirm').checked`), false);
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="install"]').click()`);
  bootstrapMode = 'first';
  await window.webContents.executeJavaScript(`(()=>{const form=document.querySelector('#installForm'); for(const [key,value] of Object.entries({sqlHost:'127.0.0.1',sqlPort:'1433',sqlAdmin:'Wrong-SQL-Admin',sqlPassword:'Wrong-SQL-Password',adminName:'Owner',adminEmail:'owner@example.test',adminPassword:'AdminPrivate123!'})){form.elements[key].value=value;} document.querySelector('#resumeInstall').click();})();`);
  await idle();
  assert.match(await window.webContents.executeJavaScript(`document.querySelector('#output').textContent`), /172\.20\.48\.1:1433/);
  assert.match(await window.webContents.executeJavaScript(`document.querySelector('#savedSqlEndpoint').textContent`), /127\.0\.0\.1/);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="sqlPassword"]').value`), '');
  await window.webContents.executeJavaScript(`(()=>{document.querySelector('#useSqlHost').click(); const form=document.querySelector('#installForm'); form.elements.sqlAdmin.value='Correct-SQL-Admin'; form.elements.sqlPassword.value='Correct-SQL-Private-Password'; form.elements.adminPassword.value='AdminPrivate123!';})();`);
  const resumesBefore = operations.filter(op => op.action === 'resumeInstall').length;
  await window.webContents.executeJavaScript(`document.querySelector('#resumeInstall').click()`);
  assert.equal(operations.filter(op => op.action === 'resumeInstall').length, resumesBefore, 'Endpoint retargeting needs explicit same-server confirmation');
  bootstrapMode = 'corrected';
  await window.webContents.executeJavaScript(`(()=>{const checkbox=document.querySelector('[name="confirmSqlEndpoint"]'); checkbox.checked=true; checkbox.dispatchEvent(new Event('change')); document.querySelector('#resumeInstall').click();})();`);
  await idle();
  assert.equal(operations.filter(op => op.action === 'resumeInstall').length, resumesBefore + 1);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="sqlPassword"]').value`), '');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#sqlEndpointConfirmation').hidden`), true);
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="install"]').click(); document.querySelector('.uninstall-panel').open=true; document.querySelector('#uninstallName').value='Personal-Linux'; document.querySelector('#uninstallConfirm').checked=true; document.querySelector('#uninstallForm').dispatchEvent(new Event('input'));`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallButton').disabled`), true);
  await window.webContents.executeJavaScript(`document.querySelector('#uninstallName').value='MuOnline-Dev'; document.querySelector('#uninstallForm').dispatchEvent(new Event('input'));`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallButton').disabled`), true);
  assert.match(await window.webContents.executeJavaScript(`document.querySelector('#uninstallTarget').textContent`), /sql.example:1433.*MuOnline_Web.*web_app/);
  await window.webContents.executeJavaScript(`document.querySelector('#uninstallSqlAdmin').value='sa'; document.querySelector('#uninstallSqlPassword').value='Private-Password/42!'; document.querySelector('#uninstallSqlConfirm').checked=true; document.querySelector('#uninstallForm').dispatchEvent(new Event('input'));`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallButton').disabled`), false);
  await window.webContents.executeJavaScript(`document.querySelector('#uninstallButton').click();`);
  await idle();
  assert.equal(runtimeInstalled, true);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#operationProgress').open`), false);
  assert.equal(await window.webContents.executeJavaScript(`document.activeElement.id`), 'output');
  await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 500))`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.console').getBoundingClientRect().top < innerHeight - 70 && document.querySelector('.console').classList.contains('operation-error')`), true, 'Failure scrolls to the operation result');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallSqlPassword').value`), '');
  assert.match(await window.webContents.executeJavaScript(`document.querySelector('#output').textContent`), /retained|запазен/);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallButton').disabled`), true);
  refuseUninstall = false;
  await window.webContents.executeJavaScript(`document.querySelector('#uninstallName').value='MuOnline-Dev'; document.querySelector('#uninstallConfirm').checked=true; document.querySelector('#uninstallSqlPassword').value='Private-Password/42!'; document.querySelector('#uninstallSqlConfirm').checked=true; document.querySelector('#uninstallForm').dispatchEvent(new Event('input')); document.querySelector('#uninstallButton').click();`);
  await idle();
  assert.equal(operations.filter(op => op.action === 'uninstallRuntime').length, 2);
  assert.equal(runtimeInstalled, false);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallSqlPassword').value`), '');
  console.log('PASS: all eight pages in EN/BG, support/company links, branding and compact navigation, SQL diagnostic evidence and explicit change confirmation, persistent language, preserved unsent fields, permanent donate footer, sandbox bridge, administrator form, password cleanup, delayed modal progress, live setup stages, final status refresh, error focus/scroll and check-only updates. Screenshots: artifacts/review/.');
}
app.whenReady().then(smoke).then(() => { clearTimeout(timer); app.exit(0); }).catch(error => { clearTimeout(timer); console.error(error); app.exit(1); });
