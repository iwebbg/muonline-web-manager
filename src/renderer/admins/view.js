import { translateMessage } from '../../shared/messages.js';

/** Keep administrator metadata in memory only; never retain password input in this state. */
export const administratorState = { rows: null, error: null, mode: null, selected: null, notice: null };

/** Render only trusted application markup. Identity values are assigned with textContent/value below. */
export function administratorsPage(t, createFields) {
  return `<h1>${t('adminsTitle')}</h1><p class="lead">${t('admins.lead')}</p>
    <section class="panel"><div class="admins-heading"><h2>${t('admins.accounts')}</h2><button type="button" data-action="adminList">${t('admins.refresh')}</button></div>
    <div id="adminMessages" aria-live="polite"></div><div id="administratorTable" class="table-scroll"></div><div id="administratorEditor"></div></section>
    <form id="adminForm" class="admin-create"><h2>${t('createAdmin')}</h2>${createFields}<button class="primary" type="submit">${t('createAdmin')}</button></form>`;
}

/** Apply structured command results without rendering raw JSON, exceptions or credential-bearing output. */
export function receiveAdministrators(action, result) {
  const state = administratorState;
  state.error = result.code ? result : null;
  state.notice = null;
  if (action === 'adminList') {
    state.rows = result.code ? null : result.administrators;
    if (result.code) {
      state.mode = null;
      state.selected = null;
    }
  } else if (!result.code) {
    state.notice = 'admins.saved';
    state.mode = null;
    state.selected = null;
  }
}

/** Populate the table, safe failure text and explicitly selected edit/reset/confirmation controls. */
export function populateAdministrators(t, language, invoke) {
  const state = administratorState;
  const messages = document.querySelector('#adminMessages');
  messages.replaceChildren();
  if (state.error) {
    const warning = document.createElement('div');
    warning.className = 'warning';
    warning.textContent = t('admins.error.' + state.error.code);
    for (const [field, values] of Object.entries(state.error.errors ?? {})) {
      for (const value of values) {
        const line = document.createElement('p');
        line.textContent = t('admins.field.' + field) + ': ' + translateMessage(language, value);
        warning.append(line);
      }
    }
    messages.append(warning);
  } else if (state.notice) {
    const notice = document.createElement('p');
    notice.textContent = t(state.notice);
    messages.append(notice);
  }
  const target = document.querySelector('#administratorTable');
  target.replaceChildren();
  if (!state.rows?.length) {
    const hint = document.createElement('p');
    hint.textContent = t(state.rows ? 'admins.empty' : 'admins.notLoaded');
    target.append(hint);
  } else {
    const table = document.createElement('table');
    const header = document.createElement('tr');
    for (const key of ['name', 'email', 'role', 'status', 'actions']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = t('admins.column.' + key);
      header.append(cell);
    }
    const head = document.createElement('thead');
    head.append(header);
    table.append(head);
    const body = document.createElement('tbody');
    const fullAdministrators = state.rows.filter(row => row.role === 'administrator' && row.is_active).length;
    for (const identity of state.rows) {
      const row = document.createElement('tr');
      row.dataset.administratorId = identity.id;
      for (const text of [identity.name, identity.email, t('admins.role.' + identity.role), t(identity.is_active ? 'admins.active' : 'admins.inactive')]) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      const actions = document.createElement('td');
      actions.className = 'admin-row-actions';
      for (const mode of ['edit', 'password', identity.is_active ? 'deactivate' : 'activate']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.adminAction = mode;
        button.textContent = t('admins.' + mode);
        if (mode === 'deactivate' && identity.role === 'administrator' && fullAdministrators === 1) {
          button.disabled = true;
          button.title = t('admins.lastActive');
        }
        button.addEventListener('click', () => {
          if (mode === 'activate') {
            mutateAdministrator(invoke, { id: identity.id, is_active: true });
            return;
          }
          state.mode = mode;
          state.selected = identity;
          state.error = null;
          populateAdministrators(t, language, invoke);
        });
        actions.append(button);
      }
      row.append(actions);
      body.append(row);
    }
    table.append(body);
    target.append(table);
  }
  const editor = document.querySelector('#administratorEditor');
  // Preserve in-progress user input through unrelated status/language updates.
  const key = state.mode ? state.mode + ':' + state.selected?.id : '';
  if (editor.dataset.editorKey === key) {
    return;
  }
  editor.dataset.editorKey = key;
  editor.replaceChildren();
  if (!state.mode || !state.selected) {
    return;
  }
  const identity = state.selected;
  const title = document.createElement('h2');
  title.textContent = t('admins.' + state.mode) + ' — ' + identity.name;
  editor.append(title);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('admins.cancel');
  cancel.addEventListener('click', () => { state.mode = null; state.selected = null; populateAdministrators(t, language, invoke); });
  if (state.mode === 'deactivate') {
    const warning = document.createElement('p');
    warning.textContent = t('admins.confirmDeactivation', { email: identity.email });
    const confirm = document.createElement('button');
    confirm.id = 'adminConfirmDeactivation';
    confirm.className = 'danger';
    confirm.textContent = t('admins.confirm');
    confirm.addEventListener('click', () => mutateAdministrator(invoke, { id: identity.id, is_active: false, confirmed: true }));
    editor.append(warning, confirm, cancel);
    return;
  }
  const form = document.createElement('form');
  form.id = 'adminManageForm';
  const passwordMode = state.mode === 'password';
  form.innerHTML = passwordMode
    ? `<label>${t('adminPassword')}<input name="managedPassword" type="password" required minlength="12" maxlength="1024" autocomplete="new-password"></label><label>${t('admins.passwordConfirmation')}<input name="managedPasswordConfirmation" type="password" required autocomplete="new-password"></label>`
    : `<label>${t('adminName')}<input name="managedName" required maxlength="255"></label><label>${t('email')}<input name="managedEmail" type="email" required maxlength="255"></label>`;
  if (!passwordMode) {
    form.elements.managedName.value = identity.name;
    form.elements.managedEmail.value = identity.email;
  }
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = t('admins.save');
  form.append(save, cancel);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const details = { id: identity.id };
    if (passwordMode) {
      const password = form.elements.managedPassword.value;
      if (password !== form.elements.managedPasswordConfirmation.value) {
        form.elements.managedPasswordConfirmation.setCustomValidity(t('admins.passwordMismatch'));
        form.elements.managedPasswordConfirmation.reportValidity();
        return;
      }
      details.password = password;
    } else {
      if (form.elements.managedName.value !== identity.name) {
        details.name = form.elements.managedName.value;
      }
      if (form.elements.managedEmail.value !== identity.email) {
        details.email = form.elements.managedEmail.value;
      }
      if (Object.keys(details).length === 1) {
        state.error = { code: 'noChanges' };
        populateAdministrators(t, language, invoke);
        return;
      }
    }
    mutateAdministrator(invoke, details);
  });
  form.addEventListener('input', () => form.querySelectorAll('input').forEach(input => input.setCustomValidity('')));
  form.addEventListener('invalid', event => {
    const input = event.target;
    if (input.validity.valueMissing) {
      input.setCustomValidity(t('required'));
    } else if (input.validity.typeMismatch) {
      input.setCustomValidity(t('invalidEmail'));
    } else if (input.validity.tooShort) {
      input.setCustomValidity(t('tooShort', { min: input.minLength }));
    }
  }, true);
  editor.append(form);
}

/** Reload the authoritative list only after a confirmed successful mutation. Never retry a mutation. */
async function mutateAdministrator(invoke, administrator) {
  const result = await invoke('adminUpdate', { administrator });
  if (result?.administrator && !result.code) {
    await invoke('adminList', {}, true);
  }
}
