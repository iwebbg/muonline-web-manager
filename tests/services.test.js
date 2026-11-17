import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceRows } from '../src/renderer/services.js';

test('service cards normalize Compose JSON and distinguish unhealthy, stopped and unmeasured services', () => {
  const rows = serviceRows({ services: [{ Service: 'app', State: 'running', Health: 'unhealthy' }, { Service: 'nginx', State: 'running', Health: 'healthy' }, { Service: 'queue', State: 'exited' }] });
  assert.equal(rows[0].tone, 'failed');
  assert.equal(rows[1].tone, 'running');
  assert.equal(rows[2].tone, 'failed');
  assert.equal(rows[3].state, 'unknown');
  assert.equal(serviceRows({ services: '{invalid' }).every(row => row.state === 'unknown'), true);
  assert.equal(serviceRows({ services: '{"Service":"app","State":"running"}\n{"Service":"redis","State":"running","Health":"starting"}' })[3].tone, 'pending');
  assert.equal(serviceRows({ services: '[{"Service":"app","State":"<script>"}]' })[0].state, 'unknown');
});
