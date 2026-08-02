# BoDealer process supervisor

This is the small HTTP service used by `bodealer-ui`. It starts one native Walrus process per uploaded task, captures its output, exposes its result, and terminates Walrus and its Oscar child when a task is cancelled.

## Prerequisites

- Node.js 18 or newer
- A CMake build of BoDealer with Walrus and Oscar colocated in `build/bin`

Install the server packages with `npm install`. No BoDealer executable is copied into this repository.

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

`GET /tasks/:id` returns `running`, `completed`, `failed`, or `cancelled`, plus `resultText` when produced and a tail of combined stdout/stderr. `DELETE /tasks/:id` cancels an active process tree.

Task files remain isolated under `jobs/<uuid>/`. In-memory process handles do not survive a server restart, so tasks from an earlier server process can be inspected but not cancelled.

Run focused tests with `npm test`.

For development, `npm run dev` watches only the server source and package manifest. Job state, logs, and results under `jobs/` are deliberately excluded so creating a task cannot restart the supervisor while Walrus is running.
