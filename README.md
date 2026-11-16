# BoDealer process supervisor

This is the small HTTP service used by `bodealer-ui`. It starts one native Walrus process per uploaded task, captures its output, exposes its result, and terminates Walrus and its Oscar child when a task is cancelled.

## Prerequisites

- Node.js 18 or newer
- A CMake build of BoDealer with Walrus and Oscar colocated in `build/bin`

Install the server packages with `npm install`. Installing npm packages does not install native solvers; build or supply Walrus and Oscar separately.

## Configure and run

The server resolves Walrus in this order:

1. `WALRUS_PATH` (the full executable path)
2. `BODEALER_BIN_DIR` plus `Walrus.exe` on Windows or `walrus` on macOS/Linux
3. Platform-local runtime directory: `exes/darwin`, `exes/linux`, or `exes/win32`, selected automatically

The matching runtime directory must contain the pair produced by that platform's CMake build:

- macOS: `exes/darwin/walrus` and `exes/darwin/oscar`
- Linux: `exes/linux/walrus` and `exes/linux/oscar`
- Windows: `exes/win32/Walrus.exe` and `exes/win32/Oscar.exe`

To refresh a platform, copy both files from BoDealer's `build/bin` into its directory. Do not mix binaries from different platforms or builds. `WALRUS_PATH` and `BODEALER_BIN_DIR` remain useful when executables should stay outside this repository.

To run directly against the local sibling checkout on macOS or Linux instead:

```sh
BODEALER_BIN_DIR=/Users/nastya/private/BoDealer/build/bin npm start
```

The same build can be selected by its full path:

```sh
WALRUS_PATH=/Users/nastya/private/BoDealer/build/bin/walrus npm start
```

Linux uses the same environment-variable syntax. Ensure both `walrus` and `oscar` are executable and colocated.

Windows PowerShell:

```powershell
$env:BODEALER_BIN_DIR = 'C:\src\BoDealer\build\bin'
npm start
```

Or set `$env:WALRUS_PATH` to the full `Walrus.exe` path. The service listens on port 3001 by default; set `PORT` to override it.

## API and lifecycle

`POST /tasks` accepts multipart form data with a required `configFile` and returns HTTP 202 with the task ID. Walrus runs directly with `-cfgname`, `-logresult`, and `-exitondone`, using its executable directory as the working directory so it can locate Oscar.

`GET /tasks/:id` returns `running`, `completed`, `failed`, or `cancelled`. While a task is running, `resultText` contains Oscar's result file as currently written and `logTail` contains the latest combined Walrus stdout/stderr (up to 64 KiB). These fields continue to contain the final output after completion; `result` remains an alias of `resultText` for existing clients. `DELETE /tasks/:id` cancels an active process tree.

Task files remain isolated under `jobs/<uuid>/`. In-memory process handles do not survive a server restart, so tasks from an earlier server process can be inspected but not cancelled.

Run focused tests with `npm test`.

For development, `npm run dev` watches only the server source and package manifest. Job state, logs, and results under `jobs/` are deliberately excluded so creating a task cannot restart the supervisor while Walrus is running.

## Queue, health, and recovery

`MAX_CONCURRENT_TASKS` is a positive integer, default **2**. One Node instance
owns a FIFO queue; each running task consumes one slot until its process closes
and state/log finalization finishes. Additional tasks return HTTP 202 with
`queued` status. Cancelling queued work never launches it. Completion, failure,
and running cancellation release a slot for the next task. Uploads are admitted
when their configuration and initial state have been written successfully.

`GET /health` returns `status`, `runningTasks`, `queuedTasks`, and
`maxConcurrentTasks`, without starting a calculation. Counts include slots
reserved during startup/finalization. It returns 503 during shutdown or recovery
failure.

`JOBS_DIR` overrides the default `<repository>/jobs` directory. Task paths are
absolute; each UUID retains its configuration, logs, results and state. State
updates are serialized and atomically renamed. Walrus still runs with its
executable directory as cwd. Oscar remains beside Walrus. On POSIX each solver
pair has a dedicated process group; cancellation signals the whole group with
SIGTERM and, after 500 ms, SIGKILL. Windows retains `taskkill /T /F`.

Startup reads existing states before accepting requests. Completed, failed and
cancelled tasks and their files remain available. Previously **running and queued
work becomes failed**, with an interruption explanation and end timestamp.
Nothing is automatically retried. Persisted PIDs are historical data and are
never signalled on recovery. A corrupt/missing state in a UUID directory stops
startup with the affected path rather than silently losing it; inspect and
repair that directory before restarting.

SIGTERM and SIGINT stop admissions and queue scheduling, mark unfinished tasks
failed, terminate their process groups, and flush final state before exit.
Shutdown has a 15-second deadline; Compose allows 25 seconds. A forced container
stop kills its processes; the next startup recovers interrupted disk states.
Outside containers, killing Node with SIGKILL can leave native children; use
normal signals and an OS process supervisor. Never run two Node instances
against the same jobs directory.

## Docker on a single Linux host

Prerequisites: Docker Engine/Desktop (or a running Colima VM), Compose v2,
and **Linux ELF builds of both `walrus` and `oscar` for the image architecture**.
The macOS and Windows binaries cannot run in this image. Build the Linux pair
from the sibling C++ checkout before building the application image:

```sh
sh scripts/build-linux-solvers.sh ../BoDealer
docker compose build
```

The helper copies only build sources into a temporary Docker context, compiles
in Debian bookworm and writes both executables into `exes/linux`. It leaves the
C++ checkout unchanged and does not rely on Colima sharing the host project path.
It retains the `bodealer-native-build:local` image for inspection/build caching;
its temporary copy container and host context are removed automatically.
Docker's selected platform determines the resulting CPU architecture.

Build the unchanged native source on Debian 12/bookworm for the deployment CPU.
The sibling BoDealer checkout uses CMake, C++17, Threads, curses, and a static DDS
library. For example, in a Debian bookworm Linux build environment:

```sh
apt-get update
apt-get install -y build-essential cmake libncurses-dev
cmake -S /src/BoDealer -B /tmp/bodealer-build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
cmake --build /tmp/bodealer-build --parallel 2
cp /tmp/bodealer-build/bin/walrus /src/bodealer-server/exes/linux/walrus
cp /tmp/bodealer-build/bin/oscar /src/bodealer-server/exes/linux/oscar
```

`/src/BoDealer` and `/src/bodealer-server` above are paths mounted into that
build environment; the server repository does not contain the native source.
Do not copy macOS builds or compile on a newer glibc distribution and assume
compatibility. On Apple Silicon the default Docker architecture is usually
ARM64; an AMD64 VPS requires matching AMD64 native builds and an AMD64 image
(for example with `DOCKER_DEFAULT_PLATFORM=linux/amd64` and matching emulation).

Native runtime inspection: the sibling `CMakeLists.txt` links DDS statically
and Walrus to curses; the Docker image installs `libncurses6`, `libncursesw6`, `libtinfo6`,
`libstdc++6` and `libgcc-s1` (glibc comes from Debian). The build checks each
solver's ELF format, architecture/loader and `ldd` dependencies, and fails if
anything is missing. This dependency check passed for the Linux ARM64 pair built locally using
`scripts/build-linux-solvers.sh`.

In the inspected POSIX implementation, `waOwl.cpp` resolves Oscar from Walrus's
executable directory and forwards `-logresult`; `waConfig.cpp` accepts the
absolute config path, and Oscar's pipe mode appends to the supplied result file.
The scoring tables are compiled into the executables. No external resource
pack was identified for the normal pipe-mode calculation. The image copies
**all of `exes/linux`**, so include any resources required by your specific
build there. Legacy command/progress/solution names are relative to cwd; only
the regular API/pipe-mode workload has been concurrency-tested. Additional
native modes or different builds need the real Linux integration check before
use. Do not configure a shared Oscar HTTP service for these per-task launches.

Build and start from this repository:

```sh
docker compose build
docker compose up -d
curl http://127.0.0.1:3001/health
```

The image uses Node.js 22 on Debian bookworm, runs as the `node` user, and uses
tini to forward signals and reap native children. The named Compose `jobs`
volume mounts at `/app/jobs` and survives container recreation. The image's
health check probes the API only. Compose restarts the service unless stopped
explicitly; an unhealthy result alone does not restart a running container.
See the [Docker Compose service reference](https://docs.docker.com/reference/compose-file/services/)
for restart, healthcheck, port and shutdown settings.

Settings:

```sh
MAX_CONCURRENT_TASKS=2 PORT=3001 docker compose up -d
```

`PORT` here selects the host port; the container API remains on 3001. Compose
binds to **127.0.0.1**. A host HTTPS reverse proxy should expose it to the Vercel
UI. The service does not add authentication or CORS policy in this change; keep
the existing UI proxy arrangement or configure the reverse proxy for the actual
UI origin. Public unrestricted solver access is not a deployment assumption.

Inside Docker, `BODEALER_BIN_DIR` defaults to `/app/exes/linux`; `WALRUS_PATH`
can override it. Paths passed to Compose must refer to locations **inside the
container**. Custom runtime paths require a corresponding bind mount and
read/execute access for UID 1000. Direct `docker run` can override `JOBS_DIR`;
mount a writable volume at the same location. Compose intentionally fixes the
persistent path at `/app/jobs`.

Operations:

```sh
docker compose logs -f api
docker compose stop api
docker compose start api
docker compose restart api
docker compose down
docker compose up -d
```

`down` preserves the named jobs volume. Do not use `down -v` if you want to keep
results. Inspect task files with `docker compose exec api ls -l /app/jobs`.
For a host bind mount instead of the named volume, ensure UID 1000 can write it.

## Tests and current validation

```sh
npm test
npm run test:concurrency
npm run test:docker
```

- `npm test`: controlled fake executable tests for HTTP behavior, FIFO capacity,
  completion/failure promotion, queued/running cancellation, live progress,
  recovery, invalid startup state/configuration, and actual SIGTERM/SIGINT
  handling of a standalone Node server. These are **not real solver tests**.
- `test:concurrency`: two real native solver pairs using the known working
  configuration, independent config/result inodes, process samples, overlap,
  result validation and nondeterministic output comparison. See
  [the test report](test/CONCURRENCY.md).
- `test:docker`: a host-side runner builds a uniquely named test image, reuses
  the real pair test inside Linux, then launches its own API and volume. It
  checks two running tasks, third-task queueing and promotion after natural
  completion, independent files, partial results, queued cancellation, real
  Walrus/Oscar process disappearance on cancellation, normal shutdown, container
  recreation with preserved files, and recovery after SIGKILL. HTTP polling,
  subprocesses and the whole test have bounded timeouts. It removes only its
  own container, image and volume, even on failure; it never uses the Compose
  service's volume. Linux binaries and a reachable engine are required.

The initial Docker run was blocked by a stale Colima socket and missing Linux
binaries. On 2026-11-15, the socket connection was restored without restarting
existing containers, both Linux ARM64 solvers were built from unchanged source,
and `docker compose build` passed, including ELF and dynamic dependency checks.
The real pair test inside Linux passed with 114.371 seconds of overlap, exit
codes 0, independent valid results and no shared-runtime file changes. Linux
outputs differed beyond timing, consistent with nondeterministic sampling.
The local controlled-fixture/configuration suite previously passed 14 tests;
integration tests are opt-in. The full real Docker lifecycle test also passed in 315.303 seconds, including
queue promotion, partial results, cancellation of both native processes, volume
persistence and graceful/forced restart recovery. Details are recorded in
[test/CONCURRENCY.md](test/CONCURRENCY.md).

## Before a VPS deployment

1. Supply matching Linux binaries/resources, build the image, and pass
   `npm run test:docker` on the deployment architecture.
2. Choose CPU/RAM limits and concurrency for the host: each Walrus calculation
   can use native threads, so a limit of two tasks is not a limit of two CPUs.
3. Configure DNS, TLS, reverse proxy routing and UI connectivity, with a decision
   about who may submit work. No user accounts/authentication were added.
4. Set up volume backups, disk monitoring and an explicit result-retention
   policy. Task data and the in-memory queue are not bounded by a disk quota.
5. Run exactly one server container for this volume. There is no distributed
   locking, durable queue replay, database or automatic calculation retry.
