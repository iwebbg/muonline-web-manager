# Resource limits and external load tests

The 2 GB / 2 CPU profile is a measurement target, not a certified minimum. Keep SQL
Server and MuServer on their separate machine. Keep the working runtime unchanged
for the baseline comparison. Runtime load, first image compilation, updates and
SQL backup have different peaks and must be recorded separately.

## Limit WSL before the clean Windows VM installation

Run in the manager source checkout on Windows with Node 24+:

```powershell
npm run resources:wsl
npm run resources:wsl -- --apply --confirm-global
```

The first command previews 2 GB RAM, 2 logical CPUs and 1 GB **disk swap**. The second
explicitly acknowledges that `%UserProfile%\.wslconfig` affects **every WSL2 distro
of that Windows user**, including unrelated workloads. It preserves unrelated keys
and comments, handles UTF-8/UTF-16LE, refuses ambiguous duplicate resource settings,
and makes an exact backup of an existing configuration before replacing it. A repeat
with the same limits does not create another backup. It does not change VirtualBox
settings and does not invoke `wsl --shutdown` or interrupt running distributions.
The script is source tooling, not an automatic packaged-manager installation step.

Apply before starting WSL on the clean VM. For an already running WSL VM, schedule a
full WSL restart or Windows reboot after saving work; restarting only the manager
is insufficient. A full WSL shutdown stops all distros. Changing to 4 GB for comparison:

```powershell
npm run resources:wsl -- --memory-gb 4
npm run resources:wsl -- --memory-gb 4 --apply --confirm-global
```

After the restart, verify what Linux actually sees:

```powershell
wsl.exe -d Ubuntu-24.04 -u root --exec free -m
wsl.exe -d Ubuntu-24.04 -u root --exec nproc
```

Slightly less than 2 GB may be reported as usable Linux RAM. Swap must be reported
separately from RAM; heavy swapping invalidates a claim of comfortably fitting in RAM.
Windows itself, the Electron panel and the outer Windows VM need memory outside this
budget. If a compiler is killed during first Docker build, record it as an installation
failure under the limit, not as a measured runtime requirement.

Microsoft documents the global scope and activation rules in
[WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
Docker per-container memory limits are a possible later tuning step, but do not bound
Linux/Docker daemon overhead. No FPM/Redis/container tuning is applied by this tool.

## Run traffic outside the Windows VM

The dependency-free Node 24+ generator uses public GET routes found in the Laravel
source: `/`, `/rankings`, `/news`, `/events`, `/login`, `/register`, `/downloads`.
It never submits forms or issues game mutations. GET pages can still create ordinary
sessions, caches and logs. Login/register forms are not successful authenticated actions.
Use the origin of a **disposable test site**; the CLI requires `--confirm-test`.
No test automatically runs against an installed website or SQL server.

Prefer a third physical machine for traffic generation. The Linux host outside the
Windows VM is usable, but shares CPU/network with the VM; record that limitation.
Do not run the generator inside the WSL allocation being measured. Keep the external
SQL Server where it will actually run. A local SQL container remains useful for
functional testing, but cannot validate this deployment's network latency or resource
split. Target the site directly rather than a CDN cache or unrelated proxy.

On the traffic generator, create the ignored report directory (`mkdir -p artifacts`
on Linux; `New-Item -ItemType Directory -Force artifacts` on PowerShell). Substitute
the real reachable site origin; Local mode is not reachable from another machine.
For a VirtualBox VM, configure the chosen bridged/NAT forwarding and use the manager's
IP mode with its HTTP acknowledgement, or a working test domain with trusted TLS.
Do not make the public SQL port generally reachable just for this test.

Start at 10 users, then run 50, 100 and 200 separately:

```text
npm run load:test -- --url http://192.168.1.50 --mode users --concurrency 10 --think 10 --duration 120 --confirm-test --out artifacts/users-10.json
npm run load:test -- --url http://192.168.1.50 --mode users --concurrency 100 --think 10 --duration 180 --confirm-test --out artifacts/users-100.json
npm run load:test -- --url http://192.168.1.50 --mode users --concurrency 200 --think 10 --duration 180 --confirm-test --out artifacts/users-200.json
```

`users` means independent virtual visitors, each making one request then pausing around
`--think` seconds, with jitter. Each has a separate in-memory cookie jar. It does not
fetch page assets or run browser JavaScript. 100 visitors are not 100 simultaneous
SQL queries. Throughput decreases if the site slows down; this closed-loop test is
not a fixed requests-per-second benchmark.

Then distinguish a **single burst** from **sustained pressure**:

```text
npm run load:test -- --url http://192.168.1.50 --mode burst --concurrency 200 --paths /rankings --confirm-test --out artifacts/burst-200.json
npm run load:test -- --url http://192.168.1.50 --mode stress --concurrency 100 --duration 60 --confirm-test --out artifacts/stress-100.json
npm run load:test -- --url http://192.168.1.50 --mode stress --concurrency 200 --duration 60 --confirm-test --out artifacts/stress-200.json
```

`burst` attempts one GET per virtual client together, then ends. `stress` keeps up to
that many outstanding GET requests, with no visitor pause. Reported peak in-flight
requests are client observations; server queues and PHP execution are separate.
The maximum is 200 clients, one hour and 100,000 requests per run (the request bound
may end a sustained run early). Ctrl+C stops new work and waits for active request
timeouts, then reports an interrupted run; it does not call the manager or stop services.

Redirects are not followed and count as failed requests, including redirects outside
the origin. TLS checks remain enabled. Reports do not retain response bodies, cookies
or credentials and existing reports are never overwritten. The report includes UTC
start/end times, actual elapsed time, RPS, failures, HTTP status counts, timeouts,
per-route latencies and overall p50/p95/p99. Exit 2 means interruption or failed default
thresholds (more than 1% failed requests or p95 above 2000 ms); exit 1 means a tool error.
Thresholds are review criteria, not product SLAs; adjust with `--p95-ms` and
`--failure-rate` when documenting a different target.

429 means throttling, not proof of RAM exhaustion. All clients normally share one
source IP and may hit per-IP limits. Record this rather than disabling protection
automatically. Disabled pages or deployment redirects may need excluding with `--paths`.
A healthy HTTP result does not prove gameplay/business correctness.

## Measure both machines at the same timestamps

Before traffic, record five minutes at idle with the panel open, then closed. During
traffic, use Windows Task Manager / Resource Monitor for the VM and `VmmemWSL`, and
watch containers and Linux totals in separate terminals:

```powershell
wsl.exe -d Ubuntu-24.04 -u root --exec docker stats
wsl.exe -d Ubuntu-24.04 -u root --exec free -m
```

Do not add Docker process RSS, shared OPcache and Windows WSL totals together as if
they were independent allocations. WSL also contains kernel/file cache and Docker;
Linux container memory reporting can exclude cache. Record available RAM, swap use,
CPU, disk pressure, container restarts and OOM indicators, not just the largest number.

On the SQL machine, record baseline and peak SQL Server CPU, memory, disk latency,
connections, blocking and slow queries. SQL buffer caching may retain memory after
the run; a high working set alone does not prove a leak. Warm ranking/application
caches may produce little SQL traffic even under many HTTP requests. Compare a first
run with repeated warm runs and record cache settings without clearing shared production
caches. If SQL saturates first, that is not evidence the web VM needs more RAM.

Repeat at 2 GB and 4 GB with the same build, dataset, CPU cap and warmed state. Allow
the stack to settle between runs. Record setup/build and update separately. Use only
disposable accounts and databases for any later authenticated/action scenario. This
public-page generator does not certify account actions, queues, payments or writes.
