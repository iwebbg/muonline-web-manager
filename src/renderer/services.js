const names = ['app', 'nginx', 'queue', 'redis', 'scheduler'];

export function serviceRows(status) {
  let rows = [];
  try {
    const value = status?.services;
    rows = Array.isArray(value) ? value : (value?.trim().startsWith('[') ? JSON.parse(value) : (value ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  } catch { /* Keep missing/invalid measurements explicitly unknown. */ }
  if (!Array.isArray(rows)) rows = [];
  return names.map(name => {
    const row = rows.find(row => row?.Service === name);
    const state = ['running', 'exited', 'stopped', 'created', 'restarting', 'paused', 'dead', 'removing'].includes(row?.State) ? row.State : 'unknown';
    const health = ['healthy', 'unhealthy', 'starting'].includes(row?.Health) ? row.Health : '';
    const tone = health === 'unhealthy' || ['exited', 'stopped', 'dead'].includes(state) ? 'failed' : state === 'running' && health !== 'starting' ? 'running' : ['created', 'restarting'].includes(state) || health === 'starting' ? 'pending' : 'unknown';
    return { name, state, health, tone };
  });
}

export function servicesPanel(t) {
  return `<section class="panel services-panel" id="servicesPanel"><div class="services-heading"><div><h2>${t('servicesTitle')}</h2><p id="servicesSummary" class="hint" aria-live="polite"></p></div><span id="runtimePhase" class="runtime-pill"></span></div><div id="statusDetail" class="service-grid"></div><p id="serviceError" class="warning" hidden></p><div class="services-toolbar"><div class="actions"><button data-action="status">${t('checkStatus')}</button><button data-action="start" class="primary">${t('start')}</button><button data-action="stop">${t('stop')}</button><button data-action="restart">${t('restart')}</button><button data-action="logs">${t('logs')}</button><button data-action="doctor">${t('doctor')}</button></div><small id="servicesChecked" class="hint"></small></div><form id="gameWritesForm" class="game-writes"><div class="writes-heading"><div><h2>${t('writes.title')}</h2><p class="hint">${t('writes.description')}</p></div><label class="writes-switch"><input id="gameWritesToggle" type="checkbox" role="switch"><span class="switch-track" aria-hidden="true"></span><span id="gameWritesLabel"></span></label></div><p class="hint">${t('writes.restartHint')}</p><label class="check"><input id="gameWritesConfirm" type="checkbox">${t('writes.confirm')}</label><button type="submit" id="gameWritesApply" disabled>${t('writes.apply')}</button></form><p class="hint lifecycle-note">${t('lifecycleHint')}</p></section>`;
}

/** Render only known service fields as text; container data never becomes HTML or CSS classes. */
export function populateServices(t, status, busy, checkedAt, action) {
  const panel = document.querySelector('#servicesPanel');
  if (!panel) return;
  panel.setAttribute('aria-busy', String(busy));
  const rows = serviceRows(status);
  const grid = document.querySelector('#statusDetail');
  if (!grid.childElementCount) {
    for (const row of rows) {
      const card = document.createElement('details');
      card.className = 'service-tile';
      card.dataset.service = row.name;
      card.innerHTML = `<summary><span class="service-dot" aria-hidden="true"></span><strong>${row.name}</strong><span class="service-state"></span></summary><p class="service-description"></p><p class="service-health"></p>`;
      grid.append(card);
    }
  }
  for (const row of rows) {
    const card = grid.querySelector('[data-service="' + row.name + '"]');
    card.dataset.tone = row.tone;
    card.querySelector('.service-state').textContent = t('service.state.' + row.state) + (row.health ? ' · ' + t('service.health.' + row.health) : '');
    card.querySelector('.service-description').textContent = t('service.description.' + row.name);
    card.querySelector('.service-health').textContent = t(row.health ? 'service.health.' + row.health : 'service.health.none');
    card.querySelector('summary').title = t('service.details');
  }
  const running = rows.filter(row => row.state === 'running' && row.health !== 'unhealthy').length;
  document.querySelector('#servicesSummary').textContent = busy ? t('service.operation', { action: t(action === 'setGameWrites' ? 'writes.apply' : action === 'status' ? 'checkStatus' : action) }) : t('service.summary', { running, total: rows.length });
  const phase = document.querySelector('#runtimePhase');
  phase.textContent = status?.installed ? t('phase.' + status.phase) : t('notInstalled');
  phase.dataset.tone = status?.phase === 'ready' ? 'running' : 'pending';
  document.querySelector('#servicesChecked').textContent = checkedAt ? t('service.checked', { time: new Date(checkedAt).toLocaleTimeString(document.documentElement.lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : t('service.notChecked');
  const error = document.querySelector('#serviceError');
  error.hidden = !status?.runtimeError;
  error.textContent = status?.runtimeError ?? '';
  const mode = ['enabled', 'disabled'].includes(status?.gameWrites) ? status.gameWrites : 'unknown';
  const toggle = document.querySelector('#gameWritesToggle');
  const confirmation = document.querySelector('#gameWritesConfirm');
  if (toggle.dataset.mode !== mode) {
    delete toggle.dataset.dirty;
    confirmation.checked = false;
    toggle.dataset.mode = mode;
  }
  if (!toggle.dataset.dirty) toggle.checked = mode === 'enabled';
  toggle.setAttribute('aria-label', t('writes.title'));
  toggle.setAttribute('aria-checked', String(toggle.checked));
  const ready = status?.installed && status.phase === 'ready';
  for (const action of ['start', 'stop', 'restart']) panel.querySelector('[data-action="' + action + '"]').disabled = busy || !ready;
  toggle.disabled = busy || !ready;
  confirmation.disabled = busy || !ready;
  const target = toggle.checked ? 'enabled' : 'disabled';
  document.querySelector('#gameWritesLabel').textContent = t('writes.' + (toggle.dataset.dirty ? target : mode));
  document.querySelector('#gameWritesApply').disabled = busy || !ready || !confirmation.checked || target === mode;
}

export function bindServices(t, getState, perform) {
  const toggle = document.querySelector('#gameWritesToggle');
  if (!toggle) return;
  const refresh = () => { const state = getState(); populateServices(t, state.status, state.busy, state.checkedAt, state.action); };
  toggle.addEventListener('change', () => {
    toggle.dataset.dirty = 'true';
    document.querySelector('#gameWritesConfirm').checked = false;
    refresh();
  });
  document.querySelector('#gameWritesConfirm').addEventListener('change', refresh);
  document.querySelector('#gameWritesForm').addEventListener('submit', event => {
    event.preventDefault();
    event.stopPropagation();
    if (document.querySelector('#gameWritesApply').disabled) return;
    perform('setGameWrites', { gameWrites: { enabled: toggle.checked, confirmed: document.querySelector('#gameWritesConfirm').checked, expectedMode: getState().status?.gameWrites ?? 'unknown' } });
  });
}
