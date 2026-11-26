import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Backend } from '../src/main/backend.js';
import { secretValues, redactSupportText } from '../src/main/support-logs.js';
import { translateMessage } from '../src/shared/messages.js';

test('website settings operations keep their fixed action and require confirmation before effects', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mu-site-test-'));
  try {
    const backend = new Backend(process.cwd(), directory);
    const requests = [];
    let keeps = 0;
    backend.runtime = async value => { requests.push(value); return { revision: 'test' }; };
    backend.ensureKeepalive = async () => { keeps++; };
    await backend.invoke('siteSettings', { action: 'install', path: '/secret' });
    assert.deepEqual(requests, [{ action: 'siteSettings' }]);
    await assert.rejects(backend.invoke('saveSiteSettings', { siteSettings: { confirmed: false } }), /Confirm/);
    assert.equal(keeps, 0);
    const siteSettings = { confirmed: true, revision: 'test', changes: { MAIL_PASSWORD: { operation: 'replace', value: 'private-password' } } };
    await backend.invoke('saveSiteSettings', { action: 'install', siteSettings, environment: {APP_KEY:'forged'} });
    assert.equal(keeps, 1);
    assert.deepEqual(requests.at(-1), { action: 'saveSiteSettings', siteSettings });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('nested replacement secrets including SMTP identity and provider IDs stay out of support logs', () => {
  const changes = Object.fromEntries(['MAIL_PASSWORD','MAIL_USERNAME','PAYPAL_CLIENT_ID','PAYPAL_WEBHOOK_ID','AWS_ACCESS_KEY_ID'].map((key,index) => [key,{operation:'replace',value:'private-value-'+index}]));
  const secrets = secretValues({ siteSettings: { changes } });
  assert.equal(secrets.size, 5);
  for (const change of Object.values(changes)) assert.equal(redactSupportText(change.value, secrets), '[REDACTED]');
  assert.match(translateMessage('bg', 'Website settings changed. Reload the settings and try again.'), /Презареди/);
  assert.match(translateMessage('bg', 'Website settings failed; previous configuration restored. Backup: /private/backup'), /\/private\/backup$/);
});
