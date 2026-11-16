import { resolveLocale, translate } from '../shared/i18n.js';
import { translateMessage } from '../shared/messages.js';

const content = document.querySelector('#content');
const output = document.querySelector('#output');
let page = 'overview';
let busy = false;
let settings = {};
let feeds = {};
let status = null;
let language = resolveLocale(navigator.language);
let lastOutput = { kind: 'welcome' };
let lastAction = '';

/** Translate interface strings using the current persisted panel language. */
function t(key, values = {}) {
  return translate(language, key, values);
}

/** Translate the fixed shell without exposing remote strings as HTML. */
function translateShell() {
  document.documentElement.lang = language;
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

/** Present operation names without translating the underlying IPC identifiers. */
function actionLabel(action) {
  const names = { status: 'checkStatus', admin: 'createAdmin', backup: 'createBackup', update: 'updateWeb', updates: 'checkUpdates', access: 'applyAccess', settings: 'settingsTitle' };
  return t(names[action] ?? action);
}

/** Keep technical logs and SQL diagnostics verbatim while translating application messages. */
function renderOutput() {
  if (lastOutput.kind === 'welcome') {
    output.textContent = t('welcome');
  } else if (lastOutput.kind === 'working') {
    output.textContent = t('working', { action: actionLabel(lastOutput.action) });
  } else if (lastOutput.kind === 'error') {
    output.textContent = translateMessage(language, lastOutput.message);
  } else {
    const value = lastOutput.value;
    output.textContent = typeof value === 'string'
      ? (lastOutput.action === 'logs' ? value : translateMessage(language, value))
      : JSON.stringify(value, (key, item) => key === 'error' || key === 'runtimeError' ? translateMessage(language, item) : item, 2);
  }
}

/** Change UI language while keeping unsent form values only in memory. */
function changeLanguage(value) {
  const fields = [...content.querySelectorAll('input, select')].map(field => ({ name: field.name, value: field.value, checked: field.checked }));
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

/** Render the selected page while keeping the donation footer outside page routing. */
function render() {
  translateShell();
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('selected', button.dataset.page === page));
  const pages = {
    overview: `<h1>${t('overviewTitle')}</h1><p class="lead">${t('overviewLead')}</p><div class="cards"><div class="card"><small>${t('webApplicationLabel')}</small><strong id="webVersion">${t('unchecked')}</strong><p>${t('webVersionHint')}</p></div><div class="card"><small>${t('accessLabel')}</small><strong id="accessMode">${t('unchecked')}</strong><p id="siteUrl">localhost / IP / Domain + SSL</p></div><div class="card"><small>${t('managerLabel')}</small><strong id="managerVersion">0.1.0</strong><p>Electron · WSL2 · Docker Engine</p></div></div><div class="panel"><h2>${t('servicesTitle')}</h2><div id="statusDetail" class="status-detail">${t('noRuntimeStatus')}</div><div class="actions"><button data-action="status">${t('checkStatus')}</button><button data-action="start" class="primary">${t('start')}</button><button data-action="stop">${t('stop')}</button><button data-action="restart">${t('restart')}</button><button data-action="logs">${t('logs')}</button><button data-action="doctor">${t('doctor')}</button></div></div><div class="hint">${t('lifecycleBefore')}<code>wsl --shutdown</code>${t('lifecycleAfter')}</div>`,
    install: `<h1>${t('installTitle')}</h1><p class="lead">${t('installLead')}</p><div class="actions"><button data-action="prerequisites">${t('prerequisites')}</button><button data-action="installWsl">${t('installWsl')}</button><button data-action="installDocker">${t('installDocker')}</button></div><div class="warning">${t('dockerWarning')}</div><p id="installRelease" class="hint"></p><form id="installForm"><h2>${t('sqlTitle')}</h2><div class="grid"><label>${t('sqlHost')}<input name="sqlHost" required placeholder="192.168.1.10"></label><label>${t('sqlPort')}<input name="sqlPort" type="number" min="1" max="65535" value="1433" required></label><label>${t('sqlAdmin')}<input name="sqlAdmin" value="sa" required autocomplete="off"></label><label>${t('sqlPassword')}<input name="sqlPassword" type="password" required autocomplete="off"></label><label>${t('profile')}<select name="profile" id="profiles" required></select></label><label>${t('appEnv')}<select name="appEnv"><option value="local">local</option><option value="production">production</option></select></label><label>${t('gameDatabase')}<input name="gameDatabase" value="MuOnline" required></label><label>${t('webDatabase')}<input name="webDatabase" value="MuOnline_Web" required></label><label>${t('appLogin')}<input name="appLogin" value="muonline_web_app" required></label><label>${t('gameLogin')}<input name="gameLogin" value="muonline_web_user" required></label></div><label class="check"><input name="trustCertificate" type="checkbox">${t('trustCertificate')}</label><p class="hint">${t('passwordHint')}</p><fieldset><legend>${t('access')}</legend>${accessFields()}</fieldset><fieldset><legend>${t('firstAdmin')}</legend>${adminFields()}</fieldset><div class="actions"><button class="primary" type="submit">${t('install')}</button><button type="button" id="resumeInstall">${t('resumeInstall')}</button></div><p class="hint">${t('resumeHint')}</p></form>`,
    access: `<h1>${t('accessTitle')}</h1><p class="lead">${t('accessLead')}</p><form id="accessForm">${accessFields()}<div class="warning">${t('accessWarning')}</div><button class="primary" type="submit">${t('applyAccess')}</button></form>`,
    admins: `<h1>${t('adminsTitle')}</h1><p class="lead">${t('adminsLeadBefore')}<code>admin:create</code>${t('adminsLeadAfter')}</p><form id="adminForm">${adminFields()}<button class="primary" type="submit">${t('createAdmin')}</button></form><p class="hint">${t('adminsHint')}</p>`,
    backup: `<h1>${t('backupTitle')}</h1><p class="lead">${t('backupLead')}</p><form id="backupForm">${backupFields()}<button class="primary" type="submit">${t('createBackup')}</button></form><p class="hint">${t('backupHint')}</p>`,
    updates: `<h1>${t('updatesTitle')}</h1><p class="lead">${t('updatesLead')}</p><div class="actions"><button data-action="updates">${t('checkUpdates')}</button></div><div class="panel"><h2>${t('managerTitle')}</h2><p id="managerFeed"></p><button data-action="updateManager">${t('updateManager')}</button></div><form id="updateForm"><h2>${t('webTitle')}</h2><p id="webFeed"></p><p class="hint">${t('updateHint')}</p>${backupFields()}<label class="check"><input type="checkbox" name="migrationAcknowledged" required>${t('migrationWarning')}</label><button class="primary" type="submit">${t('updateWeb')}</button></form><details class="panel advanced"><summary>${t('advancedSettings')}</summary><p class="hint">${t('downloadServerHint')}</p><form id="settingsForm"><label>${t('cdn')}<input name="cdn" type="url" required></label><button type="submit">${t('saveSettings')}</button></form></details>`,

  };
  content.innerHTML = pages[page];
  populate(true);
  bind();
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
  const notice = document.querySelector('#updateNotice');
  notice.hidden = !(feeds.web?.available || feeds.web?.newTag || feeds.manager?.available);
  notice.textContent = feeds.web?.newTag && !feeds.web.ready && !feeds.manager?.available
    ? t('pendingRelease', { version: feeds.web.latestVersion })
    : t('updateNotification');
  if (page === 'install') {
    const feed = feeds.web;
    document.querySelector('#installRelease').textContent = feed?.ready ? t('installRelease', { version: feed.version }) : releaseDescription(feed, 'web');
  }
  if (page === 'overview' && status?.installed) {
    document.querySelector('#webVersion').textContent = status.version;
    document.querySelector('#accessMode').textContent = status.access.mode.toUpperCase();
    document.querySelector('#siteUrl').textContent = status.access.url;
    let services = [];
    try {
      const raw = status.services?.trim() || '[]';
      services = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').map(line => JSON.parse(line));
    } catch {
      services = [];
    }
    document.querySelector('#statusDetail').textContent = t('phase', { phase: t('phase.' + status.phase) }) + services.map(service => '\n' + service.Service + ': ' + t('state.' + service.State) + (service.Health ? ' / ' + t('state.' + service.Health) : '')).join('');
  }
  if (page === 'install') {
    const select = document.querySelector('#profiles');
    const selected = select.value;
    select.replaceChildren();
    for (const profile of feeds.web?.profiles ?? []) {
      const option = document.createElement('option');
      option.value = profile;
      option.textContent = profile;
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

/** Read the validated access form independently of APP_ENV. */
function accessInput(data) {
  return { mode: data.get('mode'), host: data.get('host'), email: data.get('acmeEmail'), httpAcknowledged: data.has('httpAcknowledged') };
}

/** Build administrator prompt input without exposing it in UI results. */
function administratorInput(data) {
  return { name: data.get('adminName'), email: data.get('adminEmail'), password: data.get('adminPassword') };
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
  busy = true;
  document.querySelector('#activity').textContent = t('running');
  lastAction = action;
  document.querySelector('#operation').textContent = actionLabel(action);
  document.querySelector('#language').disabled = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  if (!quiet) {
    lastOutput = { kind: 'working', action };
    renderOutput();
  }
  try {
    if (!window.manager) {
      throw new Error(t('previewError'));
    }
    const response = await window.manager.invoke(action, input);
    if (!response.ok) {
      throw new Error(response.error);
    }
    const result = response.result;
    if (action === 'settings') {
      settings = result;
      changeLanguage(settings.language ?? language);
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
      populate();
    }
    if (action === 'saveSettings') {
      settings = { ...settings, ...input };
      feeds = {};
    }
    if (!quiet) {
      lastOutput = { kind: 'result', action, value: result };
      renderOutput();
    }
  } catch (error) {
    if (!quiet || action === 'setLanguage') {
      lastOutput = { kind: 'error', message: error.message };
      renderOutput();
    }
  } finally {
    if (['install', 'resumeInstall', 'admin', 'backup', 'update'].includes(action)) {
      document.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
    }
    busy = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    document.querySelector('#language').disabled = false;
    translateShell();
    populate();
  }
  if (['install', 'resumeInstall', 'update', 'saveSettings'].includes(action) && lastOutput.kind === 'result') {
    await perform('status', {}, true);
    await perform('updates', {}, true);
  }
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

/** Bind only the static forms and fixed action names rendered on the current page. */
function bind() {
  content.querySelectorAll('input, select').forEach(field => {
    field.addEventListener('invalid', () => localizeValidation(field));
    field.addEventListener('input', () => field.setCustomValidity(''));
    field.addEventListener('change', () => field.setCustomValidity(''));
  });
  content.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', () => perform(button.dataset.action));
  });
  content.querySelector('#resumeInstall')?.addEventListener('click', () => {
    const data = new FormData(content.querySelector('form'));
    perform('resumeInstall', { settings: { sqlAdmin: data.get('sqlAdmin'), sqlPassword: data.get('sqlPassword'), administrator: administratorInput(data) } });
  });
  content.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.target);
    switch (event.target.id) {
      case 'installForm': {
        const values = Object.fromEntries(data.entries());
        values.trustCertificate = data.has('trustCertificate');
        values.access = accessInput(data);
        values.administrator = administratorInput(data);
        delete values.adminPassword;
        perform('install', { settings: values });
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

document.querySelectorAll('[data-page]').forEach(button => {
  button.addEventListener('click', () => {
    page = button.dataset.page;
    render();
  });
});
document.querySelectorAll('footer a').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    window.manager?.openLink(link.href);
  });
});

/** Load public configuration and check both feeds automatically without applying updates. */
async function initialize() {
  render();
  renderOutput();
  await perform('settings', {}, true);
  await perform('updates', {}, true);
  if (window.manager) {
    await perform('status', {}, true);
  }
  setInterval(() => {
    if (!busy) {
      perform('updates', {}, true);
    }
  }, 6 * 60 * 60 * 1000);
}
initialize();
