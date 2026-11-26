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
let onboardingMode = null;
let rebootCheckpoint = false;
let installationDraft = {};
let savedBootstrapEndpoint = { host: '127.0.0.1', port: 1433, gameHost: '127.0.0.1', gamePort: 1433 };
let refuseUninstall = true;
let siteFixture;
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
  const workerSource = await fs.readFile('runtime/worker.py', 'utf8');
  const siteFields = JSON.parse(workerSource.match(/SITE_FIELDS = json.loads\(r'''([\s\S]*?)'''\)/)[1]).map(field => ({...field,supported:field.key !== 'REVOLUT_TAG'}));
  siteFixture = { webhooks:{stripe:'https://mu.example.test/payments/webhooks/stripe'}, revision:'fixture-revision', fields:siteFields, values:Object.fromEntries(siteFields.filter(field=>field.type!=='secret').map(field=>[field.key,field.default])), configured:{MAIL_PASSWORD:true}, s3DriverInstalled:false };
  const { publicInstallationSettings } = await import('../src/shared/installation-settings.js');
  ipcMain.handle('manager:invoke', (event, action, input) => {
    operations.push({ action, input });
    if (action === 'saveInstallationDraft') {
      assert.deepEqual(input.settings, publicInstallationSettings(input.settings), 'Only public form values cross draft IPC');
      installationDraft = { ...installationDraft, ...input.settings };
      return { ok: true, result: { schema: 1, completed: [], configuration: installationDraft } };
    }
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
    if (action === 'setupStatus' && rebootCheckpoint) return { ok: true, result: { schema: 1, stage: 'windows', status: 'restartRequired', completed: [], configuration: installationDraft } };
    if (['install','resumeInstall'].includes(action) && onboardingMode) {
      if (onboardingMode === 'bootstrap-failure') {
        runtimeInstalled = true; runtimePhase = 'bootstrap-pending';
        return { ok: false, error: 'Game database access setup failed. Check the existing game database, selected MuServer version and temporary SQL administrator permissions in SQL Troubleshooting. Use Resume after correcting the cause; existing SQL resources were retained.', bootstrapSqlEndpoint: savedBootstrapEndpoint };
      }
      if (onboardingMode === 'restart') {
        rebootCheckpoint = true;
        return { ok: false, code: 'WSL_RESTART_REQUIRED', error: 'Restart Windows, then click Install again to continue. Installation progress has been saved.' };
      }
      runtimeInstalled = true; runtimePhase = 'ready'; rebootCheckpoint = false;
      return { ok: true, result: 'Complete' };
    }
    if (action === 'setupStatus' && heldSetupStage) return { ok: true, result: { schema: 1, stage: heldSetupStage, status: 'running', completed: [] } };
    if (action === 'sqlSuggest') return { ok: true, result: { suggestion: { host: '172.20.48.1', port: 1433, instance: 'SQLEXPRESS' } } };
    if (action === 'resumeInstall' && bootstrapMode === 'automatic') {
      bootstrapMode = null;
      return { ok: true, result: { message: 'Complete', sqlResolvedEndpoint: { host: '172.25.160.1', port: 1433 } } };
    }
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
    if (action === 'uninstallRuntime') { assert.equal(input.distributionConfirmation, 'MuOnline-Dev'); assert.equal(input.confirmed, true); assert.equal(input.sqlRemoval.confirmed, true); assert.equal(input.sqlRemoval.target.database, 'MuOnline_Web'); assert.equal(input.sqlRemoval.admin_password, 'Private-Password/42!'); if (refuseUninstall) return { ok: false, error: 'SQL cleanup incomplete: code=sql_operation_failed; database=removed; login=retained' }; runtimeInstalled=false; installationDraft={}; }
    if (action === 'saveSiteSettings') {
      assert.equal(input.siteSettings.confirmed,true);
      for(const [key,value] of Object.entries(input.siteSettings.changes)) {
        if(typeof value === 'string') siteFixture.values[key]=value;
        else siteFixture.configured[key]=value.operation === 'replace';
      }
    }
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
      siteSettings: siteFixture,
      saveSiteSettings: siteFixture,
      uninstallRuntime: { removed: true, distribution: 'MuOnline-Dev' },
      logs: { logsOpened: true },
      openLogs: { logsOpened: true },
      setGameWrites: { gameWrites: runtimeWrites, restarted: true },
      setupStatus: { schema: 1, distribution: 'MuOnline-Dev', linuxUser: 'muonline', stage: 'ready', status: 'complete', completed: [], configuration: installationDraft },
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
      settings: { distribution: 'MuOnline-Dev', setup: { schema: 1, distribution: 'MuOnline-Dev', linuxUser: 'muonline', stage: 'ready', status: 'complete', completed: [], configuration: installationDraft }, cdn: 'https://cdn.interweb.bg', webChannel: 'muonline-web/releases/v1.3.0', managerChannel: 'muonline-web/manager/stable', trustedKeys: [], language },
      updates: { web: pending ? { latestVersion: '1.5.0', newTag: true, installedVersion, installationKnown: true, error: 'Release is not ready.', ready: false, available: false } : { version: '1.4.0', latestVersion: '1.4.0', installedVersion, installationKnown: true, ready: true, available: installedVersion !== '1.4.0', profiles: ['registry_profile', 'darksteam_97d99i', 'darksteam_1_0m', 'muemu_season_6', 'mudevs_season_21'] }, manager: { error: 'Not published' } },
      status: { bootstrapSqlEndpoint: runtimeInstalled && runtimePhase === 'bootstrap-pending' ? savedBootstrapEndpoint : null, uninstallTarget: { host: 'sql.example', port: 1433, database: 'MuOnline_Web', login: 'web_app' }, gameWrites: runtimeWrites, installed: runtimeInstalled, phase: runtimePhase, version: installedVersion, access: runtimeAccess, services:JSON.stringify([{Service:'app',State:runtimeServiceState}]) }
    };
    return { ok: true, result: results[action] ?? 'Completed test operation' };
  });
  ipcMain.handle('manager:link', (event, target) => { openedLinks.push(target); });
  window = new BrowserWindow({ show: true, width: 1280, height: 1000, webPreferences: { preload: path.resolve('src/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:',event.message); });
  await window.loadFile(path.resolve('src/renderer/index.html'));
  await waitUntilReady();
  assert.doesNotMatch(await window.webContents.executeJavaScript('document.querySelector("#setupNotice").textContent'), /wsl -d/);
  assert.equal(window.getTitle(), 'MuOnline Web Manager - Powered by InterWeb Ltd.');
  assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
  await fs.mkdir('artifacts/review', { recursive: true });
  for (const locale of ['en', 'bg']) {
    await selectLanguage(locale);
    for (const page of ['overview', 'install', 'access', 'site', 'admins', 'sql', 'backup', 'updates', 'support']) {
      await window.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
      await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(!document.querySelector('#language').disabled){clearInterval(timer);resolve();}},10);})`);
      const state = await window.webContents.executeJavaScript(`({ links: [...document.querySelectorAll('footer a')].map(a => a.href), bottom: document.querySelector('footer').getBoundingClientRect().bottom, height: innerHeight, heading: document.querySelector('h1').textContent, body: document.querySelector('#content').innerText, lang: document.documentElement.lang })`);
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
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallForm')`), null, 'Uninstall is separate from First installation');
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
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="useInstalled"]').checked`), true);
        assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#sqlManualFields').hidden && document.querySelector('#sqlManualFields').disabled`), true);
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
  // Explicit manual mode remains available; it must not contaminate installed-mode requests.
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="sql"]').click(); (()=>{const mode=document.querySelector('[name="useInstalled"]'); mode.checked=false; mode.dispatchEvent(new Event('change')); document.querySelector('[name="gamePassword"]').value='Manual-only-private';})();`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#sqlManualFields').hidden`), false);
  await selectLanguage('en');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#sqlManualFields').disabled`), false);
  await window.webContents.executeJavaScript(`(()=>{const mode=document.querySelector('[name="useInstalled"]'); mode.checked=true; mode.dispatchEvent(new Event('change'));})();`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="gamePassword"]').value`), '');
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
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="site"]').click()`);
  await idle();
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="MAIL_PASSWORD"]').value`), '');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="REVOLUT_TAG"]').disabled`), true);
  await window.webContents.executeJavaScript(`(() => {
    const select=document.querySelector('[name="secretOperation_MAIL_PASSWORD"]'); select.value='replace'; select.dispatchEvent(new Event('change'));
    document.querySelector('[name="MAIL_PASSWORD"]').value='Memory-only-language-switch';
  })()`);
  await selectLanguage('bg'); await selectLanguage('en');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="MAIL_PASSWORD"]').disabled`), false);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="MAIL_PASSWORD"]').value`),'Memory-only-language-switch');
  heldAction = 'saveSiteSettings'; heldError = 'Website settings failed; previous configuration restored. Backup: /private/backup'; releaseHeld = null;
  await window.webContents.executeJavaScript(`(() => {
    const form=document.querySelector('#siteSettingsForm');
    form.querySelector('[name="APP_NAME"]').value='New website name';
    const select=form.querySelector('[name="secretOperation_MAIL_PASSWORD"]'); select.value='replace'; select.dispatchEvent(new Event('change'));
    form.querySelector('[name="MAIL_PASSWORD"]').value='Never-display-this-secret';
    form.querySelector('[name="siteConfirmed"]').checked=true;
    form.requestSubmit();
  })()`);
  await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(document.querySelector('#operationProgress').open){clearInterval(timer);resolve();}},10);})`);
  assert.match(await window.webContents.executeJavaScript(`document.querySelector('#progressTitle').textContent`), /Applying website settings/);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('footer a').length`),3);
  heldAction = null; releaseHeld(); await idle(); heldError = null;
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="MAIL_PASSWORD"]').value`),'');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="siteConfirmed"]').checked`),false);
  assert.doesNotMatch(await window.webContents.executeJavaScript(`document.querySelector('#output').textContent`),/Never-display-this-secret/);
  await window.webContents.executeJavaScript(`(() => {
    const form=document.querySelector('#siteSettingsForm');
    form.querySelector('[name="secretOperation_MAIL_PASSWORD"]').value='keep';
    form.querySelector('[name="secretOperation_MAIL_PASSWORD"]').dispatchEvent(new Event('change'));
    form.querySelector('[name="siteConfirmed"]').checked=true;
    form.requestSubmit();
  })()`);
  await idle();
  const savedSite=operations.filter(op=>op.action==='saveSiteSettings').at(-1).input.siteSettings;
  assert.deepEqual(savedSite.changes,{APP_NAME:'New website name'});
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="APP_NAME"]').value`),'New website name');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="MAIL_PASSWORD"]').value`),'');
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
    heldSetupStage = 'sqlNetwork';
    const sqlStep = locale === 'en' ? 'Detecting local SQL Server and preparing its restricted firewall access…' : 'Откриване на локалния SQL Server и настройване на ограничен firewall достъп…';
    await window.webContents.executeJavaScript(`new Promise(resolve => { const timer=setInterval(()=>{if(document.querySelector('#progressStep').textContent === ${JSON.stringify(sqlStep)}){clearInterval(timer);resolve();}},10); })`);
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
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installForm')`), null, 'Completed setup routes to Control Panel');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').open`), true);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').dataset.kind`), 'success');
  await window.webContents.executeJavaScript(`document.querySelector('#outcomeClose').click(); document.querySelector('[data-page="install"]').click();`);
  bootstrapMode = 'automatic';
  await window.webContents.executeJavaScript(`document.querySelector('[name="sqlHost"]').value='127.0.0.1'; document.querySelector('#resumeInstall').click();`);
  await idle();
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').open`), true);
  await window.webContents.executeJavaScript(`document.querySelector('#outcomeClose').click();`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="overview"]').click(); document.querySelector('.uninstall-panel').open=true; document.querySelector('#uninstallName').value='Personal-Linux'; document.querySelector('#uninstallConfirm').checked=true; document.querySelector('#uninstallForm').dispatchEvent(new Event('input'));`);
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
  await window.webContents.executeJavaScript(`new Promise(resolve => { let attempts=0; const timer=setInterval(()=>{if(document.querySelector('.console').getBoundingClientRect().top < innerHeight - 70 || ++attempts >= 100){clearInterval(timer);resolve();}},20); })`);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.console').getBoundingClientRect().top < innerHeight - 70 && document.querySelector('.console').classList.contains('operation-error')`), true, 'Failure scrolls to the operation result');
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallSqlPassword').value`), '');
  assert.match(await window.webContents.executeJavaScript(`document.querySelector('#output').textContent`), /retained|запазен/);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallButton').disabled`), true);
  refuseUninstall = false;
  await window.webContents.executeJavaScript(`document.querySelector('#uninstallName').value='MuOnline-Dev'; document.querySelector('#uninstallConfirm').checked=true; document.querySelector('#uninstallSqlPassword').value='Private-Password/42!'; document.querySelector('#uninstallSqlConfirm').checked=true; document.querySelector('#uninstallForm').dispatchEvent(new Event('input')); document.querySelector('#uninstallButton').click();`);
  await idle();
  assert.equal(operations.filter(op => op.action === 'uninstallRuntime').length, 2);
  assert.equal(runtimeInstalled, false);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallSqlPassword')`), null);
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('#installForm'))`), true);
  // Verify the actual first-run journey independently from the page-translation fixture.
  for (const locale of ['en', 'bg']) {
    await selectLanguage(locale);
    runtimeInstalled = false; runtimePhase = 'bootstrap-pending'; pending = false;
    onboardingMode = 'restart'; rebootCheckpoint = false; installationDraft = {};
    const freshLoad = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload(); await freshLoad;
    await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(document.querySelector('main').getAttribute('aria-busy')==='false'){clearInterval(timer);resolve();}},10);})`);
    assert.deepEqual(await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('nav [data-page]')).filter(button=>!button.hidden).map(button=>button.dataset.page)`), ['install','sql','support']);
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('#installForm'))`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#uninstallForm')`), null);
    const draftValues = { sqlHost: '192.0.2.99', sqlPort: '1444', sqlAdmin: 'TemporarySetup', profile: 'darksteam_97d99i', appEnv: 'production', gameDatabase: 'GameDraft', webDatabase: 'WebDraft', appLogin: 'AppDraft', gameLogin: 'GameDraftLogin', mode: 'domain', host: 'mu.example.test', acmeEmail: 'cert@example.test', adminName: 'Draft Owner', adminEmail: 'draft@example.test' };
    await window.webContents.executeJavaScript(`(()=>{const form=document.querySelector('#installForm'); for(const [name,value] of Object.entries(${JSON.stringify(draftValues)})) form.elements[name].value=value; form.elements.sqlPassword.value='NeverPersist-SQL123!'; form.elements.adminPassword.value='NeverPersist-Web123!'; form.elements.trustCertificate.checked=false; form.dispatchEvent(new Event('input'));})();`);
    assert.equal(installationDraft.profile, 'darksteam_97d99i');
    assert.equal(installationDraft.administrator.email, 'draft@example.test');
    assert.doesNotMatch(JSON.stringify(installationDraft), /NeverPersist|Password|password/);
    const reloadDraft = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload(); await reloadDraft;
    await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(document.querySelector('main').getAttribute('aria-busy')==='false'){clearInterval(timer);resolve();}},10);})`);
    for (const [name,value] of Object.entries(draftValues)) assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installForm').elements[${JSON.stringify(name)}].value`), value, 'Restored ' + name);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="trustCertificate"]').checked`), false);
    for (const name of ['sqlPassword','adminPassword']) assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installForm').elements[${JSON.stringify(name)}].value`), '');
    await window.webContents.executeJavaScript(`const form=document.querySelector('#installForm'); form.elements.sqlHost.value='127.0.0.1'; form.elements.sqlPort.value='1433'; form.dispatchEvent(new Event('input'));`);
    await window.webContents.executeJavaScript(`(()=>{const form=document.querySelector('#installForm'); for(const [name,value] of Object.entries({sqlPassword:'TemporaryPrivate123!',adminName:'Owner',adminEmail:'owner@example.test',adminPassword:'AdminPrivate123!'})){form.elements[name].value=value;} form.querySelector('button[type="submit"]').click();})();`);
    await idle();
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').dataset.kind`), 'restart', await window.webContents.executeJavaScript(`JSON.stringify({output:document.querySelector('#output').textContent, invalid:[...document.querySelectorAll('#installForm :invalid')].map(field=>field.name)})`));
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').open`), true);
    assert.match(await window.webContents.executeJavaScript(`document.querySelector('#installationEstimate').textContent`), /15/);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="sqlPassword"]').value`), '');
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').getBoundingClientRect().bottom <= document.querySelector('footer').getBoundingClientRect().top + 1`), true);
    await fs.writeFile(`artifacts/review/restart-required-${locale}.png`, (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('#outcomeClose').click()`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').open`), false);
    // A manual pre-install test must not survive discovery of new private runtime settings.
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="sql"]').click();`);
    await idle();
    await window.webContents.executeJavaScript(`document.querySelector('[name="useInstalled"]').checked=false; document.querySelector('[name="useInstalled"]').dispatchEvent(new Event('change')); document.querySelector('[data-page="install"]').click();`);
    // A fresh bootstrap failure must immediately switch SQL diagnostics to saved settings,
    // even before another explicit Status request and before an app container exists.
    onboardingMode = 'bootstrap-failure';
    await window.webContents.executeJavaScript(`document.querySelector('[name="sqlPassword"]').value='TemporaryPrivate123!'; document.querySelector('[name="adminName"]').value='Owner'; document.querySelector('[name="adminEmail"]').value='owner@example.test'; document.querySelector('[name="adminPassword"]').value='AdminPrivate123!'; document.querySelector('#resumeInstall').click();`);
    await idle();
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="sql"]').click()`);
    await idle();
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name="useInstalled"]').checked`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#sqlManualFields').hidden && document.querySelector('#sqlManualFields').disabled`), true);
    await window.webContents.executeJavaScript(`document.querySelector('#sqlForm').requestSubmit()`);
    await idle();
    const diagnosticInput = operations.filter(operation => operation.action === 'sqlDiagnose').at(-1).input;
    assert.equal(diagnosticInput.useInstalled, true);
    for (const name of ['appUsername','appPassword','gameUsername','gamePassword','host','gameDatabase']) assert.equal(Object.hasOwn(diagnosticInput,name), false);
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="install"]').click();`);
    onboardingMode = 'success';
    await window.webContents.executeJavaScript(`document.querySelector('[name="sqlPassword"]').value='TemporaryPrivate123!'; document.querySelector('[name="adminName"]').value='Owner'; document.querySelector('[name="adminEmail"]').value='owner@example.test'; document.querySelector('[name="adminPassword"]').value='AdminPrivate123!'; document.querySelector('#resumeInstall').click();`);
    await idle();
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').open`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').dataset.kind`), 'success');
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#outcomeIcon').textContent`), '✓');
    assert.equal(await window.webContents.executeJavaScript(`scrollY`), 0, 'Successful installation shows the top of Control Panel');
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-page="install"]').hidden`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installForm')`), null);
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('#uninstallForm'))`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('nav [data-page]:not([hidden])').length`), 8);
    await fs.writeFile(`artifacts/review/installation-complete-${locale}.png`, (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('#outcomeContinue').click()`);
    const readyLoad = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload(); await readyLoad;
    await window.webContents.executeJavaScript(`new Promise(resolve=>{const timer=setInterval(()=>{if(document.querySelector('main').getAttribute('aria-busy')==='false'){clearInterval(timer);resolve();}},10);})`);
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('#webVersion'))`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-page="install"]').hidden`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#installationOutcome').open`), false, 'Completed-install notification does not repeat on startup');
  }
  onboardingMode = null;
  console.log('PASS: all nine pages in EN/BG, support/company links, branding and compact navigation, SQL diagnostic evidence and explicit change confirmation, persistent language, preserved unsent fields, permanent donate footer, sandbox bridge, administrator form, password cleanup, delayed modal progress, live setup stages, final status refresh, error focus/scroll and check-only updates; first-run navigation, reboot/success dialogs and verified Control Panel routing in EN/BG. Screenshots: artifacts/review/.');
}
app.whenReady().then(smoke).then(() => { clearTimeout(timer); app.exit(0); }).catch(error => { clearTimeout(timer); console.error(error); app.exit(1); });
