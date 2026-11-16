# Native concurrency integration test

From the repository root on macOS or Linux, with Node.js 18+:

```sh
npm run test:concurrency
```

The command uses the normal `WALRUS_PATH` / `BODEALER_BIN_DIR` resolution.
Walrus and Oscar must be colocated. `CONCURRENCY_TIMEOUT_MS` overrides the
180000 ms calculation deadline. Each HTTP request also has a 10-second deadline.
The test needs permission to listen on loopback and run `ps`.
Ordinary `npm test` skips this native integration test.

The unchanged fixture was copied from the successfully completed task
`044d2bf3-3052-499e-bdc4-a749644df731` (20,016 boards, SCALE 20).
The test starts the existing Express app on an ephemeral port and submits two
multipart requests concurrently. It polls both tasks and samples Walrus/Oscar
PIDs every approximately 200 ms. A separate temporary directory retains all
task files, a copied runtime shared by both processes, and `report.json`.
The original runtime and existing jobs are untouched. On timeout or failure,
only this test's unfinished tasks are cancelled through the existing API;
their files are retained.

Checks cover completion and Walrus exit codes/signals, unique task IDs/PIDs,
task-local launch arguments, unchanged configuration bytes, separate result
inodes, required files, matching task/scorer headers, final summaries and
consistent processed/down/make totals. Before/after runtime snapshots detect
new, missing or modified shared files (including mtime changes). These snapshots
cannot rule out temporary files created and removed between snapshots.
Process samples establish simultaneous execution and capture Oscar child PIDs;
Oscar exit codes are not exposed by the API and are not directly observable by
this test. Walrus exits and complete Oscar results are checked instead.

The report compares raw results and results with only the performance footer
and insignificant whitespace normalized. It preserves differences in numerical
statistics and example deals: a different Monte Carlo sample is not by itself
a failure. Matching task headers and independently valid board totals are
required. This is a two-user concurrency check, not a production load test or
a proof that statistical differences cannot result from interference.

## Local result, 2026-11-13

Passed with the repository's `exes/darwin/walrus` and `oscar`.
All times below are UTC.

| Task ID | Walrus PID | Oscar PID | Start | End | Duration | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| 15568f6d-a1bc-4a7d-8c3c-74c077c99fe1 | 72131 | 72168 | 22:02:35.288 | 22:03:37.309 | 62.021 s | 0 |
| 5359526f-8cb9-4b1b-a185-f0f93a4dfc1a | 72130 | 72167 | 22:02:35.288 | 22:03:37.856 | 62.568 s | 0 |

Overlap: **62.021 seconds**, confirmed by live process samples (242 samples).
Both results contained 20,016 boards, had distinct inodes and valid totals.
No missing files, shared-runtime changes, or abnormal Walrus terminations
were detected. The result files were not identical even after timing
normalization: make rates were 63.0% and 62.8%, with different filter counters
and score distributions, consistent with nondeterministic sampling.

Full report and artifacts from this run:
`/private/var/folders/p3/h2q2g7jn2q98j50qvlwhkdyh0000gn/T/bodealer-concurrency-kicykW/report.json`.
Temporary artifacts remain available until removed by the OS or user.
The regular suite also passed: 7 tests passed, native test skipped.

## Queue supervisor regression, 2026-11-15

Passed against the updated supervisor with its default concurrency limit of two:

| Task ID | Walrus PID | Oscar PID | Duration | Exit |
| --- | --- | --- | --- | --- |
| dab6fe74-11c0-4cef-8ebb-027e9c839802 | 38497 | 38534 | 63.201 s | 0 |
| 82d5c936-37e9-4760-8d0c-ddb2da4dfe13 | 38498 | 38533 | 62.253 s | 0 |

Overlap: **62.253 seconds**; 243 process samples. Both results validated,
with separate files and no shared runtime changes. Numerical outputs differed
beyond performance timing, with matching task headers. This was a macOS run;
it does not validate the Linux Docker image.

New runs now clean up their own temporary directory by default. To retain a
report and all files for investigation:

```sh
KEEP_TEST_ARTIFACTS=1 npm run test:concurrency
```

Earlier runs listed above retained their artifacts; those directories are not
deleted by subsequent tests. Docker tests remove their own container and volume.

Final verification after log/state finalization and cleanup changes also passed:
`26a86d56-e1eb-4adc-bd6a-febb79fe27bd` (Walrus 47667, Oscar 47704,
65.372 s, exit 0) and `d8b3c4de-b7f1-4c16-8b42-24ad7f20567e`
(Walrus 47666, Oscar 47703, 65.350 s, exit 0). Overlap was **65.346 s**,
with 255 process samples, independent valid results and no shared runtime
changes. This run's own temporary directory was removed automatically.

## Linux ARM64 Docker validation, 2026-11-15

Built Walrus/Oscar from the unchanged sibling C++ source in Debian bookworm,
using `sh scripts/build-linux-solvers.sh ../BoDealer`. The application Compose
build passed ELF and dynamic dependency validation.

The existing real pair test passed inside the Linux container:

| Task ID | Walrus PID | Oscar PID | Duration | Exit |
| --- | --- | --- | --- | --- |
| fc942d11-4010-405b-a32f-0a7755871618 | 42 | 43 | 114.371 s | 0 |
| 9282d9a1-a9cf-4b75-8707-9efcef7e8f70 | 38 | 39 | 123.470 s | 0 |

Overlap: **114.371 seconds**, confirmed with 559 process samples. Both results
validated, with different inodes and no shared-runtime file changes. Outputs
were not identical after timing normalization, with matching task headers.
The temporary pair-test container and files were automatically removed.

The full Docker lifecycle suite subsequently passed in **315.303 seconds**.
Two real calculations overlapped for **111.828 seconds**; all three completed
with exit code 0 and independent config/result files:

| Task ID | Walrus PID | Duration | Exit |
| --- | --- | --- | --- |
| 21f1a677-d640-459f-954f-1e4019508fe7 | 18 | 113.067 s | 0 |
| 53ab4f8b-13d1-4452-ab79-8ad1ba6a072e | 19 | 111.828 s | 0 |
| 1aac38f9-212a-4cbd-956c-61241c61a80f | 954 | 61.234 s | 0 |

The third started 6 ms after the second finished. Additional checks passed:
partial Oscar results/logs while running, queued cancellation without spawning,
running cancellation removing Walrus and Oscar, graceful shutdown and container
recreation preserving completed file hashes/inodes and terminal statuses, and
SIGKILL recovery marking interrupted running/queued tasks failed without replay.
Test-owned containers, image and volume were cleaned up.

The first lifecycle attempt exposed an overly strict test expectation of exactly
20,016 boards; a valid native worker run produced 20,004 with consistent totals.
The test now requires at least the configured 20,000 boards and verifies that
make/down counts sum to the processed total, matching the existing pair test.

## Service-token regression, 2026-11-16

The real Linux Docker suite passed with production authentication enabled and
random disposable tokens: **365.794 seconds** overall. The initial real pair
check passed with **111.603 seconds** of overlap; the three-task API phase
observed **146.584 seconds** of overlap between the first two calculations.
Authorized submission, live polling, queue promotion, queued/running cancellation,
file persistence and graceful/forced restart recovery all passed. A missing-token
submission was rejected with 401 before any task was created. Credentials were
passed via the child environment to Docker, never in command-line arguments or
reports; the server removes the service token from the solver environment.
