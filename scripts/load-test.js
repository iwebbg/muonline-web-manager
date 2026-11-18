/** Bounded public-page load generator. Never submits login, registration or game mutations. */
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const publicPaths = new Set(['/', '/rankings', '/news', '/events', '/login', '/register', '/downloads']);

/** Validate the test origin and bounded workload before opening any socket. */
export function workload(input) {
  let url;
  try { url = new URL(input.url); } catch { throw new Error('Provide --url with the test website HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Test URL must be an HTTP(S) origin without credentials, query or path.');
  const options = { origin: url.origin, concurrency: Number(input.concurrency ?? 10), duration: Number(input.duration ?? 60),
    mode: input.mode ?? 'users', timeout: Number(input.timeout ?? 10), think: Number(input.think ?? 3),
    paths: (input.paths ?? '/,/rankings,/news,/login').split(','), maxRequests: Number(input.maxRequests ?? 100000) };
  for (const [number, min, max] of [[options.concurrency, 1, 200], [options.duration, 1, 3600], [options.timeout, 1, 60], [options.think, 1, 60], [options.maxRequests, 1, 200000]]) {
    if (!Number.isInteger(number) || number < min || number > max) throw new Error('Workload exceeds supported bounds.');
  }
  if (!['users', 'stress', 'burst'].includes(options.mode) || !options.paths.length || options.paths.some(value => !publicPaths.has(value))) throw new Error('Use users/stress/burst mode and supported public GET paths.');
  return options;
}

/** Keep timing aggregates without storing response bodies, cookies, passwords or SQL data. */
function distribution(values) {
  if (!values.length) return { p50: null, p95: null, p99: null, max: null };
  values.sort((a, b) => a - b);
  const percentile = p => Math.round(values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]);
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: Math.round(values.at(-1)) };
}

/** Generate distinct client cookie jars; reuse sockets but never follow redirects or disable TLS checks. */
export async function runLoad(options, { signal, onSample = () => {} } = {}) {
  const secure = options.origin.startsWith('https:');
  const client = secure ? https : http;
  const Agent = secure ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: true, maxSockets: options.concurrency, maxFreeSockets: options.concurrency });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const deadline = started + options.duration * 1000;
  const elapsed = [];
  const timings = {};
  const statuses = {};
  const errors = {};
  let count = 0;
  let completed = 0;
  let failed = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let bytes = 0;

  /** Read one bounded response; transport errors remain anonymous diagnostic categories. */
  async function request(route, cookies) {
    const begin = performance.now();
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      const result = await new Promise(resolve => {
        let ended = false;
        let received = 0;
        const finish = result => { if (ended) return; ended = true; clearTimeout(timer); resolve(result); };
        const req = client.get(options.origin + route, { agent, headers: {
          'User-Agent': 'MuOnline-Review-Load-Test/1.0', Accept: 'text/html',
          ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') } : {})
        } }, res => {
          for (const header of res.headers['set-cookie'] ?? []) {
            const pair = header.split(';', 1)[0];
            const index = pair.indexOf('=');
            if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
          }
          res.on('data', chunk => {
            received += chunk.length;
            if (received > 10 * 1024 * 1024) { finish({ error: 'response_too_large', received }); req.destroy(); }
          });
          res.on('end', () => finish({ status: res.statusCode, received }));
          res.on('error', () => finish({ error: 'response_interrupted', received }));
          res.on('aborted', () => finish({ error: 'response_interrupted', received }));
        });
        const timer = setTimeout(() => { finish({ error: 'timeout', received }); req.destroy(); }, options.timeout * 1000);
        req.on('error', error => finish({ error: ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error.code) ? error.code : 'transport_error', received }));
      });
      const time = performance.now() - begin;
      elapsed.push(time);
      (timings[route] ??= []).push(time);
      bytes += result.received;
      if (result.status) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
      if (result.error) errors[result.error] = (errors[result.error] ?? 0) + 1;
      if (!result.status || result.status < 200 || result.status >= 300) failed++;
      completed++;
    } finally { inFlight--; }
  }

  const sampler = setInterval(() => onSample({ elapsedSeconds: Math.round((performance.now() - started) / 1000), completed, failed, inFlight }), 5000);
  try {
    await Promise.all(Array.from({ length: options.concurrency }, async (_, user) => {
      const cookies = new Map();
      let iteration = 0;
      while (!signal?.aborted && performance.now() < deadline && count < options.maxRequests) {
        count++;
        const route = options.paths[(user + iteration) % options.paths.length];
        await request(route, cookies);
        iteration++;
        if (options.mode === 'burst') break;
        if (options.mode === 'users') {
          const pause = Math.min(options.think * (0.5 + Math.random()) * 1000, Math.max(0, deadline - performance.now()));
          await delay(pause, undefined, { signal }).catch(() => {});
        }
      }
    }));
  } finally { clearInterval(sampler); agent.destroy(); }
  const seconds = (performance.now() - started) / 1000;
  return { schema: 1, startedAt, finishedAt: new Date().toISOString(), origin: options.origin,
    mode: options.mode, configuredConcurrency: options.concurrency, configuredDurationSeconds: options.duration,
    elapsedSeconds: Number(seconds.toFixed(2)), interrupted: signal?.aborted ?? false,
    requestLimitReached: count >= options.maxRequests, completed, failed, peakInFlight,
    requestsPerSecond: Number((completed / seconds).toFixed(2)), receivedBytes: bytes,
    httpStatuses: statuses, transportErrors: errors, latencyMs: distribution(elapsed),
    routes: Object.fromEntries(Object.entries(timings).map(([route, values]) => [route, { requests: values.length, latencyMs: distribution(values) }])) };
}

/** Require an explicit test invocation; exit nonzero for interrupted or failed performance thresholds. */
async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, concurrency: { type: 'string' }, duration: { type: 'string' },
    mode: { type: 'string' }, timeout: { type: 'string' }, think: { type: 'string' }, paths: { type: 'string' },
    out: { type: 'string' }, 'confirm-test': { type: 'boolean' },
    'p95-ms': { type: 'string', default: '2000' }, 'failure-rate': { type: 'string', default: '0.01' }
  } });
  const options = workload(values);
  const p95 = Number(values['p95-ms']);
  const failureRate = Number(values['failure-rate']);
  if (!Number.isFinite(p95) || p95 <= 0 || !Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) throw new Error('Invalid performance thresholds.');
  if (!values['confirm-test']) throw new Error('Provide --confirm-test to run against your disposable test installation.');
  console.log('GET-only ' + options.mode + ' test; concurrency=' + options.concurrency + '; target=' + options.origin);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  let summary;
  try { summary = await runLoad(options, { signal: controller.signal, onSample: sample => console.log(JSON.stringify(sample)) }); }
  finally { process.removeListener('SIGINT', stop); }
  summary.thresholds = { p95Ms: p95, failureRate, passed: !summary.interrupted && summary.completed > 0 && summary.failed / summary.completed <= failureRate && summary.latencyMs.p95 <= p95 };
  const report = JSON.stringify(summary, null, 2) + '\n';
  if (values.out) await writeFile(values.out, report, { mode: 0o600, flag: 'wx' });
  console.log(report);
  if (!summary.thresholds.passed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Load test failed. Check arguments, target and report path. No response bodies or credentials were logged.'); process.exitCode = 1; });
}
