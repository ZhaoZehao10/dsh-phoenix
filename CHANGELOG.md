# Changelog — P-282 / dsh-phoenix

The patch version matches the marker inside the built `main.js` (`/* P-282 renderer-recovery vN */`), so the installed artifact can be identified directly.

## v6 — 2026-11-04
- **Fix (v5 defect)**: at crash time the renderer process is already gone, so `app.getAppMetrics()` cannot see it — the log showed `renderers=n/a`. Added a **60-second heartbeat cache** (`p282LastRendererMemory`); recovery log and crash report now carry `last=` (the last renderer memory before the crash).
- **Install script fix**: a failed `taskkill` cleanup of an already-exited child process is no longer treated as a fatal error (previously it aborted the script after a successful BOOTCHECK).
- **Tests**: structure 12 / reference 11 / semantics 21 / crash-report 5 / fuzz 100 all green; live Phase A (1/2 → 2/2 → reset 1/2) + Phase B (5-round soak, main-process RSS drift 0 MB); v6 live heartbeat (`last=11180:157MB`), bounded escalation (audit line + recovery dialog), crash-report memory snapshot — all verified on a real machine.

## v5 — 2026-11-02
- **Crash-report memory snapshot**: `--- memory snapshot (P-282) ---` section (main process rss/heapUsed/external + system total/free + renderer private/workingSet).
- **Renderer memory watchdog**: samples every 5 minutes, logs a line to `renderer-memory.log` when a renderer exceeds 1.5 GB (log only, no UI). *(v6 changed the interval to 60 s and added the heartbeat cache.)*
- **BOOTCHECK build switch**: `DSH_NO_BOOTCHECK=1` builds without the self-check hook (the installer detects it and skips BOOTCHECK).
- New test `tests/test_crash_report_mem.mjs` (5 checks).

## v4 — 2026-11-02
- **Fuse safety check**: before touching the asar, the patcher reads the exe fuse wire; if `EnableEmbeddedAsarIntegrityValidation` is enabled it refuses (otherwise the patched asar would be rejected and the app would not start).
- **Memory context in the recovery log**: each line gains `| renderers=…MB mainRSS=…MB`.
- **Upgrade path**: if the installed asar already contains an older patch, the patcher automatically uses the newest backup as the clean source (the backup is never overwritten).
- **Install script uses the patch version** (v3 → v4 upgrade detected automatically instead of "already installed" being assumed).
- Soak test 5 rounds (65 s apart): every round records `recovery 1/2`; main-process RSS plateaus at ~355–360 MB.

## v3 — 2026-11-01
- **BOOTCHECK**: after swapping, the installer launches the app once (inert hook `DSH_PATCH_BOOTCHECK`: on `whenReady` it writes a marker and exits 77); failure rolls back automatically — the install becomes a verified transaction.
- Install-script fixes for Windows PowerShell 5.1: inline `node -e` double quotes stripped, `$node` variable swallowed by quote expansion, UTF-8 BOM required for Chinese comments.
- Version gate changed to an allow-list (rc.3 / rc.5) with `DSH_ALLOWED_VERSIONS` override.

## v2 — 2026-10-26
- **Time-reset budget**: isolated crashes more than 60 s apart do not consume each other's budget; only a tight loop exhausts it.
- **Auditable recovery**: `logs/renderer-recovery.log` (timestamp / reason / attempt).
- **Logging failure must not block recovery** (caught inside the block).
- Semantics expanded to 19 checks + 100-round randomized fuzz (model-based invariants).

## v1 — 2026-10-25
- First working surgical asar patch: same-length header JSON rewrite + appended `main.js` (validated with the official `@electron/asar` reference implementation).
- **Fixed the data-base off-by-one** (`8 + readUInt32LE(4)`; the old `16 + jsonLength` was 1 byte off on RC3 ⟹ the app refused to load).
- Initial handler semantics tests (C1–C7).

## Test coverage (honest record)

| Version | Semantics/unit | Structure+reference | 100-round fuzz | Crash report | Live install |
|---|---|---|---|---|---|
| v1 | C1–C7 (12) | ✅ | — | — | ✗ (base bug found during build) |
| v2 | C1–C9 (17) | ✅ | — | — | ✗ |
| v3 | C1–C10 (19) | ✅ | ✅ | — | **✅ install + 6 kills + 5-round soak** |
| v4 | C1–C12 (21) | ✅ | ✅ | — | ✗ (copy full-flow + byte-verified rollback) |
| v5 | 21 | ✅ | ✅ | ✅ 5 | ✅ Phase A/B (3 kills + 5-round soak) |
| v6 | 21 | ✅ | ✅ | ✅ 5 | ✅ heartbeat + escalation + crash-report memory |

> v3 was the first version installed and live-tested; v5/v6 repeated the live battery on the real machine.
> Static/simulation suites (structure 12, reference 11, semantics 21, crash-report 5, fuzz 100) are green for every version that ships.
