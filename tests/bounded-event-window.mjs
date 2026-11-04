/**
 * Bounded resident event window — runnable reference implementation.
 *
 * Faithful analogue of
 * `packages/api/session-controller/src/client/contract/events.ts`
 * (class `MutableSessionEventSource`) with the memory bound added. Plain ESM so
 * it runs on the Node runtime bundled with DeepSeek Harness without a
 * TypeScript toolchain; `02-bounded-event-window.patch` applies the same change
 * to the typed source.
 *
 * Design constraints:
 *
 *  1. Eviction is the inverse of prepend. The window already models "history
 *     exists before me" through `hasMore`, so dropping head entries is a state
 *     the rest of the system already understands.
 *
 *  2. Evict from the HEAD only. The live tail is never touched: the running
 *     turn, Conversation assembly and Trajectory rows all read it.
 *
 *  3. Budget in BYTES, not entry count. Real sessions mix 83-byte `step/start`
 *     records with 405 KB `assistant/message` records; a count budget would be
 *     wrong by three orders of magnitude.
 *
 *  4. Hysteresis. Evicting one entry per append is O(n^2); trimming to a
 *     low-water mark in one pass keeps amortized cost O(1).
 *
 *  5. Protected tail. A fixed tail stays resident regardless of budget, so one
 *     pathological huge entry can never empty the window.
 *
 *  6. An evicting mutation publishes `replace`, never `append`/`prepend`.
 *     Consumers apply `change` as a delta against virtual row keys, ARIA
 *     indexes and height caches; a moved window head cannot be described by an
 *     incremental delta. `publish` centralises this so no path can forget it.
 */

/**
 * Default resident budget for the event window, in bytes of serialized events.
 */
export const RESIDENT_EVENT_BYTES = 48 * 1024 * 1024

/** Evict down to this fraction of the budget so trimming is amortized. */
export const EVICT_LOW_WATER_RATIO = 0.75

/**
 * Tail bytes that survive eviction even when the budget is exceeded.
 *
 * This is a BYTE floor, not an entry count. A count floor is unsound when entries
 * vary by three orders of magnitude (83-byte `step/start` vs 405 KB
 * `assistant/message`): protecting 512 *entries* can pin tens of megabytes and
 * silently blow the budget, while protecting 512 *bytes* is meaningless. A byte
 * floor keeps the guarantee "resident <= budget + tailBytes" true regardless of
 * entry size distribution, so a pathological message still cannot empty the window
 * while the bound stays meaningful.
 */
export const PROTECTED_TAIL_BYTES = 512 * 1024

export class BoundedSessionEventSource {
  /**
   * @param {object} [options]
   * @param {number} [options.budgetBytes] - resident byte budget; Infinity disables eviction.
   * @param {number} [options.lowWaterRatio] - evict down to this fraction.
   * @param {number} [options.tailBytes] - always-resident tail budget in bytes.
   * @param {(entry: unknown) => number} [options.measure] - byte cost of one entry.
   * @param {(change: unknown, snapshot: unknown) => void} [options.onPublish] - test observer.
   */
  constructor(options = {}) {
    this.budgetBytes = options.budgetBytes ?? RESIDENT_EVENT_BYTES
    this.lowWaterRatio = options.lowWaterRatio ?? EVICT_LOW_WATER_RATIO
    this.tailBytes = options.tailBytes ?? PROTECTED_TAIL_BYTES
    this.measure = options.measure ?? defaultMeasure
    this.onPublish = options.onPublish ?? null

    /** Resident entries, oldest first. */
    this.entries = []
    /** Serialized byte cost of `entries`. */
    this.bytes = 0
    /** Whether history exists before `entries[0]` (never loaded, or evicted). */
    this.hasMore = false
    /** Lowest seq eviction has dropped below; null until the first trim. */
    this.evictedBeforeSeq = null
    /** Cumulative entries dropped by eviction. */
    this.evictedEntries = 0
    /** Peak resident bytes observed, for reporting. */
    this.peakBytes = 0
    /** Latest published delta and snapshot, for verification. */
    this.lastChange = { kind: 'replace', entries: [] }
    this.revision = 0
    /** Latched by #enforceBudget, consumed by #publish. */
    this.evicted = false
    /**
     * Whether this window has ever evicted. Once true, `hasMore` stays true for the
     * window's lifetime: dropped entries remain on the Host log and must stay
     * reachable, even after a caller reports that the log itself has no older pages.
     */
    this.hasEvicted = false
  }

  // ---- Window mutations (upstream contract) ----

  replace(entries, hasMore) {
    this.entries = entries.slice()
    this.bytes = this.entries.reduce((sum, entry) => sum + this.measure(entry), 0)
    this.hasMore = hasMore
    this.evictedBeforeSeq = null
    this.evictedEntries = 0
    // A replacement installs a fresh window: previous eviction history is gone.
    this.hasEvicted = false
    this.#trackPeak()
    this.#enforceBudget()
    this.#publish(hasMore, { kind: 'replace', entries })
  }

  prepend(entries, hasMore) {
    for (const entry of entries) this.bytes += this.measure(entry)
    this.entries = entries.concat(this.entries)
    this.#trackPeak()
    this.#enforceBudget()
    // `hasMore` is decided in #publish so eviction cannot be erased by the caller.
    this.#publish(hasMore, { kind: 'prepend', entries })
  }

  append(entry) {
    this.bytes += this.measure(entry)
    this.entries.push(entry)
    this.#trackPeak()
    this.#enforceBudget()
    // Forward the previously published hasMore; #publish keeps it true if evicted.
    this.#publish(this.hasMore, { kind: 'append', entries: [entry] })
  }

  // ---- Observation ----

  /**
   * Oldest resident seq, or null when the window is empty or the head entry
   * carries no seq.
   *
   * The leading `session` header event has no seq, so absence must be reported as
   * null rather than leaking `undefined` to callers that compare numerically.
   */
  headSeq() {
    if (this.entries.length === 0) return null
    return this.entries[0].event.seq ?? null
  }

  /** Newest resident seq, or null when the window is empty or the tail has no seq. */
  tailSeq() {
    if (this.entries.length === 0) return null
    return this.entries[this.entries.length - 1].event.seq ?? null
  }

  /** Number of resident entries. */
  get entryCount() {
    return this.entries.length
  }

  // ---- Internals ----

  #trackPeak() {
    if (this.bytes > this.peakBytes) this.peakBytes = this.bytes
  }

  /**
   * Drop head entries until the window fits the low-water mark.
   *
   * Two floors constrain how far the head may advance:
   *
   *   - the byte low-water mark (why we trim at all), and
   *   - `tailBytes`, an always-resident tail measured in BYTES.
   *
   * The second floor is what makes the memory bound sound: with a byte floor, the
   * worst case is `budget + tailBytes` no matter how entry sizes are distributed.
   * A count floor would instead pin whatever the largest entries happen to weigh.
   *
   * At least one entry always survives, so a single oversized message can never
   * empty the window; the bound then becomes that entry's size.
   */
  #enforceBudget() {
    if (!Number.isFinite(this.budgetBytes)) return
    if (this.bytes <= this.budgetBytes) return

    const lowWater = Math.floor(this.budgetBytes * this.lowWaterRatio)
    const total = this.entries.length

    // Choose the furthest head advance that still honours both floors:
    //   - after dropping, the remainder must fit the low-water mark (why we trim), and
    //   - the remainder must stay at or above the protected tail floor in bytes.
    // At least one entry always survives.
    let drop = 0
    let freed = 0
    while (drop < total - 1) {
      const cost = this.measure(this.entries[drop])
      const remainingBytes = this.bytes - freed
      // Stop if trimming further would breach the protected tail byte floor...
      if (remainingBytes - cost < this.tailBytes) break
      freed += cost
      drop += 1
      // ...or if the remainder already fits the low-water mark.
      if (this.bytes - freed <= lowWater) break
    }

    if (drop === 0) return

    // The dropped prefix may end with a seq-less header; fall back to the last
    // seq actually seen so the watermark never becomes NaN.
    let watermark = null
    for (let i = drop - 1; i >= 0; i--) {
      const seq = this.entries[i].event.seq
      if (typeof seq === 'number') {
        watermark = seq + 1
        break
      }
    }
    if (watermark !== null) this.evictedBeforeSeq = watermark

    this.entries = this.entries.slice(drop)
    this.bytes -= freed
    this.evictedEntries += drop
    this.evicted = true
  }

  #publish(hasMore, change) {
    const pending = this.evicted
    this.evicted = false
    // Any eviction in this window's lifetime keeps hasMore true: the dropped
    // region is still on the Host, and a caller passing `false` (because the
    // log itself has no older pages) must not erase that.
    if (pending) this.hasEvicted = true
    this.revision += 1
    if (pending) {
      this.hasMore = true
      this.lastChange = { kind: 'replace', entries: this.entries }
    } else {
      this.hasMore = hasMore || this.hasEvicted
      this.lastChange = change
    }
    this.onPublish?.(this.lastChange, {
      entries: this.entries,
      hasMore: this.hasMore,
      revision: this.revision,
    })
  }
}

/**
 * Default byte cost of one window entry.
 *
 * Upstream entries are `{type:'event', event}` wrappers. The serialized size of
 * the payload tracks retained heap closely enough for budgeting and is stable to
 * measure. Memoized because the same entry object is re-measured on every trim.
 */
export function defaultMeasure(entry) {
  if (entry.__bytes !== undefined) return entry.__bytes
  const payload = entry.event ?? entry
  entry.__bytes = JSON.stringify(payload).length
  return entry.__bytes
}
