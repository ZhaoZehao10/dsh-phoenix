# Patches

Three source patches for upstream review. Apply order matters; each is validated against
`master` (`fcc0ad46`, 2026-11-04) with `git apply --check`.

| Patch | Files | What it does | Depends on |
|---|---|---|---|
| `01-desktop-renderer-recovery.patch` | `apps/desktop/src/main.ts` | Bounded page-reload recovery for renderer exits (`oom` / `crashed` / `killed`): 250 ms reload, max 2 per rolling 60 s window with time-reset budget, every recovery appended to `logs/renderer-recovery.log`. Still escalates to the existing `reportFatal` when the budget is exhausted. | — |
| `02-bounded-event-window.patch` | `packages/api/session-controller/src/client/contract/events.ts`, `.../sessions/session.ts` | Byte-bounded resident event window with tail retention (root cause of renderer heap growth on very long sessions). | — |
| `03-desktop-ui-snapshot.patch` | **new** `apps/desktop/src/ui-guard.ts`, `apps/desktop/src/main.ts` (2-line hook) | UI guard: snapshots scroll position + text-field drafts and restores them after a recovery reload (only when the snapshot is <10 s old); warns when the renderer heap exceeds 80% of its limit (`logs/renderer-memory.log` + rate-limited native notification). Also enables precise `performance.memory` readings, without which Chromium freezes `usedJSHeapSize`. | **01** (uses its `appendFileSync` import) |

## Apply

```bash
git apply patches/01-desktop-renderer-recovery.patch
git apply patches/02-bounded-event-window.patch
git apply patches/03-desktop-ui-snapshot.patch   # requires 01
```

## Verify

```bash
# 1) Patches apply cleanly
git apply --check patches/01-desktop-renderer-recovery.patch
git apply --check patches/02-bounded-event-window.patch
git apply patches/01-desktop-renderer-recovery.patch
git apply --check patches/03-desktop-ui-snapshot.patch

# 2) Handler semantics (patch 01) — extracts the patched handler verbatim and drives it with stubs
node tests/handler-semantics.mjs

# 3) Bounded event window (patch 02) against a real 60,858-event session profile
node tests/verify-scrollback-scenario.cjs tests/session-profile.json
```

## Notes

- `03` is a module-based change on purpose: `ui-guard.ts` holds the injected script and the
  install function; `main.ts` only imports and calls it.
- The UI guard's heap watermark requires `--enable-precise-memory-info`
  (`app.commandLine.appendSwitch`), which patch 03 adds. Without it Electron reports a
  frozen `usedJSHeapSize` (measured: constant 10 MB), so the watermark could never fire.
- The UI restore only acts on fresh snapshots (<10 s) so a manual reload never resurrects
  stale state; it retries for up to 10 s because apps commonly auto-scroll to the bottom on load.
