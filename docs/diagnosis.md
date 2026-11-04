# Field incident: `Desktop renderer exited: oom` — full diagnosis record

Machine: 32 GB RAM Windows 11 · dsh-desktop 0.2.1-rc.2 / electron 44.7.0

## What happened

2026-10-24 11:05:42 (+08:00): the whole desktop app died with the fatal dialog
"Desktop renderer exited: oom". Task manager at the time: physical 23.9/32 GB,
commit 119/128 GB, 8.0 GB available.

## First reactions that were all wrong

- "DSH has a memory leak" — DSH's own 7 processes total ~0.95 GiB (measured).
- "The Web GUI leaks on long sessions" — not the proximate cause on this machine.
- "The two screenshot attachments were too big" — they were taken AFTER the crash.
- "Reinstall the app" — the dialog's own advice, useless for an oom.

## The diagnostic that actually worked

```powershell
Get-WinEvent -FilterHashtable @{LogName='System';
  ProviderName='Microsoft-Windows-Resource-Exhaustion-Detector'}
```

Two records (Event ID 2004), 74s and 8s before the renderer died:

| | 11:04:30 | 11:05:34 |
|---|---|---|
| SystemCommitLimit | 127.9 GiB | 127.9 GiB |
| SystemCommitCharge | 127.73 GiB (99.87%) | 127.65 GiB (99.81%) |
| PhysicalMemoryUsage | 31.4 / 31.87 GiB | 31.67 / 31.87 GiB |
| Processes | 623 | 609 |
| Top1 | python.exe = 4.19 GiB | python.exe = 5.33 GiB |
| Top2 | vmmemWSL = 3.45 GiB | python.exe = 3.04 GiB |
| Top3 | python.exe = 3.04 GiB | vmmemWSL = 3.00 GiB |
| Top4 | python.exe = 1.48 GiB | python.exe = 1.48 GiB |

The Electron renderer is **not in the top 4** ⟹ its commit charge was < 1.48 GiB
⟹ its V8 heap (< commit) was at ≤35% of its ceiling — it was a **victim** of
system-wide commit exhaustion, not the culprit. The pagefile had already been
grown to ~96 GiB (127.87 − 31.87) — the machine was thrashing before it died.

## Lesson 1: `reason: 'oom'` covers three different failures

| class | mechanism | fixed by |
|---|---|---|
| A | renderer V8 heap exhausted (unbounded resident event window) | bounded window (patch 02) + recovery (patch 01) |
| B | process-level memory accounting limits | partially patch 01 |
| C | real OS memory pressure | demand-side fixes outside the app |

The renderer-victim argument (V8 heap is committed memory; not in top-4 ⟹
heap < 1.48 GiB < 4.19 GiB ceiling) rules out A on this machine — but on a
14.7 GB machine with a 22-day 164 MB session, class A reproduced exactly as
described in the session-profile analysis. Both are real; the crash reason
string does not discriminate. **Always pull the OS event log first.**

## Lesson 2: the workload DSH launches is part of its blast radius

The field incident's commit exhaustion was driven by a test-gate suite the
agent itself was running (140 Python checks; two `python.exe` at 5.33/3.04 GiB)
plus a leaked embedding-server process pattern (each `loadOlder()`-triggered
hybrid search spawned a 585 MB ONNX server that was never terminated — fixed
separately in our local project). An agent that runs heavy workloads needs
memory preflight: check free/commit memory before launching, and reap orphans.

## Lesson 3: DSH-specific engineering notes (for the local patch tooling)

- `ELECTRON_RUN_AS_NODE=1` is set by the desktop main for its child processes
  (`main.js` line ~3653). Any Electron exe launched **from a DSH tool process**
  inherits it and silently runs as plain Node (exit 0 with no args, exit 9
  "bad option" with args). Clear it before launching Electron for testing.
- Electron fuse `EnableEmbeddedAsarIntegrityValidation` is disabled in the
  shipped build, and `resources/app.asar` is user-writable — a surgical asar
  patch (header edit in place + appended file) is viable as a stopgap, but
  must use the exact data-base formula `8 + headerSize` (an off-by-one in the
  data-base offset made the app unbootable and was caught by the official
  `@electron/asar` reference implementation, not by home-grown parsers).
- RC2 → RC3 of the desktop shell: the compiled `main.js` differs by exactly
  one line (the version string) — verified after fixing the extraction base.

## Verification artifacts

- 19-assertion handler semantics (extracted verbatim from the patched source)
- byte-level structural proof (169.5 MB data area identical; header diff =
  the single main.js entry)
- official reference implementation (@electron/asar 4.3.1) round-trip
- bounded-window tests against a real 60,858-event session profile
