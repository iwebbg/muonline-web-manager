import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { catalogs, resolveLocale, translate } from '../src/shared/i18n.js';
import { translateMessage } from '../src/shared/messages.js';
import { Backend } from '../src/main/backend.js';

test('both languages cover the same interface and interpolate values as plain text', () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.bg).sort());
  assert.equal(resolveLocale('bg-BG'), 'bg');
  assert.equal(resolveLocale('BG_bg'), 'bg');
  assert.equal(resolveLocale('de-DE'), 'en');
  assert.equal(translate('bg', 'verifiedRelease', { version: '<b>1.3.0</b>' }), 'Проверен release: <b>1.3.0</b>');
  assert.equal(translate('en', 'verifiedRelease', { version: '1.3.0' }), 'Verified release: 1.3.0');
  for (const locale of ['en', 'bg']) {
    assert.ok(Object.values(catalogs[locale]).every(value => typeof value === 'string' && value.length > 0));
  }
});

test('localized operational messages preserve paths, versions and original technical logs', () => {
  const original = 'Access change failed; previous configuration restored. Backup: /opt/muonline-web/backups/test';
  assert.equal(translateMessage('en', original), original);
  assert.equal(translateMessage('bg', original), 'Промяната на достъпа е неуспешна; предишната конфигурация е възстановена. Backup: /opt/muonline-web/backups/test');
  assert.equal(translateMessage('bg', 'Release endpoint returned HTTP 404. Artifacts may not be published yet.'), 'Release сървърът върна HTTP 404. Артефактите може още да не са публикувани.');
  assert.equal(translateMessage('bg', 'SQL diagnostic column: Character.Name'), 'SQL diagnostic column: Character.Name');
});

test('language persists independently of release feeds and rejects unsupported IPC values', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mu-language-'));
  const trust = path.join(folder, 'trust.json');
  await writeFile(trust, '{"keys":{}}');
  try {
    const backend = new Backend(folder, folder, trust, 'bg-BG');
    await backend.initialize();
    assert.equal((await backend.invoke('settings')).language, 'bg');
    await assert.rejects(backend.invoke('setLanguage', { language: '../../escape' }), /Invalid language/);
    await backend.invoke('setLanguage', { language: 'en', sqlPassword: 'never-persist' });
    await backend.invoke('saveSettings', { cdn: 'https://example.com', webChannel: 'web/stable', managerChannel: 'manager/stable', language: 'bg' });
    const stored = JSON.parse(await readFile(path.join(folder, 'settings.json'), 'utf8'));
    assert.equal(stored.language, 'en');
    assert.equal(stored.sqlPassword, undefined);
    const reopened = new Backend(folder, folder, trust, 'bg');
    await reopened.initialize();
    assert.equal((await reopened.invoke('settings')).language, 'en');
    assert.equal(reopened.settings.cdn, 'https://example.com');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
