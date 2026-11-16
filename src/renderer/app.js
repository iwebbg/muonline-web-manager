const content = document.querySelector('#content');
const output = document.querySelector('#output');
let page = 'overview';
let busy = false;
let settings = {};
let feeds = {};
let status = null;

/** Generate only static, application-owned access form markup. */
function accessFields() {
  return `<div class="grid"><label>Режим на достъп<select name="mode"><option value="local">Local — localhost / тестове</option><option value="ip">IP — HTTP</option><option value="domain">Domain + SSL — препоръчителен production</option></select></label><label>IP адрес или домейн<input name="host" placeholder="mu.example.com"></label><label>ACME email за SSL<input name="acmeEmail" type="email" placeholder="admin@example.com"></label></div><label class="check"><input type="checkbox" name="httpAcknowledged">При IP режим приемам, че HTTP пренася пароли и сесии без криптиране, включително в production.</label>`;
}

/** Render the administrator prompts supported by the real Laravel command. */
function adminFields() {
  return `<div class="grid"><label>Име на web администратора<input name="adminName" required maxlength="255" autocomplete="off"></label><label>Email<input name="adminEmail" required type="email" autocomplete="off"></label></div><label>Парола (12+ знака, главни/малки букви, цифра и символ)<input name="adminPassword" type="password" required minlength="12" autocomplete="new-password"></label>`;
}

/** Render temporary backup authorization fields, never persisted by the panel. */
function backupFields() {
  return `<div class="warning">SQL backups се създават на SQL Server машината. Директорията трябва да съществува и SQL Server service account да има write достъп. Използва се временен SQL login с BACKUP DATABASE и RESTORE VERIFYONLY права.</div><div class="grid"><label>Временен SQL backup login<input name="backupUsername" required autocomplete="off"></label><label>Временна SQL парола<input name="backupPassword" type="password" required autocomplete="off"></label></div><label>Абсолютна директория на SQL Server host<input name="backupDirectory" placeholder="D:\\MuBackups" required></label>`;
}

/** Render the selected page while keeping the donation footer outside page routing. */
function render() {
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('selected', button.dataset.page === page));
  const pages = {
    overview: `<h1>Вашият MuOnline Web.</h1><p class="lead">Управление на Linux услугите от Windows. Проверете средата, инсталирайте сайта и следете състоянието му от едно място.</p><div class="cards"><div class="card"><small>WEB APPLICATION</small><strong id="webVersion">Непроверено</strong><p>Отделна версия на сайта</p></div><div class="card"><small>ДОСТЪП</small><strong id="accessMode">Непроверено</strong><p id="siteUrl">localhost / IP / Domain + SSL</p></div><div class="card"><small>DESKTOP MANAGER</small><strong id="managerVersion">0.1.0</strong><p>Electron · WSL2 · Docker Engine</p></div></div><div class="panel"><h2>Услуги и диагностика</h2><div id="statusDetail" class="status-detail">Няма проверен runtime статус.</div><div class="actions"><button data-action="status">Провери статус</button><button data-action="start" class="primary">Start</button><button data-action="stop">Stop</button><button data-action="restart">Restart</button><button data-action="logs">Логове</button><button data-action="doctor">SQL диагностика</button></div></div><div class="hint">Затварянето на панела запазва работещите услуги. Sleep, shutdown и <code>wsl --shutdown</code> прекъсват сайта. За публичен достъп са нужни Windows Firewall/NAT настройки.</div>`,
    install: `<h1>Първа инсталация</h1><p class="lead">Използва се Ubuntu-24.04 във WSL2. Game базата трябва вече да е възстановена в SQL Server. Installer-ът създава отделната web база и restricted runtime logins.</p><div class="actions"><button data-action="prerequisites">Провери зависимостите</button><button data-action="installWsl">Настрой WSL2 (UAC)</button><button data-action="installDocker">Инсталирай Docker Engine</button><button data-action="updates">Провери releases</button></div><div class="warning">Docker setup променя Ubuntu-24.04: добавя официалния Docker APT repository и включва Docker service. Не използвайте тази дистрибуция за несвързани workloads. Възможни са рестарт на Windows и първоначално отваряне на Ubuntu.</div><form id="installForm"><h2>SQL Server и game profile</h2><div class="grid"><label>SQL host/IP (достъпен от WSL)<input name="sqlHost" required placeholder="192.168.1.10"></label><label>SQL TCP port<input name="sqlPort" type="number" min="1" max="65535" value="1433" required></label><label>Временен SQL administrator<input name="sqlAdmin" value="sa" required autocomplete="off"></label><label>Временна SQL парола<input name="sqlPassword" type="password" required autocomplete="off"></label><label>Game adapter/profile от release registry<select name="profile" id="profiles" required></select></label><label>Laravel APP_ENV (отделно от достъпа)<select name="appEnv"><option value="local">local</option><option value="production">production</option></select></label><label>Съществуваща game база<input name="gameDatabase" value="MuOnline" required></label><label>Отделна web база<input name="webDatabase" value="MuOnline_Web" required></label><label>Restricted web SQL login<input name="appLogin" value="muonline_web_app" required></label><label>Restricted game SQL login<input name="gameLogin" value="muonline_web_user" required></label></div><label class="check"><input name="trustCertificate" type="checkbox">Trust SQL Server certificate (само ако приемате риска от непроверен сертификат)</label><p class="hint">Runtime SQL паролите са 32 random bytes като hex + Ss@. APP_KEY се генерира отделно. Game writes остават изключени. Временните SQL credentials не се запазват в runtime конфигурацията.</p><fieldset><legend>Достъп</legend>${accessFields()}</fieldset><fieldset><legend>Първи web администратор</legend>${adminFields()}</fieldset><div class="actions"><button class="primary" type="submit">Инсталирай подписания web release</button><button type="button" id="resumeInstall">Продължи прекъсната инсталация</button></div><p class="hint">При resume се използват запазените SQL настройки, runtime пароли и APP_KEY. От формата се вземат само временните SQL credentials и web администраторът. При вече създаден администратор и неуспешен SSL настройте DNS/Firewall и натиснете resume.</p></form>`,
    access: `<h1>Достъп и SSL</h1><p class="lead">Сменете режима или домейна без промяна на Laravel APP_ENV. Конфигурацията се архивира преди промяната; неуспешна nginx/ACME проверка задейства възстановяване.</p><form id="accessForm">${accessFields()}<div class="warning">Domain + SSL изисква DNS към тази машина и входящи TCP 80/443 за HTTP-01. Local се bind-ва само към loopback. При IP и Domain трябва да настроите Windows Firewall и NAT отделно.</div><button class="primary" type="submit">Провери и приложи достъпа</button></form>`,
    admins: `<h1>Web администратори</h1><p class="lead">Създаване чрез съществуващата Laravel команда <code>admin:create</code>. Паролата се предава през private stdin и се изтрива от формата след операцията.</p><form id="adminForm">${adminFields()}<button class="primary" type="submit">Създай администратор</button></form><p class="hint">Текущият Laravel проект няма CLI команди за списък, деактивиране или reset на web администратори. Тези операции са извън наличния CLI договор; не се изпълнява произволен SQL или tinker.</p>`,
    backup: `<h1>Backup</h1><p class="lead">Native SQL Server COPY_ONLY backups с CHECKSUM и VERIFYONLY за web и game базите, плюс частен архив на приложението, .env, APP_KEY, storage, темите и сертификатите във WSL.</p><form id="backupForm">${backupFields()}<button class="primary" type="submit">Създай и провери backup</button></form><p class="hint">Архивите във WSL не са off-machine backup. Копирайте site архива и SQL .bak файловете на отделно защитено място. Възстановяването на database migrations е ръчно.</p>`,
    updates: `<h1>Updates</h1><p class="lead">Автоматично се проверяват подписаните release manifests. Изтегляне, backup и промени започват само чрез изричния бутон Update.</p><div class="actions"><button data-action="updates">Провери за updates</button></div><div class="panel"><h2>Desktop manager</h2><p id="managerFeed"></p><button data-action="updateManager">Update manager</button></div><form id="updateForm"><h2>Web приложение</h2><p id="webFeed"></p><p class="hint">Staging → maintenance → SQL и file backup → release switch → migrations → health checks. Запазват се .env, APP_KEY, storage/uploads и потребителските теми.</p>${backupFields()}<label class="check"><input type="checkbox" name="migrationAcknowledged" required>Разбирам, че след започнали migrations няма автоматичен database rollback. При неуспех е нужна ръчна recovery процедура.</label><button class="primary" type="submit">Update web application</button></form>`,
    settings: `<h1>Release настройки</h1><p class="lead">R2 bucket: <code>marketing</code>. Публичният URL използва alias-а без името на bucket-а. Release файловете трябва да бъдат публикувани отделно.</p><form id="settingsForm"><label>CDN база (HTTPS)<input name="cdn" type="url" required></label><label>Web release prefix<input name="webChannel" required></label><label>Manager release prefix<input name="managerChannel" required></label><p class="hint">Начален web prefix: <code>muonline-web/releases/v1.3.0</code>. За автоматично откриване на бъдещи версии публикувайте подписан feed и задайте неговия prefix. Trust keys са pinned при build и не се приемат от CDN или от тази форма.</p><p id="trustState" class="warning"></p><button class="primary" type="submit">Запази feed настройките</button></form>`
  };
  content.innerHTML = pages[page];
  populate();
  bind();
}

/** Populate dynamic values using text/value properties, never release-supplied HTML. */
function populate() {
  if (page === 'overview' && status?.installed) {
    document.querySelector('#webVersion').textContent = status.version;
    document.querySelector('#accessMode').textContent = status.access.mode.toUpperCase();
    document.querySelector('#siteUrl').textContent = status.access.url;
    document.querySelector('#statusDetail').textContent = 'Installation phase: ' + status.phase;
  }
  if (page === 'install') {
    const select = document.querySelector('#profiles');
    for (const profile of feeds.web?.profiles ?? []) {
      const option = document.createElement('option');
      option.value = profile;
      option.textContent = profile;
      select.append(option);
    }
    if (!select.options.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Нужен е проверен подписан release';
      select.append(option);
    }
  }
  if (page === 'updates') {
    for (const kind of ['web', 'manager']) {
      const feed = feeds[kind];
      document.querySelector('#' + kind + 'Feed').textContent = feed?.error ?? (feed?.version ? 'Проверен release: ' + feed.version : 'Няма проверен release.');
    }
  }
  if (page === 'settings') {
    for (const key of ['cdn', 'webChannel', 'managerChannel']) {
      document.querySelector('[name="' + key + '"]').value = settings[key] ?? '';
    }
    document.querySelector('#trustState').textContent = settings.trustedKeys?.length ? 'Pinned signing keys: ' + settings.trustedKeys.join(', ') : 'Няма pinned production trust key. Инсталации и updates са блокирани до build с публичния ключ на release оператора.';
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

/** Invoke a serialized operation and erase every password field even after failure. */
async function perform(action, input = {}, quiet = false) {
  if (busy) {
    return;
  }
  busy = true;
  document.querySelector('#activity').textContent = 'Изпълнява се…';
  document.querySelector('#operation').textContent = action;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  if (!quiet) {
    output.textContent = 'Операция: ' + action + '\nИзчакайте завършването. Първоначален Docker build може да отнеме няколко минути.';
  }
  try {
    if (!window.manager) {
      throw new Error('Preview mode: runtime operations are available only inside Electron on Windows.');
    }
    const response = await window.manager.invoke(action, input);
    if (!response.ok) {
      throw new Error(response.error);
    }
    const result = response.result;
    if (action === 'settings') {
      settings = result;
    }
    if (action === 'updates') {
      feeds = result;
      if (page === 'install' || page === 'updates') {
        render();
      }
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
      output.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
  } catch (error) {
    if (!quiet) {
      output.textContent = error.message;
    }
  } finally {
    document.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
    busy = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    document.querySelector('#activity').textContent = 'Готов за проверка';
    populate();
  }
}

/** Bind only the static forms and fixed action names rendered on the current page. */
function bind() {
  content.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', () => perform(button.dataset.action));
  });
  content.querySelector('#resumeInstall')?.addEventListener('click', () => {
    const data = new FormData(content.querySelector('form'));
    perform('resumeInstall', { settings: { sqlAdmin: data.get('sqlAdmin'), sqlPassword: data.get('sqlPassword'), administrator: administratorInput(data) } });
  });
  content.querySelector('form')?.addEventListener('submit', event => {
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
  });
}

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
