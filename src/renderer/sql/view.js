/** Render only application-owned markup; diagnostic values are populated with textContent. */
export function sqlPage(t) {
  const field = (name, key, type = 'text', value = '') => `<label>${t('sql.' + key)}<input name="${name}" type="${type}" ${type === 'password' ? 'autocomplete="off"' : ''} value="${value}"></label>`;
  return `<h1>${t('sql.title')}</h1><p class="lead">${t('sql.lead')}</p>
    <div class="actions"><button data-action="sqlInspect">${t('sql.inspect')}</button><button data-action="sqlCopyReport">${t('sql.copyReport')}</button></div>
    <form id="sqlForm"><div class="grid"><label>${t('sql.instance')}<select name="instance" id="sqlInstance"></select></label><label>${t('sql.port')}<input name="port" type="number" min="1" max="65535" value="1433" required></label></div>
    <label class="check"><input name="useInstalled" type="checkbox" checked>${t('sql.useInstalled')}</label><p class="hint" id="sqlInstalledHint">${t('sql.savedHint')}</p><p class="hint" id="sqlManualHint" hidden>${t('sql.manualHint')}</p>
    <fieldset id="sqlManualFields" hidden disabled><div class="grid">${field('host', 'host')}${field('applicationDatabase', 'applicationDatabase', 'text', 'MuOnline_Web')}${field('gameDatabase', 'gameDatabase', 'text', 'MuOnline')}${field('rankingDatabase', 'rankingDatabase')}${field('battleCoreDatabase', 'battleCoreDatabase')}${field('appUsername', 'appUsername')}${field('appPassword', 'appPassword', 'password')}${field('gameUsername', 'gameUsername')}${field('gamePassword', 'gamePassword', 'password')}</div>
    <label class="check"><input name="encrypt" type="checkbox" checked>${t('sql.encrypt')}</label><label class="check"><input name="trustCertificate" type="checkbox">${t('sql.trust')}</label></fieldset>
    <details><summary>${t('sql.bootstrap')}</summary><p class="hint">${t('sql.bootstrapHint')}</p><div class="grid">${field('adminUsername', 'adminUsername')}${field('adminPassword', 'adminPassword', 'password')}${field('gameAdminUsername', 'gameAdminUsername')}${field('gameAdminPassword', 'gameAdminPassword', 'password')}</div></details>
    <button type="submit" class="primary">${t('sql.run')}</button></form>
    <section id="sqlResults" class="sql-results" aria-live="polite"></section>
    <section class="panel sql-changes"><h2>${t('sql.changes')}</h2><p class="hint">${t('sql.changesHint')}</p><label>${t('sql.section')}<select name="section" id="sqlSection"></select></label><div class="actions">${['mixedMode', 'tcpPort', 'firewall', 'restart'].map(action => `<button type="button" data-sql-change="${action}">${t('sql.change.' + action)}</button>`).join('')}</div><div id="sqlPlan"></div></section>`;
}

/** Installed runtime credentials are read only inside WSL, never copied into renderer fields. */
function updateConnectionMode() {
  const installed = document.querySelector('[name="useInstalled"]').checked;
  const fields = document.querySelector('#sqlManualFields');
  fields.hidden = installed;
  fields.disabled = installed;
  document.querySelector('#sqlInstalledHint').hidden = !installed;
  document.querySelector('#sqlManualHint').hidden = installed;
  if (installed) fields.querySelectorAll('input[type="password"]').forEach(field => { field.value = ''; });
}

/** Read ephemeral diagnostic form input, preserving boolean controls explicitly. */
export function sqlInput() {
  const data = new FormData(document.querySelector('#sqlForm'));
  return { ...Object.fromEntries(data.entries()), useInstalled: data.has('useInstalled'), encrypt: data.has('encrypt'), trustCertificate: data.has('trustCertificate'), section: document.querySelector('#sqlSection').value };
}

/** Render measured evidence and a concrete action for every result, without HTML injection. */
export function populateSql(t, state, invoke, fill = false) {
  const instance = document.querySelector('#sqlInstance');
  if (fill || state.inventory !== state.lastInventory) {
    const selected = instance.value || state.fields?.instance || state.inventory?.selectedInstance || '';
    instance.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('sql.chooseInstance');
    instance.append(placeholder);
    for (const item of state.inventory?.instances ?? []) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = item.name + (item.name === 'MSSQLSERVER' ? ' (' + t('sql.defaultInstance') + ')' : '') + ' · ' + item.state + (item.version ? ' · ' + item.version : '');
      instance.append(option);
    }
    instance.value = selected;
    state.lastInventory = state.inventory;
    if (fill) {
      document.querySelector('[name="useInstalled"]').checked = state.useInstalled ?? (state.installed !== false);
      for (const [name, value] of Object.entries(state.fields ?? {})) {
        const field = document.querySelector('#sqlForm [name="' + name + '"]');
        if (field && field.type !== 'password') {
          field.value = value;
        }
      }
    }
  }
  if (state.lastInstalled !== state.installed) {
    // A newly available deployment supersedes a pre-install manual test connection.
    if (state.installed === true) state.useInstalled = true;
    if (state.useInstalled === undefined || state.installed === true) document.querySelector('[name="useInstalled"]').checked = state.installed !== false;
    state.lastInstalled = state.installed;
  }
  updateConnectionMode();
  const sectionSelect = document.querySelector('#sqlSection');
  const sectionValue = state.selectedSection ?? sectionSelect.value;
  sectionSelect.replaceChildren();
  const selectedInstance = state.inventory?.instances?.find(item => item.name === instance.value);
  for (const section of selectedInstance?.tcp?.sections ?? []) {
    if ((selectedInstance.tcp.listenAll && section.name === 'IPAll') || (!selectedInstance.tcp.listenAll && section.name !== 'IPAll' && section.enabled)) {
      const option = document.createElement('option');
      option.value = section.name;
      option.textContent = section.name + (section.address ? ' · ' + section.address : '');
      sectionSelect.append(option);
    }
  }
  if ([...sectionSelect.options].some(option => option.value === sectionValue)) {
    sectionSelect.value = sectionValue;
  }
  const results = document.querySelector('#sqlResults');
  results.replaceChildren();
  const copyReport = document.querySelector('[data-action="sqlCopyReport"]');
  copyReport.disabled = !state.report;
  if (state.report) {
    const captured = document.createElement('p');
    captured.className = 'hint';
    captured.textContent = t('sql.capturedAt') + ': ' + state.report.createdAt;
    results.append(captured);
  }
  if (!state.report) {
    const hint = document.createElement('p');
    hint.textContent = t('sql.noReport');
    results.append(hint);
  }
  for (const step of state.report?.steps ?? []) {
    const card = document.createElement('article');
    card.className = 'panel sql-step';
    const heading = document.createElement('h2');
    heading.textContent = t('sql.group.' + step.category);
    const badge = document.createElement('span');
    badge.className = 'sql-status ' + (['passed', 'warning', 'failed', 'notChecked'].includes(step.status) ? step.status : 'notChecked');
    badge.textContent = t('sql.status.' + step.status);
    heading.append(badge);
    const identifier = document.createElement('code');
    identifier.textContent = step.id;
    const cause = document.createElement('p');
    cause.textContent = t('sql.cause') + ': ' + t('sql.reason.' + step.reason);
    const action = document.createElement('p');
    action.textContent = t('sql.nextAction') + ': ' + t('sql.action.' + step.action);
    const evidence = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = t('sql.evidence');
    const facts = document.createElement('pre');
    facts.textContent = JSON.stringify(step.evidence ?? {}, null, 2);
    evidence.append(summary, facts);
    card.append(heading, identifier, cause, action, evidence);
    if (step.status !== 'passed') {
      const retest = document.createElement('button');
      retest.type = 'button';
      retest.textContent = t('sql.retest');
      retest.addEventListener('click', () => invoke('sqlDiagnose', sqlInput()));
      card.append(retest);
    }
    results.append(card);
  }
  const plan = document.querySelector('#sqlPlan');
  // Do not erase explicit confirmation on unrelated progress updates.
  if (fill || plan.dataset.planId !== (state.plan?.id ?? '')) {
    plan.replaceChildren();
    plan.dataset.planId = state.plan?.id ?? '';
    if (state.plan) {
      const heading = document.createElement('h2');
      heading.textContent = t('sql.preview');
      const warning = document.createElement('p');
      warning.className = 'warning';
      warning.textContent = t(state.plan.disconnectsSessions ? 'sql.restartWarning' : 'sql.changesHint') + (state.plan.restartRequired ? ' ' + t('sql.restartLater') : '');
      const scope = document.createElement('pre');
      scope.textContent = JSON.stringify({ instance: state.plan.instance, port: state.plan.port, section: state.plan.section, changes: state.plan.changes, scope: state.plan.scope }, null, 2);
      const command = document.createElement('pre');
      command.textContent = state.plan.command;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = t('sql.copyCommand');
      copy.addEventListener('click', () => invoke('sqlCopyPlan', { planId: state.plan.id }));
      const label = document.createElement('label');
      label.className = 'check';
      const confirmation = document.createElement('input');
      confirmation.type = 'checkbox';
      confirmation.name = 'confirmSqlChange';
      label.append(confirmation, document.createTextNode(t('sql.confirm')));
      const apply = document.createElement('button');
      apply.id = 'sqlApplyButton';
      apply.type = 'button';
      apply.className = 'danger';
      apply.disabled = true;
      apply.textContent = t('sql.apply');
      confirmation.addEventListener('change', () => { apply.disabled = !confirmation.checked; });
      apply.addEventListener('click', () => invoke('sqlApply', { planId: state.plan.id, confirmed: confirmation.checked }));
      plan.append(heading, warning, scope, command, copy, label, apply);
    }
  }
  const apply = document.querySelector('#sqlApplyButton');
  if (apply) {
    apply.disabled = !document.querySelector('[name="confirmSqlChange"]').checked;
  }
}

/** Bind read-only diagnostics separately from preview/apply change controls. */
export function bindSql(t, state, invoke) {
  document.querySelector('[name="useInstalled"]').addEventListener('change', event => {
    state.useInstalled = event.target.checked;
    state.report = null;
    state.plan = null;
    updateConnectionMode();
    populateSql(t, state, invoke);
  });
  document.querySelector('#sqlInstance').addEventListener('change', event => {
    state.fields.instance = event.target.value;
    state.selectedSection = null;
    state.plan = null;
    state.report = null;
    populateSql(t, state, invoke);
  });
  document.querySelector('#sqlSection').addEventListener('change', event => { state.selectedSection = event.target.value; });
  document.querySelectorAll('[data-sql-change]').forEach(button => {
    button.addEventListener('click', () => invoke('sqlPlan', { ...sqlInput(), change: button.dataset.sqlChange }));
  });
}
