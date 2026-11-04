/**
 * Renderer OOM self-healing — reference implementation.
 *
 * PROBLEM (observed in shipped 0.2.1-rc.2):
 *
 *   window.webContents.on("render-process-gone", (_event, details) => {
 *     navigation = undefined;
 *     if (!quitting && !window.isDestroyed() && details.reason !== "clean-exit")
 *       reportFatal(new Error(`Desktop renderer exited: ${details.reason}`), "renderer");
 *   });
 *
 *   Every non-clean renderer exit — including `oom` — is promoted to a FATAL
 *   error: native dialog, stopped Host, user must click Restart. But the page
 *   is a pure view over a durable, append-only session log; a dead renderer is
 *   recoverable state, not a corrupt one. The session data is on disk and the
 *   Host is still healthy.
 *
 * WHY THIS IS SAFE:
 *
 *   - The renderer holds no authoritative state. `session.v4.jsonl.zstd` is the
 *     source of truth; the window is rebuilt by re-issuing the initial page
 *     request (`doOpen` -> tail page).
 *   - `navigation` is already reset to undefined on entry, which is exactly the
 *     state a fresh window load expects.
 *   - Reloading is the same operation the "Restart" button eventually performs,
 *     minus the teeardown of a healthy Host process.
 *
 * THE ONE THING THAT MUST NOT HAPPEN:
 *
 *   An unbounded reload loop. If the same session deterministically OOMs on
 *   load, reloading forever hides a real failure from the user. So we allow a
 *   small number of attempts per window, with a cooldown, and then fall through
 *   to the existing fatal path. That keeps today's diagnostic when recovery
 *   genuinely cannot work.
 */

/** How many renderer-OOM reloads one window gets before we escalate. */
export const MAX_OOM_RECOVERIES = 2

/** Delay before reloading, so recovery does not spin against a dying process. */
export const OOM_RECOVERY_DELAY_MS = 250

/** Renderer exit reasons that a page reload can repair. */
const RECOVERABLE_REASONS = new Set([
  'oom',      // renderer heap exhausted (the reported bug)
  'crashed',  // renderer crash with no dirty page state to preserve
  'killed',   // renderer killed by the OS under memory pressure
])

/**
 * Decide what to do when a renderer process exits.
 *
 * @param {object} input
 * @param {string} input.reason - Electron `details.reason`.
 * @param {boolean} input.quitting - whether application shutdown is in progress.
 * @param {boolean} input.windowDestroyed - whether the window is already gone.
 * @param {number} input.recoveriesUsed - reloads already spent by this window.
 * @param {number} [input.maxRecoveries] - override for tests.
 * @returns {{action:'ignore'}|{action:'reload', delayMs:number, attempt:number}|{action:'fatal', reason:string}}
 */
export function decideRendererExit(input) {
  const {
    reason,
    quitting,
    windowDestroyed,
    recoveriesUsed,
    maxRecoveries = MAX_OOM_RECOVERIES,
  } = input

  // Shutdown and teardown exits are expected; nothing to report.
  if (quitting || windowDestroyed) return { action: 'ignore' }
  if (reason === 'clean-exit') return { action: 'ignore' }

  // Recovery budget exhausted: hand the failure to the existing fatal path so
  // the user still gets a diagnostic and the recovery buttons.
  if (!RECOVERABLE_REASONS.has(reason)) return { action: 'fatal', reason }
  if (recoveriesUsed >= maxRecoveries) return { action: 'fatal', reason }

  return { action: 'reload', delayMs: OOM_RECOVERY_DELAY_MS, attempt: recoveriesUsed + 1 }
}

/**
 * Install self-healing on one window's webContents.
 *
 * This mirrors how the fix integrates into `createMainWindow`, with the
 * dependencies injected so the behaviour is unit-testable without Electron.
 *
 * @param {object} deps
 * @param {{ on(event:string, handler:Function):void }} deps.webContents
 * @param {{ reload():void, isDestroyed():boolean }} deps.window
 * @param {() => boolean} deps.isQuitting
 * @param {(error:Error) => void} deps.reportFatal
 * @param {() => void} [deps.onRecovered] - observer for tests/telemetry.
 * @param {number} [deps.maxRecoveries]
 * @returns {{ recoveriesUsed:number, clear():void }}
 */
export function installRendererRecovery(deps) {
  const {
    webContents,
    window: win,
    isQuitting,
    reportFatal,
    onRecovered,
    maxRecoveries = MAX_OOM_RECOVERIES,
  } = deps

  let recoveriesUsed = 0
  let timer = null
  let active = true

  const handler = (_event, details) => {
    if (!active) return

    const decision = decideRendererExit({
      reason: details?.reason ?? 'unknown',
      quitting: isQuitting(),
      windowDestroyed: win.isDestroyed(),
      recoveriesUsed,
      maxRecoveries,
    })

    if (decision.action === 'ignore') return
    if (decision.action === 'fatal') {
      reportFatal(
        new Error(`Desktop renderer exited: ${decision.reason}`),
        'renderer',
      )
      return
    }

    recoveriesUsed = decision.attempt
    console.warn(
      `dsh desktop: renderer exited (${details?.reason}); ` +
        `reloading page (recovery ${recoveriesUsed}/${maxRecoveries})`,
    )
    // Defer so a still-dying process is not asked to navigate synchronously.
    timer = setTimeout(() => {
      timer = null
      if (!active || win.isDestroyed() || isQuitting()) return
      try {
        win.reload()
        onRecovered?.()
      } catch (error) {
        reportFatal(error, 'renderer')
      }
    }, decision.delayMs)
  }

  webContents.on('render-process-gone', handler)

  return {
    get recoveriesUsed() {
      return recoveriesUsed
    },
    clear() {
      active = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
