**English** | [中文版](overview.zh-CN.md)

# Desktop renderer OOM → total app loss: recovery patch + bounded event window

DeepSeek Harness desktop (Electron shell `@deepseek-ai/dsh-desktop`) currently
escalates **any** renderer death — including `oom` — to a fatal dialog
(`reportFatal`), which takes down the whole application: in-flight turns are
interrupted, background jobs are lost, and the user must manually restart.

This package proposes two changes plus supporting evidence:

| patch | what it does |
|---|---|
| `01-desktop-renderer-recovery.patch` | A dead renderer is **recoverable state**: the session log is durable on disk and the Host is still healthy, so the page reload restores the view. Reloads are bounded (2 per 60s) so a session that deterministically exhausts the heap on load still surfaces a diagnostic. Each recovery is persisted to `logs/renderer-recovery.log`. |
| `02-bounded-event-window.patch` | The resident event window in `MutableSessionEventSource` grows with every history page and never shrinks (each `loadOlder()` prepends permanently). This bounds the window to a byte budget with tail retention — the root cause of renderer heap exhaustion on very long sessions. |

Both patches apply cleanly to `master` (verified 2026-10-28 against
`f3803c96`, 0.2.2-alpha.2).

## Why we believe this is the field failure we saw

On a 32 GB Windows machine, `DeepSeek Harness.exe` died with
`Desktop renderer exited: oom` (crash log preserved). The diagnostic path that
actually identified the cause:

1. **Windows Resource-Exhaustion-Detector events** (`System` log, Event ID 2004)
   fired twice before the crash: `SystemCommitCharge 127.7 GiB / SystemCommitLimit
   127.9 GiB (99.8%)`, physical RAM at 99.4%, with the top memory consumers being
   `python.exe` test processes and a WSL2 VM — **the renderer was not in the top 4**.
   The renderer died 8 seconds after the second event.
2. On a second machine (14.7 GB RAM), a repro was built from a real failing
   session: **164 MB raw / 60,858 events / 22 days**, with the resident event
   window growing per `loadOlder()` and never shrinking (measured `+169 MB`
   unbounded vs `+46 MB` bounded; peak `164.25 MB → 47.89 MB` with the bounded
   window).

So there are two independent legs that produce the same `reason: 'oom'`:

| class | mechanism | discriminator | fixed by |
|---|---|---|---|
| A | renderer V8 heap exhausted by the unbounded resident event window | single session ≫ others (10×+); renderer PrivateMB climbs 2–4 GB then dies; short sessions don't grow | patch 02 (root cause), patch 01 (damage control) |
| B | process-level memory accounting (partition / pointer-compression cage) | process memory far below physical RAM, still killed | partially |
| C | real OS memory pressure (commit limit) | commit ≈ limit; whole system degraded; other apps misbehave too | not renderer-side |

`reason: 'oom'` covers all three — **the crash reason string alone does not
discriminate**. We recommend the Resource-Exhaustion-Detector check (section
"Diagnosing" below) before blaming the renderer.

## What patch 01 changes

```ts
window.webContents.on('render-process-gone', (_event, details) => {
  navigation = undefined
  if (quitting || window.isDestroyed() || details.reason === 'clean-exit') return
  if (Date.now() - lastRecoveryAt > RECOVERY_BUDGET_RESET_MS) rendererRecoveries = 0
  const recoverable = RECOVERABLE_RENDERER_EXITS.has(details.reason)
    && rendererRecoveries < MAX_RENDERER_RECOVERIES
  if (!recoverable) {
    reportFatal(new Error(`Desktop renderer exited: ${details.reason}`), 'renderer')
    return
  }
  rendererRecoveries += 1
  lastRecoveryAt = Date.now()
  logRendererRecovery(`renderer exited (${details.reason}); reloading page (recovery ${rendererRecoveries}/${MAX_RENDERER_RECOVERIES})`)
  setTimeout(() => {
    if (quitting || window.isDestroyed()) return
    try { window.reload() } catch (error) { reportFatal(error, 'renderer') }
  }, RENDERER_RECOVERY_DELAY_MS)
})
```

Design points:

- **Bounded**: 2 reloads per 60s window, then escalate to the existing
  `reportFatal` — a session that crashes on every load still produces a
  diagnostic instead of an endless reload loop.
- **Time-reset budget**: crashes isolated by more than 60s do not consume each
  other's budget; only a tight loop does.
- **Auditable**: each recovery appends to `logs/renderer-recovery.log`
  (timestamp, reason, attempt counter). Logging failure never blocks recovery.
- **No behavior change for normal operation**: the only observable difference
  is that a dead renderer reloads instead of killing the app.

## Diagnosing `oom` crashes before blaming the renderer

```powershell
Get-WinEvent -FilterHashtable @{LogName='System';
  ProviderName='Microsoft-Windows-Resource-Exhaustion-Detector'} |
  ForEach-Object { $_.TimeCreated; $_.Message }
```

Each event carries `SystemCommitLimit`, `SystemCommitCharge`,
`PhysicalMemoryUsage`, process count, and the top-4 commit consumers. If commit
is at the limit and the renderer is not among the top consumers, the renderer
was a **victim** of system memory exhaustion — the crash is real but the fix is
not renderer-side.

## Test evidence

`tests/handler-semantics.mjs` extracts the patched segment from
`apps/desktop/src/main.ts` **verbatim** and drives it with stubs (Node ≥ 23.6
native type stripping; no build step):

```
$ git apply patches/01-desktop-renderer-recovery.patch
$ node tests/handler-semantics.mjs
  PASS  C1 oom -> reload 1x, no fatal
  PASS  C2 crashed -> reload
  PASS  C2b killed -> reload
  PASS  C7 destroyed window -> no-op
  PASS  C6 quitting -> no-op
  PASS  C3 clean-exit -> no-op
  PASS  C4 integrity-failure/launch-failed/abnormal-exit -> fatal, no reload
  PASS  C9 every recovery audited to renderer-recovery.log
PASS: all handler-semantics cases
```

`tests/bounded-event-window.mjs` + `tests/verify-scrollback-scenario.cjs`
validate patch 02 against a real 60,858-event session profile
(`tests/session-profile.json`, shape `{t, b, s}` only — no message content):

```
$ node tests/verify-scrollback-scenario.cjs tests/session-profile.json
peak after paging : 47.89 MB    RESULT: PASS
```

## Applying locally without a source build

If you need the fix on an installed desktop app before an official release,
`app.asar` can be patched surgically: the header JSON is rewritten in place
(the data area is untouched byte-for-byte) and the patched `main.js` is
appended — `@electron/asar` 4.3.1 validates the result. See the discussion
post for the tooling. Caveats: the next official update replaces the patch,
and the update channel should be verified afterwards.

## Request for discussion

1. Should `reason: 'oom'` (and `crashed`, `killed`) trigger a bounded page
   reload instead of the fatal dialog? We believe the window is a pure view
   over durable state, so yes — but we'd like scrutiny of the budget bounds
   (2 reloads / 60s, time-reset budget).
2. Should the resident event window be byte-bounded by default (patch 02)?
   The field data says a 22-day session reaches 164 MB raw; the bounded window
   keeps the same UX at ~48 MB with tail retention.
3. Would upstream accept a diagnostic improvement: attach memory counters
   (`os.freemem/totalmem`, `process.memoryUsage()`, Host child RSS) to
   renderer crash reports? Today's crash report carries none, which is why
   diagnosing the field incident required the Windows event log.
