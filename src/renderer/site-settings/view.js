/** A public snapshot contains values and secret-presence flags, never secret values. */
let snapshot = null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function receiveSiteSettings(value) { snapshot = value; }

export function siteSettingsPage(t, language) {
  const heading = `<h1>${t('site.title')}</h1><p class="lead">${t('site.lead')}</p><div class="actions"><button type="button" data-action="siteSettings">${t('site.reload')}</button></div>`;
  if (!snapshot) return heading + `<p class="hint">${t('site.loadHint')}</p>`;
  const groups = ['payments', 'mail', 'storage', 'security', 'general'];
  return heading + `<form id="siteSettingsForm"><p class="hint">${t('site.secretHint')}</p>` + groups.map(group => {
    const fields = snapshot.fields.filter(field => field.group === group);
    return `<details class="panel site-settings-group" ${group === 'payments' ? 'open' : ''}><summary>${t('site.group.' + group)}</summary><p class="hint">${t('site.hint.' + group)}</p>` + (group === 'storage' && !snapshot.s3DriverInstalled ? `<p class="warning">${t('site.s3Missing')}</p>` : '') + (group === 'payments' ? `<div class="grid">${Object.entries(snapshot.webhooks ?? {}).map(([provider,url]) => `<label>${escape(provider)} — ${t('site.webhook')}<input type="text" readonly value="${escape(url)}"></label>`).join('')}</div>` : '') + `<div class="grid">` + fields.map(field => {
      const key = escape(field.key);
      const label = escape(field.label[language] ?? field.label.en);
      const disabled = field.supported ? '' : ' disabled';
      const unavailable = field.supported ? '' : `<small>${t('site.unsupported')}</small>`;
      const value = snapshot.values[field.key] ?? field.default;
      let control;
      if (field.type === 'secret') {
        const configured = snapshot.configured[field.key];
        control = `<select name="secretOperation_${key}" aria-label="${label} — ${t('site.secretAction')}"${disabled}><option value="keep">${t(configured ? 'site.keep' : 'site.notSet')}</option>${field.clearOnly ? '' : `<option value="replace">${t('site.replace')}</option>`}<option value="clear">${t('site.clear')}</option></select>` + (field.clearOnly ? '' : `<input name="${key}" type="password" autocomplete="new-password" maxlength="2048" aria-label="${label} — ${t('site.replace')}" disabled>`);
      } else if (field.type === 'select') {
        control = `<select name="${key}"${disabled}>${field.options.map(option => `<option value="${escape(option)}" ${value === option ? 'selected' : ''}>${escape(option)}</option>`).join('')}</select>`;
      } else if (field.type === 'boolean') {
        control = `<input name="${key}" type="checkbox" ${String(value).toLowerCase() === 'true' ? 'checked' : ''}${disabled}>`;
      } else {
        control = `<input name="${key}" type="${field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : field.format === 'email' ? 'email' : 'text'}" value="${escape(value)}" maxlength="2048"${field.type === 'number' ? ` min="${field.minimum}" max="${field.maximum}" step="${field.step ?? 1}"` : ''}${disabled}>`;
      }
      return `<label class="${field.type === 'boolean' ? 'check' : ''}"><span>${label}</span>${control}${unavailable}</label>`;
    }).join('') + '</div></details>';
  }).join('') + `<p class="warning">${t('site.applyHint')}</p><label class="check"><input name="siteConfirmed" type="checkbox" required>${t('site.confirm')}</label><button class="primary" type="submit">${t('site.save')}</button></form>`;
}

/** Read only changed fields. Keep never transmits the stored secret or a blank replacement. */
export function siteSettingsInput(form) {
  if (!snapshot) throw new Error('Load website settings first.');
  const changes = {};
  for (const field of snapshot.fields.filter(field => field.supported)) {
    if (field.type === 'secret') {
      const operation = form.elements.namedItem('secretOperation_' + field.key).value;
      if (operation !== 'keep') changes[field.key] = operation === 'clear' ? { operation } : { operation, value: form.elements.namedItem(field.key).value };
    } else {
      const element = form.elements.namedItem(field.key);
      const value = field.type === 'boolean' ? String(element.checked) : element.value;
      const before = snapshot.values[field.key] ?? field.default;
      if (value !== before) changes[field.key] = value;
    }
  }
  return { siteSettings: { revision: snapshot.revision, changes, confirmed: form.elements.siteConfirmed.checked } };
}

export function syncSiteSecretControls(form) {
  if (!form) return;
  for (const select of form.querySelectorAll('[name^="secretOperation_"]')) {
    const input = form.elements.namedItem(select.name.slice('secretOperation_'.length));
    if (input) { input.disabled = select.value !== 'replace'; input.required = select.value === 'replace'; }
  }
}

export function bindSiteSettings(form) {
  if (!form) return;
  for (const select of form.querySelectorAll('[name^="secretOperation_"]')) {
    select.addEventListener('change', () => {
      const input = form.elements.namedItem(select.name.slice('secretOperation_'.length));
      if (!input) return;
      input.value = '';
      syncSiteSecretControls(form);
    });
  }
}
