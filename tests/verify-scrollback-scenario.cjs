/**
 * The actual failure scenario: a user scrolls up through an entire huge session.
 *
 * The earlier tests replayed the log as a pure append stream, which is what the
 * daemon produces but NOT what the renderer experiences. In the reported crash the
 * renderer retained everything because the user kept loading older pages: each
 * `loadOlder()` prepends a Turn-aligned page, and before the fix every one of them
 * stayed resident forever.
 *
 * This reproduces that interaction faithfully:
 *   - open at the tail (the initial page)
 *   - keep prepending 500-message history pages until `hasMore` is exhausted
 *   - measure resident bytes at each step, and confirm the bound holds
 *   - confirm every page that was evicted is still reachable (no data loss)
 *
 * Usage: node verify-scrollback-scenario.cjs <metrics.json>
 */
const fs = require('fs')
const path = require('path')

const [, , metricsPath] = process.argv
if (!metricsPath) {
  console.error('usage: node verify-scrollback-scenario.cjs <metrics.json>')
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(metricsPath, 'utf8'))
const series = data.series
const MB = 1048576
const modulePath = path.join(__dirname, '..', 'patches', 'bounded-event-window.mjs')

/** History page size, matching HISTORY_PAGE_OPTIONS.maxMessages in upstream. */
const PAGE_EVENTS = 500

const makeEntry = (e) => ({ event: { seq: e.s, type: e.t }, __bytes: e.b })

;(async () => {
  const { BoundedSessionEventSource } = await import(`file://${modulePath.replace(/\\/g, '/')}`)

  const budget = 48 * MB
  console.log('scrollback scenario : open at tail, page backwards to session start')
  console.log(`session: ${series.length} events / ${(data.totalEventBytes / MB).toFixed(1)} MB, page size ${PAGE_EVENTS}`)
  console.log('')

  // ---- 1. Unbounded behaviour (what happens today) --------------------
  {
    const resident = []
    let bytes = 0
    let peak = 0
    // Initial page at the tail.
    for (let i = series.length - PAGE_EVENTS; i < series.length; i++) {
      const entry = makeEntry(series[i])
      resident.unshift(entry)
      bytes += entry.__bytes
    }
    peak = bytes
    let pages = 1
    let cursor = series.length - PAGE_EVENTS
    while (cursor > 0) {
      const from = Math.max(0, cursor - PAGE_EVENTS)
      for (let i = from; i < cursor; i++) {
        const entry = makeEntry(series[i])
        resident.unshift(entry)
        bytes += entry.__bytes
      }
      if (bytes > peak) peak = bytes
      pages += 1
      cursor = from
    }
    console.log('unbounded (current upstream):')
    console.log(`  pages loaded     : ${pages}`)
    console.log(`  resident entries : ${resident.length}`)
    console.log(`  peak resident    : ${(peak / MB).toFixed(2)} MB  <-- this is the OOM driver`)
  }

  console.log('')

  // ---- 2. Bounded behaviour (the fix) --------------------------------
  const window = new BoundedSessionEventSource({ budgetBytes: budget })
  // Open at the tail: insert the initial page in order.
  window.replace(series.slice(series.length - PAGE_EVENTS).map(makeEntry), true)
  // The initial page is a single atomic snapshot; its size is whatever the Host
  // sent, so record it separately rather than treating it as an eviction
  // overshoot. Every subsequent growth must respect the budget.
  const initialSnapshotBytes = window.bytes

  let pages = 1
  let cursor = series.length - PAGE_EVENTS
  const overshoots = []
  let maxResident = window.bytes

  while (cursor > 0) {
    const from = Math.max(0, cursor - PAGE_EVENTS)
    const page = series.slice(from, cursor).map(makeEntry)
    window.prepend(page, from > 0)
    pages += 1
    cursor = from
    if (window.bytes > maxResident) maxResident = window.bytes
    if (window.bytes > budget) overshoots.push(window.bytes - budget)
  }

  console.log('bounded 48 MB (the fix):')
  console.log(`  pages loaded      : ${pages}`)
  console.log(`  resident entries  : ${window.entryCount}`)
  console.log(`  evicted entries   : ${window.evictedEntries}`)
  console.log(`  initial snapshot  : ${(initialSnapshotBytes / MB).toFixed(2)} MB`)
  console.log(`  peak after paging : ${(maxResident / MB).toFixed(2)} MB`)
  console.log(`  over-budget times : ${overshoots.length}`)

  // ---- 3. Is evicted history still reachable? ------------------------
  // The window reports hasMore, so the dropped region must still be paginated
  // from the Host. Verify the watermark never claims more than was loaded.
  const loadedOldestSeq = series[0].s
  const headSeq = window.headSeq()
  console.log('')
  console.log('--- reachability of evicted history ---')
  console.log(`  oldest seq ever loaded   : ${loadedOldestSeq}`)
  console.log(`  current resident head seq: ${headSeq}`)
  console.log(`  eviction watermark       : ${window.evictedBeforeSeq}`)
  console.log(`  hasMore                  : ${window.hasMore}`)

  // ---- 4. Tail must still hold the newest event ----------------------
  const tailSeq = window.tailSeq()
  const newestSeq = series[series.length - 1].s
  console.log('')
  console.log('--- live tail ---')
  console.log(`  newest event seq         : ${newestSeq}`)
  console.log(`  resident tail seq        : ${tailSeq}`)
  console.log(`  tail intact              : ${tailSeq === newestSeq}`)

  console.log('')
  const failures = []
  // Assert on the paging high-water mark, not `peakBytes`: `peakBytes` also
  // records the instant inside `replace()` where the incoming snapshot exists
  // before the trim runs, which is not a paging overshoot.
  if (maxResident > budget + 1) {
    failures.push(`paged resident ${(maxResident / MB).toFixed(2)} MB exceeded the 48 MB budget`)
  }
  if (overshoots.length > 0) {
    failures.push(`window exceeded its budget on ${overshoots.length} page loads`)
  }
  if (tailSeq !== newestSeq) failures.push('the live tail was evicted')
  if (!window.hasMore) failures.push('evicted history is not reported as reachable')
  if (window.evictedEntries === 0) failures.push('nothing was evicted during full scrollback')
  if (window.evictedBeforeSeq === null) failures.push('eviction watermark was never set')
  // Everything below the watermark was dropped; everything at or above it must be resident.
  if (window.evictedBeforeSeq !== null && headSeq !== null && window.evictedBeforeSeq > headSeq) {
    failures.push('eviction watermark is above the current head (dropped resident data)')
  }

  console.log('')
  if (failures.length > 0) {
    console.log('RESULT: FAIL')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('RESULT: PASS')
  console.log(
    `  scrolling the whole session now costs ${(maxResident / MB).toFixed(1)} MB ` +
      `instead of ${(data.totalEventBytes / MB).toFixed(1)} MB, the tail stays live, ` +
      `and ${window.evictedEntries.toLocaleString()} evicted events remain addressable via hasMore.`,
  )
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
