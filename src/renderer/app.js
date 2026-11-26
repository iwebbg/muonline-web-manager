import { siteSettingsPage, receiveSiteSettings, siteSettingsInput, bindSiteSettings, syncSiteSecretControls } from './site-settings/view.js';
import { publicInstallationSettings } from '../shared/installation-settings.js';
import { InstallationOutcome } from './outcome.js';
import { OperationProgress } from './progress.js';
import { servicesPanel, populateServices, bindServices } from './services.js';
import { resolveLocale, translate } from '../shared/i18n.js';
import { translateMessage } from '../shared/messages.js';
import { sqlPage, populateSql, bindSql, sqlInput } from './sql/view.js';
import { supportPage } from './support/view.js';
import { administratorsPage, populateAdministrators, receiveAdministrators, administratorState } from './admins/view.js';

const content = document.querySelector('#content');
const output = document.querySelector('#output');
const progress = new OperationProgress();
const outcome = new InstallationOutcome();
let page = 'install';
let measuredInitialStatus = false;
let busy = false;
let settings = {};
let pendingInstallationDraft = null;
let draftSaving = null;
let draftSaveFailed = false;
let feeds = {};
let status = null;
let localSqlSuggestion = null;
let statusCheckedAt = null;
let statusEpoch = 0;
let refreshingServices = false;
const sqlState = { inventory: null, report: null, plan: null, fields: {}, installed: null };
let language = resolveLocale(navigator.language);
let lastOutput = { kind: 'welcome' };
let lastAction = '';

/** Translate interface strings using the current persisted panel language. */
function t(key, values = {}) {
  const text = translate(language, key, values);
  return settings.development && ['installLead', 'dockerWarning'].includes(key) ? text.replaceAll('Ubuntu-24.04', 'MuOnline-Dev') : text;
}

/** Expose the full manager only after a measured ready installation. */
function updateNavigation() {
  const ready = status?.installed === true && status.phase === 'ready';
  for (const button of document.querySelectorAll('nav [data-page]')) {
    button.hidden = button.dataset.page === 'install' ? ready : !ready && !['sql', 'support'].includes(button.dataset.page);
  }
}

/** Translate the fixed shell without exposing remote strings as HTML. */
function translateShell() {
  updateNavigation();
  renderSetupProgress();
  const devNotice = document.querySelector('#devNotice');
  devNotice.hidden = !settings.development;
  devNotice.textContent = settings.development ? t('devNotice') : '';
  document.documentElement.lang = language;
  document.querySelector('#copyrightYear').textContent = new Date().getFullYear();
  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-label]').forEach(element => {
    element.setAttribute('aria-label', t(element.dataset.i18nLabel));
  });
  document.querySelector('#language').value = language;
  document.querySelector('#language').setAttribute('aria-label', t('language'));
  document.querySelector('#activity').textContent = t(busy ? 'running' : 'ready');
  document.querySelector('#operation').textContent = lastAction ? actionLabel(lastAction) : '';
}

/** Setup progress contains only main-owned stage names, a public draft and the Linux identity. */
function renderSetupProgress() {
  const element = document.querySelector('#setupNotice');
  const setup = settings.setup;
  element.hidden = !setup?.stage && !setup?.linuxUser;
  const parts = [];
  if (setup?.stage && setup?.status) parts.push(t('setupProgress', { stage: t('setup.stage.' + setup.stage), status: t('setup.status.' + setup.status) }));
  const access = document.querySelector('#linuxAccess');
  if (access) access.textContent = setup?.linuxUser ? t('linuxIdentity', { distribution: setup.distribution, user: setup.linuxUser }) : '';
  if (setup?.stage === 'ready' && setup?.status === 'complete') element.hidden = true;
  element.textContent = parts.join(' ');
}

async function refreshSetupStatus() {
  const response = await window.manager?.invoke('setupStatus');
  if (response?.ok && response.result?.schema === 1) {
    settings.setup = response.result;
    progress.setup(response.result);
    renderSetupProgress();
    if (busy && ['install', 'resumeInstall'].includes(lastAction) && response.result.completed?.includes('sqlNetwork')) {
      const form = document.querySelector('#installForm');
      const draft = response.result.configuration;
      if (form && draft?.sqlHost) {
        form.elements.sqlHost.value = draft.sqlHost;
        form.elements.sqlPort.value = draft.sqlPort ?? '1433';
      }
    }
  }
}

/** Present operation names without translating the underlying IPC identifiers. */
function actionLabel(action) {
  const names = { siteSettings: 'site.reload', saveSiteSettings: 'site.save', sqlSuggest: 'sqlSetup.detect', uninstallRuntime: 'uninstall.title', openLogs: 'logs.open', setGameWrites: 'writes.apply', openWebsite: 'openWebsite', openAdmin: 'openAdmin', adminList: 'admins.refresh', adminUpdate: 'admins.save', adminDelete: 'admins.delete', sqlInspect: 'sql.inspect', sqlDiagnose: 'sql.run', sqlPlan: 'sql.preview', sqlApply: 'sql.apply', sqlCopyReport: 'sql.copyReport', sqlCopyPlan: 'sql.copyCommand', status: 'checkStatus', admin: 'createAdmin', backup: 'createBackup', update: 'updateWeb', updates: 'checkUpdates', access: 'applyAccess', settings: 'settingsTitle' };
  return t(names[action] ?? action);
}

/** Keep technical logs and SQL diagnostics verbatim while translating application messages. */
function renderOutput() {
  if (lastOutput.kind === 'welcome') {
    output.textContent = t('welcome');
  } else if (lastOutput.kind === 'working') {
    const shortWorking = { openWebsite: 'openWebsite', openAdmin: 'openAdmin', admin: 'createAdmin', adminList: 'admins.refresh', adminUpdate: 'admins.save', adminDelete: 'admins.delete', sqlInspect: 'sql.working', sqlDiagnose: 'sql.working', sqlPlan: 'sql.preparing', sqlApply: 'sql.applying', sqlCopyReport: 'sql.copying', sqlCopyPlan: 'sql.copying' };
    output.textContent = shortWorking[lastOutput.action] ? t(shortWorking[lastOutput.action]) : t('working', { action: actionLabel(lastOutput.action) });
  } else if (lastOutput.kind === 'error') {
    output.textContent = translateMessage(language, lastOutput.message) + (lastOutput.sqlSuggestion ? '\n' + t('sqlSetup.suggest', lastOutput.sqlSuggestion) : '') + (lastOutput.logFile ? '\n' + t('logs.errorFile', { file: lastOutput.logFile }) : lastOutput.logUnavailable ? '\n' + t('logs.unavailable') : '');
  } else {
    const value = lastOutput.value;
    if (['install', 'resumeInstall'].includes(lastOutput.action)) { output.textContent = t('installationCompleteShort'); return; }
    if (['logs', 'openLogs'].includes(lastOutput.action)) { output.textContent = t('logs.opened'); return; }
    if (lastOutput.action === 'sqlSuggest') { output.textContent = t(localSqlSuggestion ? 'sqlSetup.suggest' : 'sqlSetup.notDetected', localSqlSuggestion ?? {}); return; }
    if (['siteSettings', 'saveSiteSettings'].includes(lastOutput.action)) { output.textContent = t(lastOutput.action === 'siteSettings' ? 'site.loaded' : 'site.saved'); return; }
    if (lastOutput.action === 'status') { output.textContent = t('statusRefreshed'); return; }
    if (lastOutput.action === 'prerequisites') { output.textContent = t('prerequisitesReady'); return; }
    if (lastOutput.action === 'uninstallRuntime') { output.textContent = t('uninstall.done'); return; }
    if (lastOutput.action === 'setGameWrites') {
      output.textContent = t(value.restarted ? 'writes.saved' : 'writes.unchanged');
      return;
    }
    if (['openWebsite', 'openAdmin'].includes(lastOutput.action) && value?.opened) {
      output.textContent = t('openedInBrowser');
      return;
    }
    if (['adminList', 'adminUpdate', 'adminDelete'].includes(lastOutput.action)) {
      output.textContent = t(value.code ? 'admins.error.' + value.code : lastOutput.action === 'adminList' ? 'admins.loaded' : 'admins.saved');
      return;
    }
    const sqlSummary = { sqlInspect: 'sql.inventoryReady', sqlDiagnose: 'sql.reportReady', sqlPlan: 'sql.planReady' };
    if (sqlSummary[lastOutput.action]) {
      output.textContent = t(sqlSummary[lastOutput.action]);
      return;
    }
    if (['sqlCopyReport', 'sqlCopyPlan'].includes(lastOutput.action) && value?.copied) {
      output.textContent = t('sql.copied');
      return;
    }
    if (lastOutput.action === 'sqlApply') {
      output.textContent = t('sql.result.' + value.reason);
      return;
    }
    output.textContent = typeof value === 'string'
      ? (lastOutput.action === 'logs' ? value : translateMessage(language, value))
      : JSON.stringify(value, (key, item) => key === 'error' || key === 'runtimeError' ? translateMessage(language, item) : item, 2);
  }
}

/** Change UI language while keeping unsent form values only in memory. */
function changeLanguage(value, preserveFields = true) {
  const fields = (preserveFields ? [...content.querySelectorAll('input, select')] : []).map(field => ({ name: field.name, value: field.value, checked: field.checked }));
  language = resolveLocale(value);
  render();
  for (const saved of fields) {
    const field = content.querySelector('[name="' + saved.name + '"]');
    if (field) {
      field.value = saved.value;
      if (field.type === 'checkbox') {
        field.checked = saved.checked;
      }
    }
  }
  if (page === 'site') syncSiteSecretControls(document.querySelector('#siteSettingsForm'));
  if (page === 'sql') populateSql(t, sqlState, perform);
  renderOutput();
}

/** Generate only static, application-owned access form markup. */
function accessFields() {
  return `<div class="grid"><label>${t('accessMode')}<select name="mode"><option value="local">${t('localMode')}</option><option value="ip">${t('ipMode')}</option><option value="domain">${t('domainMode')}</option></select></label><label>${t('accessHost')}<input name="host" placeholder="mu.example.com"></label><label>${t('acmeEmail')}<input name="acmeEmail" type="email" placeholder="admin@example.com"></label></div><label class="check"><input type="checkbox" name="httpAcknowledged">${t('httpWarning')}</label>`;
}

/** Render the administrator prompts supported by the real Laravel command. */
function adminFields() {
  return `<div class="grid"><label>${t('adminName')}<input name="adminName" required maxlength="255" autocomplete="off"></label><label>${t('email')}<input name="adminEmail" required type="email" autocomplete="off"></label></div><label>${t('adminPassword')}<input name="adminPassword" type="password" required minlength="12" autocomplete="new-password"></label>`;
}

/** Render temporary backup authorization fields, never persisted by the panel. */
function backupFields() {
  return `<div class="warning">${t('backupWarning')}</div><div class="grid"><label>${t('backupUsername')}<input name="backupUsername" required autocomplete="off"></label><label>${t('sqlPassword')}<input name="backupPassword" type="password" required autocomplete="off"></label></div><label>${t('backupDirectory')}<input name="backupDirectory" placeholder="D:\\MuBackups" required></label>`;
}

/** Runtime removal stays in Control Panel, separate from first-install prompts. */
function uninstallPanel() {
  return `<details class="panel uninstall-panel"><summary>${t('uninstall.title')}</summary><p class="warning">${t('uninstall.warning', { distribution: settings.distribution ?? 'Ubuntu-24.04' })}</p><button type="button" data-action="status">${t('checkStatus')}</button><p id="uninstallTarget" class="hint"></p><button type="button" id="uninstallBackup">${t('uninstall.backup')}</button><form id="uninstallForm"><div id="uninstallSqlFields"><label>${t('sqlAdmin')}<input id="uninstallSqlAdmin" autocomplete="off" maxlength="128"></label><label>${t('sqlPassword')}<input id="uninstallSqlPassword" type="password" autocomplete="off" maxlength="4096"></label><label class="check"><input id="uninstallSqlConfirm" type="checkbox">${t('uninstall.sqlConfirm')}</label></div><label>${t('uninstall.typeName', { distribution: settings.distribution ?? 'Ubuntu-24.04' })}<input id="uninstallName" autocomplete="off" spellcheck="false"></label><label class="check"><input id="uninstallConfirm" type="checkbox">${t('uninstall.confirm')}</label><button class="danger" id="uninstallButton" type="submit" disabled>${t('uninstall.title')}</button></form></details>`;
}

/** Render the selected page while keeping the donation footer outside page routing. */
function render() {
  translateShell();
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('selected', button.dataset.page === page));
  const pages = {
    site: siteSettingsPage(t, language),
    sql: sqlPage(t),
    support: supportPage(t),
    overview: `<h1>${t('overviewTitle')}</h1><p class="lead">${t('overviewLead')}</p><div class="actions website-links"><button type="button" class="primary" data-action="openWebsite" disabled>${t('openWebsite')} ↗</button><button type="button" data-action="openAdmin" disabled>${t('openAdmin')} ↗</button></div><p id="websiteLinksHint" class="hint">${t('websiteLinksHint')}</p><div class="cards"><div class="card"><small>${t('webApplicationLabel')}</small><strong id="webVersion">${t('unchecked')}</strong><p>${t('webVersionHint')}</p></div><div class="card"><small>${t('accessLabel')}</small><strong id="accessMode">${t('unchecked')}</strong><p id="siteUrl">localhost / IP / Domain + SSL</p></div><div class="card"><small>${t('managerLabel')}</small><strong id="managerVersion">0.2.0</strong><p>${t('managerDescription')}</p></div></div>${servicesPanel(t)}${uninstallPanel()}`,
    install: `<h1>${t('installTitle')}</h1><p class="lead">${t('installLead')}</p><p id="installRelease" class="hint"></p><form id="installForm"><h2>${t('sqlTitle')}</h2><div class="grid"><label>${t('sqlHost')}<input name="sqlHost" required value="127.0.0.1" placeholder="192.168.1.10"></label><label>${t('sqlPort')}<input name="sqlPort" type="number" min="1" max="65535" value="1433" required></label><label>${t('sqlAdmin')}<input name="sqlAdmin" value="sa" required autocomplete="off"></label><label>${t('sqlPassword')}<input name="sqlPassword" type="password" required autocomplete="off"></label><label>${t('profile')}<select name="profile" id="profiles" required></select></label><label>${t('appEnv')}<select name="appEnv"><option value="local">local</option><option value="production">production</option></select></label><label>${t('gameDatabase')}<input name="gameDatabase" value="MuOnline" required></label><label>${t('webDatabase')}<input name="webDatabase" value="MuOnline_Web" required></label><label>${t('appLogin')}<input name="appLogin" value="muonline_web_app" required></label><label>${t('gameLogin')}<input name="gameLogin" value="muonline_web_user" required></label></div><p class="hint">${t('sqlSetup.automaticHint')}</p><p class="hint">${t('sqlSetup.temporary')}</p><div class="actions"><button type="button" id="detectSqlHost">${t('sqlSetup.detect')}</button><button type="button" id="useSqlHost" hidden>${t('sqlSetup.use')}</button></div><p class="hint" id="sqlEndpointHint"></p><p class="warning" id="savedSqlEndpoint" hidden></p><label class="check" id="sqlEndpointConfirmation" hidden><input name="confirmSqlEndpoint" type="checkbox">${t('sqlSetup.confirm')}</label><label class="check"><input name="trustCertificate" type="checkbox" checked>${t('trustCertificate')}</label><p class="hint">${t('passwordHint')}</p><fieldset><legend>${t('access')}</legend>${accessFields()}</fieldset><fieldset><legend>${t('firstAdmin')}</legend>${adminFields()}</fieldset><div class="actions"><button class="primary" type="submit">${t('install')}</button><button type="button" id="resumeInstall">${t('resumeInstall')}</button></div><p class="hint">${t('resumeHint')}</p><p id="installationDraftNotice" class="hint" aria-live="polite"></p></form><details class="panel install-helpers"><summary>${t('install.helpers')}</summary><p class="hint">${t('install.helpersHint')}</p><div class="actions"><button data-action="prerequisites">${t('prerequisites')}</button><button data-action="installWsl">${t('installWsl')}</button><button data-action="installDocker">${t('installDocker')}</button><button type="button" id="openSqlTroubleshooting">${t('sql.title')}</button></div> <div class="warning">${t('dockerWarning')}</div><p id="linuxAccess" class="hint"></p><button type="button" data-action="openLogs">${t('logs.open')}</button><button type="button" data-open-page="overview">${t('installation.maintenance')}</button></details>`,
    access: `<h1>${t('accessTitle')}</h1><p class="lead">${t('accessLead')}</p><form id="accessForm">${accessFields()}<div class="warning">${t('accessWarning')}</div><button class="primary" type="submit">${t('applyAccess')}</button></form>`,
    admins: administratorsPage(t, adminFields()),
    backup: `<h1>${t('backupTitle')}</h1><p class="lead">${t('backupLead')}</p><form id="backupForm">${backupFields()}<button class="primary" type="submit">${t('createBackup')}</button></form><p class="hint">${t('backupHint')}</p>`,
    updates: `<h1>${t('updatesTitle')}</h1><p class="lead">${t('updatesLead')}</p><div class="actions"><button data-action="updates">${t('checkUpdates')}</button></div><div class="update-panels"><div class="panel"><h2>${t('managerTitle')}</h2><p id="managerFeed"></p><button data-action="updateManager">${t('updateManager')}</button></div><form id="updateForm"><h2>${t('webTitle')}</h2><p id="webFeed"></p><p class="hint">${t('updateHint')}</p>${backupFields()}<label class="check"><input type="checkbox" name="migrationAcknowledged" required>${t('migrationWarning')}</label><button class="primary" type="submit">${t('updateWeb')}</button></form></div><details class="panel advanced"><summary>${t('advancedSettings')}</summary><p class="hint">${t('downloadServerHint')}</p><form id="settingsForm"><label>${t('cdn')}<input name="cdn" type="url" required></label><button type="submit">${t('saveSettings')}</button></form></details>`,

  };
  content.innerHTML = pages[page];
  document.querySelector('.console').hidden = page === 'support';
  populate(true);
  bind();
  bindSiteSettings(document.querySelector('#siteSettingsForm'));
}

/** Explain version state without exposing repository paths or signature configuration. */
function releaseDescription(feed, kind) {
  if (!feed) {
    return t('checkingVersion');
  }
  if (feed.error) {
    return feed.latestVersion ? t('pendingRelease', { version: feed.latestVersion }) : t('versionCheckFailed');
  }
  if (kind === 'manager') {
    return t(feed.available ? 'newWebVersion' : 'upToDate', { version: feed.version });
  }
  const installed = feed.installationKnown
    ? t('installedVersion', { version: feed.installedVersion ?? t('notInstalled') })
    : t('unknownInstalled');
  const latest = feed.available ? t('newWebVersion', { version: feed.version })
    : t(feed.installedVersion === feed.version ? 'upToDate' : 'latestStable', { version: feed.version });
  return installed + '\n' + latest;
}

/** Populate dynamic values using text/value properties, never release-supplied HTML. */
function populate(fillSettings = false) {
  renderSetupProgress();
  if (page === 'admins') {
    populateAdministrators(t, language, perform);
  }
  if (page === 'sql') {
    sqlState.installed = status?.installed ?? null;
    populateSql(t, sqlState, perform, fillSettings);
  }
  const notice = document.querySelector('#updateNotice');
  notice.hidden = !(feeds.web?.available || feeds.web?.newTag || feeds.manager?.available);
  notice.textContent = feeds.web?.newTag && !feeds.web.ready && !feeds.manager?.available
    ? t('pendingRelease', { version: feeds.web.latestVersion })
    : t('updateNotification');
  if (page === 'access' && fillSettings && status?.installed && status.access) {
    const form = document.querySelector('#accessForm');
    form.elements.mode.value = status.access.mode;
    form.elements.host.value = status.access.host ?? '';
    form.elements.acmeEmail.value = status.access.email ?? '';
  }
  if (page === 'install') {
    const endpoint = status?.phase === 'bootstrap-pending' ? status.bootstrapSqlEndpoint : null;
    const form = document.querySelector('#installForm');
    document.querySelector('#savedSqlEndpoint').hidden = !endpoint;
    document.querySelector('#savedSqlEndpoint').textContent = endpoint ? t('sqlSetup.saved', endpoint) : '';
    document.querySelector('#sqlEndpointConfirmation').hidden = !endpoint;
    form.elements.confirmSqlEndpoint.required = Boolean(endpoint && (form.elements.sqlHost.value !== endpoint.host || Number(form.elements.sqlPort.value) !== endpoint.port));
    document.querySelector('#sqlEndpointHint').textContent = t(localSqlSuggestion ? 'sqlSetup.suggest' : 'sqlSetup.hint', localSqlSuggestion ?? {});
    document.querySelector('#useSqlHost').hidden = !localSqlSuggestion;
    const feed = feeds.web;
    document.querySelector('#installRelease').textContent = feed?.ready ? t('installRelease', { version: feed.version }) : releaseDescription(feed, 'web');

  }
  if (page === 'overview') {
    const target = status?.uninstallTarget;
    document.querySelector('#uninstallTarget').textContent = target
      ? t('uninstall.target', target) : t(status?.installed === false ? 'uninstall.noSql' : 'uninstall.checkFirst');
    document.querySelector('#uninstallSqlFields').hidden = status?.installed === false;
    updateUninstallButton();
  }
  if (page === 'overview') {
    populateServices(t, status, busy, statusCheckedAt, lastAction);
    const available = status?.installed === true && status.phase === 'ready';
    for (const action of ['openWebsite', 'openAdmin']) {
      document.querySelector('[data-action="' + action + '"]').disabled = busy || !available;
    }
    document.querySelector('#websiteLinksHint').hidden = available;
  }
  if (page === 'overview' && status?.installed) {
    document.querySelector('#webVersion').textContent = status.version;
    document.querySelector('#accessMode').textContent = status.access.mode.toUpperCase();
    document.querySelector('#siteUrl').textContent = status.access.url;

  }
  if (page === 'install') {
    renderDraftNotice();
    const select = document.querySelector('#profiles');
    const selected = select.value || settings.setup?.configuration?.profile;
    select.replaceChildren();
    for (const profile of feeds.web?.profiles ?? []) {
      const option = document.createElement('option');
      option.value = profile;
      const labelKey = 'profile.' + profile;
      const label = t(labelKey);
      option.textContent = label === labelKey ? profile : label;
      select.append(option);
    }
    if ([...select.options].some(option => option.value === selected)) {
      select.value = selected;
    }
    if (!select.options.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = t('signedReleaseRequired');
      select.append(option);
    }
    if (fillSettings && settings.setup?.configuration) {
      const draft = settings.setup.configuration;
      const form = document.querySelector('#installForm');
      for (const key of ['sqlAdmin', 'sqlHost', 'sqlPort', 'profile', 'appEnv', 'gameDatabase', 'webDatabase', 'appLogin', 'gameLogin', 'trustCertificate']) {
        const field = form.elements.namedItem(key);
        if (field && Object.hasOwn(draft, key)) {
          if (field.type === 'checkbox') field.checked = draft[key];
          else field.value = draft[key];
        }
      }
      for (const [key, name] of [['name', 'adminName'], ['email', 'adminEmail']]) {
        if (Object.hasOwn(draft.administrator ?? {}, key)) form.elements[name].value = draft.administrator[key];
      }
      for (const [key, name] of [['mode', 'mode'], ['host', 'host'], ['email', 'acmeEmail'], ['httpAcknowledged', 'httpAcknowledged']]) {
        const field = form.elements.namedItem(name);
        if (field && Object.hasOwn(draft.access ?? {}, key)) {
          if (field.type === 'checkbox') field.checked = draft.access[key];
          else field.value = draft.access[key];
        }
      }
    }
  }
  if (page === 'updates') {
    for (const kind of ['web', 'manager']) {
      const feed = feeds[kind];
      document.querySelector('#' + kind + 'Feed').textContent = releaseDescription(feed, kind);
    }
    document.querySelector('[data-action="updateManager"]').disabled = busy || !feeds.manager?.available;
    document.querySelector('#updateForm button[type="submit"]').disabled = busy || !feeds.web?.available;
    if (fillSettings) {
      for (const key of ['cdn']) {
        document.querySelector('[name="' + key + '"]').value = settings[key] ?? '';
      }
    }
  }
}

/** Save only public form values; passwords and confirmation grants never cross this IPC. */
function rememberInstallationDraft() {
  const form = document.querySelector('#installForm');
  if (!form || busy) return;
  const draft = publicInstallationSettings(installationInput(new FormData(form)).settings);
  // The signed profile list arrives asynchronously; an empty loading select is not an edit.
  if (!draft.profile && settings.setup?.configuration?.profile) draft.profile = settings.setup.configuration.profile;
  settings.setup = { ...settings.setup, configuration: draft };
  pendingInstallationDraft = draft;
  void flushInstallationDraft();
}

/** Coalesce rapid edits and finish pending disk writes before another backend operation. */
async function flushInstallationDraft() {
  if (draftSaving) return draftSaving;
  if (!pendingInstallationDraft || !window.manager) return;
  draftSaving = (async () => {
    while (pendingInstallationDraft) {
      const draft = pendingInstallationDraft;
      pendingInstallationDraft = null;
      try {
        const response = await window.manager.invoke('saveInstallationDraft', { settings: draft });
        if (!response?.ok) throw new Error('Draft save failed');
        draftSaveFailed = false;
      } catch {
        pendingInstallationDraft ??= draft;
        draftSaveFailed = true;
        break;
      }
    }
  })();
  try { await draftSaving; } finally { draftSaving = null; renderDraftNotice(); }
}

function renderDraftNotice() {
  const notice = document.querySelector('#installationDraftNotice');
  if (notice) notice.textContent = t(draftSaveFailed ? 'installation.draftFailed' : 'installation.draftHint');
}

/** Read the validated access form independently of APP_ENV. */
function accessInput(data) {
  return { mode: data.get('mode'), host: data.get('host'), email: data.get('acmeEmail'), httpAcknowledged: data.has('httpAcknowledged') };
}

/** Build administrator prompt input without exposing it in UI results. */
function administratorInput(data) {
  return { name: data.get('adminName'), email: data.get('adminEmail'), password: data.get('adminPassword') };
}

function receiveSqlEndpoint(endpoint) {
  const form = document.querySelector('#installForm');
  if (form && endpoint && typeof endpoint.host === 'string' && Number.isInteger(endpoint.port)) {
    form.elements.sqlHost.value = endpoint.host;
    form.elements.sqlPort.value = endpoint.port;
  }
}

function installationInput(data) {
  const values = Object.fromEntries(data.entries());
  values.trustCertificate = data.has('trustCertificate');
  values.access = accessInput(data);
  values.administrator = administratorInput(data);
  values.sqlEndpointChange = { confirmed: data.has('confirmSqlEndpoint'), expected: status?.bootstrapSqlEndpoint ?? null };
  delete values.confirmSqlEndpoint;
  delete values.adminPassword;
  return { settings: values };
}

/** Build temporary SQL backup authorization passed directly to the runtime. */
function backupInput(data) {
  return { username: data.get('backupUsername'), password: data.get('backupPassword'), directory: data.get('backupDirectory') };
}

/** Invoke a serialized operation; erase submitted secrets after success or failure. */
async function perform(action, input = {}, quiet = false) {
  if (busy) {
    return;
  }
  let operationResult;
  let operationFailed = false;
  let restartPending = false;
  let installationVerified = false;
  if (!quiet) document.querySelector('.console').classList.remove('operation-error');
  const progressToken = progress.begin(action, actionLabel(action), t, quiet);
  busy = true;
  statusEpoch++;
  document.querySelector('#activity').textContent = t('running');
  lastAction = action;
  document.querySelector('#operation').textContent = actionLabel(action);
  document.querySelector('#language').disabled = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  if (!quiet) {
    lastOutput = { kind: 'working', action };
    renderOutput();
  }
  populate();
  const trackSetup = ['install', 'resumeInstall', 'installWsl', 'installDocker'].includes(action);
  const progressTimer = trackSetup ? setInterval(() => { refreshSetupStatus().catch(() => {}); }, 1000) : null;
  try {
    if (!window.manager) {
      throw new Error(t('previewError'));
    }
    await flushInstallationDraft();
    const response = await window.manager.invoke(action, input);
    if (!response.ok) {
      throw Object.assign(new Error(response.error), { logFile: response.logFile, logUnavailable: response.logUnavailable, code: response.code, sqlSuggestion: response.sqlSuggestion, sqlResolvedEndpoint: response.sqlResolvedEndpoint, bootstrapSqlEndpoint: response.bootstrapSqlEndpoint });
    }
    const result = response.result;
    operationResult = result;
    if (['install', 'resumeInstall'].includes(action)) receiveSqlEndpoint(result?.sqlResolvedEndpoint);
    if (['adminList', 'adminUpdate', 'adminDelete'].includes(action) && result?.code) operationFailed = true;
    if (['adminList', 'adminUpdate', 'adminDelete'].includes(action)) {
      receiveAdministrators(action, result);
    }
    if (action === 'sqlSuggest') {
      localSqlSuggestion = result.suggestion;
      const form = document.querySelector('#installForm');
      if (form && localSqlSuggestion && !status?.installed && (!form.elements.sqlHost.value || ['localhost', '127.0.0.1', '::1'].includes(form.elements.sqlHost.value))) {
        form.elements.sqlHost.value = localSqlSuggestion.host;
        form.elements.sqlPort.value = localSqlSuggestion.port;
      }
    }
    if (action === 'sqlInspect') {
      sqlState.inventory = result;
      sqlState.plan = null;
    }
    if (action === 'sqlDiagnose') {
      sqlState.report = result;
      sqlState.plan = null;
    }
    if (action === 'sqlPlan') {
      sqlState.plan = result;
    }
    if (action === 'sqlApply') {
      sqlState.plan = null;
      sqlState.report = null;
    }
    if (['siteSettings', 'saveSiteSettings'].includes(action)) {
      receiveSiteSettings(result);
      if (page === 'site') render();
    }
    if (action === 'settings') {
      settings = result;
      changeLanguage(settings.language ?? language, false);
    }
    if (action === 'setLanguage') {
      settings.language = result.language;
      changeLanguage(result.language);
    }
    if (action === 'updates') {
      feeds = result;
      populate();
    }
    if (action === 'status') {
      status = result;
      if (!measuredInitialStatus) {
        measuredInitialStatus = true;
        page = status?.installed === true && status.phase === 'ready' ? 'overview' : 'install';
        render();
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
      updateNavigation();
      statusCheckedAt = Date.now();
      sqlState.installed = result?.installed === true;
      populate();
    }
    if (action === 'uninstallRuntime') {
      receiveSiteSettings(null);
      status = { installed: false };
      sqlState.installed = false;
      sqlState.lastInstalled = false;
      sqlState.useInstalled = undefined;
      sqlState.report = null;
      sqlState.plan = null;
      pendingInstallationDraft = null;
      draftSaveFailed = false;
      settings.setup = { schema: 1, completed: [], configuration: {} };
      feeds = {};
      page = 'install';
      render();
    }
    if (action === 'saveSettings') {
      settings = { ...settings, ...input };
      feeds = {};
    }
    if (!quiet) {
      lastOutput = { kind: 'result', action, value: result };
      renderOutput();
      if (response.logUnavailable) output.textContent += '\n' + t('logs.unavailable');
    }
  } catch (error) {
    restartPending = error.code === 'WSL_RESTART_REQUIRED';
    operationFailed = !restartPending;
    if (['install', 'resumeInstall'].includes(action)) {
      receiveSqlEndpoint(error.sqlResolvedEndpoint);
      if (error.bootstrapSqlEndpoint) {
        status = { ...status, installed: true, phase: 'bootstrap-pending', bootstrapSqlEndpoint: error.bootstrapSqlEndpoint };
        sqlState.installed = true;
      }
      localSqlSuggestion = error.sqlSuggestion ?? null;
    }
    if (['adminList', 'adminUpdate', 'adminDelete'].includes(action)) {
      administratorState.error = { code: 'commandUnavailable' };
      if (action === 'adminList') {
        administratorState.rows = null;
        administratorState.mode = null;
        administratorState.selected = null;
      }
    }
    if (action === 'sqlApply') {
      sqlState.plan = null;
      sqlState.report = null;
    }
    if (!quiet || action === 'setLanguage') {
      lastOutput = { kind: 'error', message: error.message, logFile: error.logFile, logUnavailable: error.logUnavailable, sqlSuggestion: error.sqlSuggestion };
      renderOutput();
    }
  } finally {
    if (action === 'saveSiteSettings') {
      const confirmation = document.querySelector('[name="siteConfirmed"]');
      if (confirmation) confirmation.checked = false;
    }
    if (action === 'setGameWrites') {
      const confirmation = document.querySelector('#gameWritesConfirm');
      if (confirmation) confirmation.checked = false;
    }
    if (progressTimer) clearInterval(progressTimer);
    if (trackSetup) await refreshSetupStatus().catch(() => {});
    if (['saveSiteSettings', 'uninstallRuntime', 'install', 'resumeInstall', 'admin', 'backup', 'update', 'sqlDiagnose', 'adminUpdate'].includes(action)) {
      document.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
    }
    busy = false;
    if (action === 'sqlSuggest') rememberInstallationDraft();
    const uninstallButton = document.querySelector('#uninstallButton');
    if (uninstallButton) { document.querySelector('#uninstallSqlConfirm').checked = false; document.querySelector('#uninstallConfirm').checked = false; document.querySelector('#uninstallName').value = ''; }
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    document.querySelector('#language').disabled = false;
    translateShell();
    populate();
    if (uninstallButton) uninstallButton.disabled = true;
    const endpointConfirmation = document.querySelector('[name="confirmSqlEndpoint"]');
    if (endpointConfirmation) endpointConfirmation.checked = false;
  }
  try {
    if (['install', 'resumeInstall', 'update', 'saveSettings'].includes(action) && lastOutput.kind === 'result') {
      progress.verifying(progressToken);
      const verified = await perform('status', {}, true);
      installationVerified = ['install', 'resumeInstall'].includes(action) && verified?.installed === true && verified.phase === 'ready';
      if (installationVerified) { page = 'overview'; render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
      await perform('updates', {}, true);
    }
    if ((['access', 'start', 'stop', 'restart'].includes(action) && lastOutput.kind === 'result') || ['setGameWrites', 'saveSiteSettings'].includes(action)) {
      progress.verifying(progressToken);
      await perform('status', {}, true);
    }
    if (action === 'admin' && lastOutput.kind === 'result') {
      progress.verifying(progressToken);
      await perform('adminList', {}, true);
    }
  } finally {
    progress.finish(progressToken, operationFailed && !quiet);
    if (restartPending && !quiet) outcome.show('restart', t);
    else if (installationVerified && !quiet) outcome.show('success', t);
  }
  return operationResult;
}

/** Localize browser validation without sending values or changing constraint rules. */
function localizeValidation(field) {
  field.setCustomValidity('');
  const validity = field.validity;
  if (validity.valueMissing) {
    field.setCustomValidity(t(field.type === 'checkbox' ? 'requiredCheckbox' : 'required'));
  } else if (validity.typeMismatch) {
    field.setCustomValidity(t(field.type === 'email' ? 'invalidEmail' : 'invalidUrl'));
  } else if (validity.tooShort) {
    field.setCustomValidity(t('tooShort', { min: field.minLength }));
  } else if (validity.rangeUnderflow || validity.rangeOverflow) {
    field.setCustomValidity(t('outOfRange', { min: field.min, max: field.max }));
  } else if (!validity.valid) {
    field.setCustomValidity(t('invalidValue'));
  }
}

/** Require current displayed SQL targets and separate irreversible deletion confirmations. */
function updateUninstallButton() {
  const button = document.querySelector('#uninstallButton');
  if (!button) return;
  const sqlReady = status?.installed === false || (status?.uninstallTarget
    && document.querySelector('#uninstallSqlConfirm').checked
    && document.querySelector('#uninstallSqlAdmin').value.trim()
    && document.querySelector('#uninstallSqlPassword').value);
  button.disabled = busy || !sqlReady || document.querySelector('#uninstallName').value !== settings.distribution
    || !document.querySelector('#uninstallConfirm').checked;
}

/** Bind only the static forms and fixed action names rendered on the current page. */
function bind() {
  const uninstallForm = document.querySelector('#uninstallForm');
  if (uninstallForm) {
    const updateUninstall = updateUninstallButton;
    document.querySelector('#uninstallBackup').addEventListener('click', () => {
      if (busy) return;
      page = 'backup';
      render();
    });
    uninstallForm.addEventListener('input', updateUninstall);
    uninstallForm.addEventListener('change', updateUninstall);
    uninstallForm.addEventListener('submit', event => {
      event.preventDefault();
      if (document.querySelector('#uninstallButton').disabled) return;
      perform('uninstallRuntime', {
        confirmed: document.querySelector('#uninstallConfirm').checked,
        distributionConfirmation: document.querySelector('#uninstallName').value,
        sqlRemoval: {
          confirmed: document.querySelector('#uninstallSqlConfirm').checked,
          target: status?.uninstallTarget,
          admin_username: document.querySelector('#uninstallSqlAdmin').value,
          admin_password: document.querySelector('#uninstallSqlPassword').value
        }
      });
    });
  }
  bindServices(t, () => ({ status, busy, checkedAt: statusCheckedAt, action: lastAction }), perform);
  if (page === 'sql') {
    bindSql(t, sqlState, perform);
  }
  content.querySelectorAll('[data-open-page]').forEach(button => {
    button.addEventListener('click', () => selectPage(button.dataset.openPage));
  });
  content.querySelector('#detectSqlHost')?.addEventListener('click', () => {
    perform('sqlSuggest', { port: Number(document.querySelector('#installForm').elements.sqlPort.value) });
  });
  content.querySelector('#useSqlHost')?.addEventListener('click', () => {
    if (busy || !localSqlSuggestion) return;
    const form = document.querySelector('#installForm');
    form.elements.sqlHost.value = localSqlSuggestion.host;
    form.elements.sqlPort.value = localSqlSuggestion.port;
    form.elements.confirmSqlEndpoint.checked = false;
    rememberInstallationDraft();
    populate();
  });
  for (const event of ['input', 'change']) content.querySelector('#installForm')?.addEventListener(event, () => {
    rememberInstallationDraft();
    populate();
  });
  content.querySelector('#openSqlTroubleshooting')?.addEventListener('click', () => {
    const data = new FormData(content.querySelector('#installForm'));
    sqlState.fields = { host: data.get('sqlHost'), port: data.get('sqlPort'), applicationDatabase: data.get('webDatabase'), gameDatabase: data.get('gameDatabase'), appUsername: data.get('appLogin'), gameUsername: data.get('gameLogin'), adminUsername: data.get('sqlAdmin') };
    page = 'sql';
    render();
    perform('sqlInspect', {}, true);
  });
  content.querySelectorAll('input, select').forEach(field => {
    field.addEventListener('invalid', () => localizeValidation(field));
    field.addEventListener('input', () => field.setCustomValidity(''));
    field.addEventListener('change', () => field.setCustomValidity(''));
  });
  content.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', () => perform(button.dataset.action));
  });
  content.querySelector('#resumeInstall')?.addEventListener('click', () => {
    const form = content.querySelector('#installForm');
    if (!status?.installed && !form.reportValidity()) return;
    const required = ['sqlHost', 'sqlPort'];
    if (status?.phase === 'bootstrap-pending') required.push('sqlAdmin', 'sqlPassword', 'confirmSqlEndpoint');
    if (status?.phase === 'runtime-bootstrapped') required.push('adminName', 'adminEmail', 'adminPassword');
    if (required.some(name => !form.elements.namedItem(name).reportValidity())) return;
    const request = installationInput(new FormData(form));
    // Resuming an installed profile must not depend on the latest release feed being available.
    if (!request.settings.profile) delete request.settings.profile;
    perform('resumeInstall', request);
  });
  content.querySelectorAll('form:not(#adminManageForm)').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.target);
    switch (event.target.id) {
      case 'siteSettingsForm':
        perform('saveSiteSettings', siteSettingsInput(event.target));
        break;
      case 'sqlForm':
        perform('sqlDiagnose', sqlInput());
        break;
      case 'installForm': {
        perform('install', installationInput(data));
        break;
      }
      case 'accessForm':
        perform('access', { access: accessInput(data) });
        break;
      case 'adminForm':
        perform('admin', { administrator: administratorInput(data) });
        break;
      case 'backupForm':
        perform('backup', { backup: backupInput(data) });
        break;
      case 'updateForm':
        perform('update', { backup: backupInput(data) });
        break;
      case 'settingsForm':
        perform('saveSettings', Object.fromEntries(data.entries()));
        break;
    }
  }));
}

document.querySelector('#updateNotice').addEventListener('click', () => {
  page = 'updates';
  render();
});

document.querySelector('#language').addEventListener('change', event => {
  const previous = language;
  perform('setLanguage', { language: event.target.value }, true).then(() => {
    document.querySelector('#language').value = settings.language ?? previous;
  });
});

/** Navigate between panel pages; SQL inventory is read only and loaded on demand. */
function selectPage(nextPage) {
  page = nextPage;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (page === 'site') perform('siteSettings');
  if (page === 'admins') {
    perform('adminList');
  }
  if (page === 'sql' && !sqlState.inventory) {
    perform('sqlInspect', {}, true);
  }
}

document.querySelectorAll('[data-page]').forEach(button => {
  button.addEventListener('click', () => selectPage(button.dataset.page));
});
// Delegation also covers support links rendered after navigation or language changes.
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (link) {
    event.preventDefault();
    window.manager?.openLink(link.getAttribute('href'));
  }
});

/** Load public configuration and check both feeds automatically without applying updates. */
async function initialize() {
  render();
  renderOutput();
  await perform('settings', {}, true);
  // Route installed sites promptly; remote release discovery must not delay this decision.
  if (window.manager) {
    await perform('status', {}, true);
  }
  await perform('updates', {}, true);
  document.querySelector('main').setAttribute('aria-busy', 'false');
  setInterval(() => {
    if (!busy) {
      perform('updates', {}, true);
    }
  }, 6 * 60 * 60 * 1000);
  setInterval(async () => {
    if (page !== 'overview' || !status?.installed || busy || refreshingServices || document.hidden || !window.manager) return;
    const epoch = statusEpoch;
    refreshingServices = true;
    try {
      const response = await window.manager.invoke('status');
      if (response.ok && !busy && epoch === statusEpoch) {
        status = response.result;
        statusCheckedAt = Date.now();
        populate();
      }
    } catch { /* Preserve the last measured state; manual refresh reports errors. */ }
    finally { refreshingServices = false; }
  }, 15000);
}
initialize();
