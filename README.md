# DSH Renderer OOM Crash — Fix, Toolchain, and Test Suite

**English** | [中文版](README.zh-CN.md)

Resolves the problem where `Desktop renderer exited: oom` kills the entire desktop app, losing in-flight turns and background jobs.

> Status: **v6**, validated on dsh-desktop 0.2.1-rc.5 (Windows). Installed as a surgical `app.asar` patch; source patches for upstream are in [`patches/`](patches/).
>
> Discussion: [upstream](https://github.com/deepseek-ai/deepseek-harness/discussions/12149) · [this repo](https://github.com/ZhaoZehao10/dsh-phoenix/discussions/1)

**Start with [docs/INSTALL.md](docs/INSTALL.md)** — prerequisites, three-step setup, the test battery, and uninstall.

## What's inside

```
config/resolve.mjs      ← single source of paths (auto-detects the local install)
tooling/
  patch-asar.mjs        ← rebuilds the patched app.asar from your own install (base/boundary/hash self-checks)
  patch-asar-test.mjs   ← isolated test variant
  campaign/             ← test campaign: 100-round randomized fuzz + structure + official reference + semantics + truth table
  rebase/               ← upstream iteration: fetch master files, regenerate patches
  check-version-compat.mjs ← run this first after a DSH upgrade (anchor hit check)
scripts/
  install-patched.ps1   ← install (safety gates → backup → self-check → BOOTCHECK boot verification → auto-rollback)
  revert-asar.ps1       ← one-command restore
  check-dsh-sessions.ps1 / retire-dsh-session.ps1 / set-pagefile-cap.ps1  ← session & memory hygiene
patches/  tests/  docs/
```

## Three-minute sanity check

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node tooling\patch-asar.mjs
& $node tooling\campaign\test_handler_fuzz.mjs 100
& $node tooling\campaign\test_asar_reference.mjs
```

All three green ⟹ the patch works on your machine too.

## Design highlights (details in [docs/diagnosis.md](docs/diagnosis.md))

1. **Recovery** — renderer death (`oom` / `crashed` / `killed`) → reload the page after 250 ms; at most 2 reloads per rolling 60 s window (time-reset budget: isolated incidents do not consume each other's budget, a tight crash loop still escalates). Every recovery is appended to `logs/renderer-recovery.log`; crash reports gain a `--- memory snapshot (P-282) ---` section (main process / system / last-known renderer heartbeat).
2. **Root cause** — the resident event window grows without bound ⟹ byte budget + tail retention (measured peak 164.25 → 47.89 MB).
3. **Attribution method** — `reason:'oom'` covers three different failures (V8 heap exhaustion / process-level accounting / real OS pressure); the discriminator is the Windows Resource-Exhaustion-Detector commit events plus the renderer's own watermark — not "how much free memory is left".

## Upstream contribution

The two source patches in [`patches/`](patches/) apply cleanly to upstream `master` (`git apply --check` verified). Upstream contribution is pending maintainer feedback; background and evidence are in [docs/diagnosis.md](docs/diagnosis.md).
