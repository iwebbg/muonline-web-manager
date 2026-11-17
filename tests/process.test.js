import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/main/process.js';

test('command failure reports the exit code without exposing stdout or stderr secrets', async () => {
  await assert.rejects(execute(process.execPath, ['-e', "console.log('private-stdout'); console.error('private-stderr'); process.exit(7)"]), error => {
    assert.match(error.message, /exit 7/);
    assert.doesNotMatch(error.message, /private-stdout|private-stderr/);
    return true;
  });
});

test('process output preserves Cyrillic characters split across operating-system pipe chunks', async () => {
  const expected = JSON.stringify({ name: 'Администратор' });
  const code = `const bytes=Buffer.from(${JSON.stringify(expected)}); const index=bytes.findIndex(byte=>byte>127); process.stdout.write(bytes.subarray(0,index+1)); setTimeout(()=>process.stdout.write(bytes.subarray(index+1)),80);`;
  assert.equal(await execute(process.execPath, ['-e', code]), expected);
});
