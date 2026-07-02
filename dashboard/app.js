/* Clinic Dashboard — pure static, no build step, no dependencies, no network.
   Works from file:// (double-clicked) or any static host.

   ==========================================================================
   Schema assumptions (see dashboard/README.md and the parent report for the
   source files these were read from):

   Session export (one iPad, one file) — app/src/utils/sessions.js:
     { exportedAt: "<ISO>", sessions: [{
         id: "s<epoch-ms>", at: "<ISO>", firstName, ageRange, goal, aesthetic,
         units: { <zoneId>: <mL number>, ... }, totalMl,
         thumbBefore: "<data URL or null>", thumbAfter: "<data URL or null>",
     }] }
   - `goal` is usually one of the ids 'first' | 'refresh' | 'exploring'
     (app/src/screens/IntakeScreen.jsx CONSULT_GOALS), mapped to English via
     GOAL_LABELS below (mirrors app/src/i18n/strings.js `goals.*`, English
     locale). Older exports (and the archived Expo app under old/) stored the
     goal as free English text instead — unknown strings are passed through
     as-is rather than replaced, so old data still reads fine.
   - `aesthetic` is one of 'feminine' | 'balanced' | 'masculine'
     (app/src/engine/mdPoints.js AESTHETIC_STYLES), defaulting to 'balanced'
     when absent, matching the on-device save default.
   - `ageRange` is one of '18-24' | '25-34' | '35-44' | '45-54' | '55+'
     (app/src/screens/IntakeScreen.jsx AGE_RANGES); anything else buckets as
     "Unknown" in the distribution chart rather than being dropped.
   - Zone ids/labels mirror app/src/engine/zones.js (read-only source of
     truth): lips, cheeks, chin, jawline, tearTrough, nasolabial. A units key
     this dashboard doesn't recognize still renders (falls back to the raw
     id) instead of being dropped, in case the zone list grows later.
   - `id` is the only field this dashboard treats as required — it's the
     dedupe key across files (multi-iPad aggregation). A record missing an
     id is skipped as malformed; every other field degrades gracefully
     (missing/invalid -> a safe default) rather than rejecting the record.

   Engine-params export (one file, one-shot download, no importer in the
   dataset tool itself) — app/src/dataset/lib/fitting.js buildEngineParamsExport
   + app/src/dataset/components/FittingPanel.jsx "Download engine params":
     { version: 1, fittedAt: "<ISO>", zones: {
         <zoneId>: { k: number|null, p: number, n: number, rmse: number|null,
                      mode: "curve" | "scalar" } } }
   - "scalar" mode (p pinned to 1): k IS directly comparable to 1.0 — it's a
     least-squares gain fit against the *current* engine's own predicted
     field, so k=1 means "the engine's current calibration already matches
     these clinical outcomes for this zone" (see docs/DATASET_PIPELINE.md
     §3.4). This is what the task's example interpretation ("k<1: engine
     over-predicts") describes.
   - "curve" mode (>=3 distinct treated mL doses): mean|displacement| = k *
     mL^p is fit purely from clinical measurements in log-log space, with NO
     engine call in the fit — k and p are an *absolute* empirical
     dose-response, not a multiplier on the current calibration. k=1 has no
     special meaning here; instead the interpretation focuses on p (the
     shape of the dose-response: sub-linear/linear/super-linear).
   ========================================================================== */

'use strict'

/* ------------------------------------------------------------------------
   Constants — mirrors of the product's own source-of-truth files (kept as
   plain data so this tool never has to import React/app code).
   ------------------------------------------------------------------------ */

var ZONES = [
  { id: 'lips', label: 'Lips' },
  { id: 'cheeks', label: 'Cheeks' },
  { id: 'chin', label: 'Chin' },
  { id: 'jawline', label: 'Jawline' },
  { id: 'tearTrough', label: 'Under-eye' },
  { id: 'nasolabial', label: 'Smile lines' },
]
var ZONE_ORDER = ZONES.map(function (z) { return z.id })

var GOAL_LABELS = {
  first: 'First-time consultation',
  refresh: 'Refresh previous treatment',
  exploring: 'Exploring options',
}

var AESTHETIC_LABELS = { feminine: 'Feminine', balanced: 'Balanced', masculine: 'Masculine' }
var AESTHETIC_ORDER = ['feminine', 'balanced', 'masculine']

var AGE_RANGES = ['18-24', '25-34', '35-44', '45-54', '55+']

// Same tolerance the dataset tool's own round-trip check uses (see
// app/src/dataset/lib/fitting.js: ROUND_TRIP_TOLERANCE) — reused here so
// "close enough to 1" means the same thing in both tools.
var FIT_TOLERANCE = 0.15

var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* ------------------------------------------------------------------------
   Small generic helpers
   ------------------------------------------------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function toFiniteNumber(v, fallback) {
  var n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function zoneLabel(id) {
  for (var i = 0; i < ZONES.length; i++) {
    if (ZONES[i].id === id) return ZONES[i].label
  }
  return id
}

function goalLabel(goal) {
  if (typeof goal !== 'string' || !goal.trim()) return 'Not set'
  return GOAL_LABELS[goal] || goal
}

function aestheticLabel(aesthetic) {
  if (typeof aesthetic !== 'string' || !aesthetic.trim()) return AESTHETIC_LABELS.balanced
  return AESTHETIC_LABELS[aesthetic] || aesthetic
}

// UTC-based on purpose: `at` is always a UTC ISO string (Date#toISOString
// from the device), and bucketing in UTC keeps chart grouping stable
// regardless of which timezone the dashboard happens to be opened in.
function formatWeekLabel(weekStartIso) {
  var d = new Date(weekStartIso + 'T00:00:00Z')
  if (isNaN(d.getTime())) return weekStartIso
  return MONTH_ABBR[d.getUTCMonth()] + ' ' + d.getUTCDate()
}

function formatDateShort(iso) {
  var d = new Date(iso)
  if (!iso || isNaN(d.getTime())) return '--'
  return MONTH_ABBR[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear()
}

// Local wall-clock on purpose (unlike the UTC bucketing above): this is for
// a human glancing at the sessions table, most useful in whatever timezone
// they're actually sitting in.
function formatDateTime(iso) {
  var d = new Date(iso)
  if (!iso || isNaN(d.getTime())) return 'Unknown date'
  var h = d.getHours()
  var ampm = h >= 12 ? 'PM' : 'AM'
  var h12 = h % 12 === 0 ? 12 : h % 12
  return (
    MONTH_ABBR[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' + h12 + ':' + pad2(d.getMinutes()) + ' ' + ampm
  )
}

/* ------------------------------------------------------------------------
   Session normalization + parsing
   ------------------------------------------------------------------------ */

// Normalizes one raw session record. Only a missing/empty "id" is treated
// as fatal (dedupe needs it) — every other field falls back to a safe
// default rather than rejecting the whole record, per the "skip bad
// records, don't nuke the file" requirement.
function normalizeSession(raw, index) {
  if (!isPlainObject(raw)) {
    return { record: null, error: 'record ' + index + ': not an object' }
  }

  var id = raw.id
  if (typeof id === 'number') id = String(id)
  if (typeof id !== 'string' || !id.trim()) {
    return { record: null, error: 'record ' + index + ': missing "id"' }
  }

  var atDate = typeof raw.at === 'string' ? new Date(raw.at) : null
  var atValid = !!atDate && !isNaN(atDate.getTime())

  var rawUnits = isPlainObject(raw.units) ? raw.units : {}
  var units = {}
  var summedMl = 0
  Object.keys(rawUnits).forEach(function (zoneId) {
    var ml = toFiniteNumber(rawUnits[zoneId], null)
    if (ml === null || ml <= 0) return
    units[zoneId] = ml
    summedMl += ml
  })

  var totalMl = toFiniteNumber(raw.totalMl, null)
  if (totalMl === null) totalMl = summedMl

  var record = {
    id: id,
    at: atValid ? atDate.toISOString() : null,
    firstName: typeof raw.firstName === 'string' ? raw.firstName : '',
    ageRange: typeof raw.ageRange === 'string' ? raw.ageRange : '',
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    aesthetic: typeof raw.aesthetic === 'string' && raw.aesthetic ? raw.aesthetic : 'balanced',
    units: units,
    totalMl: Number(totalMl.toFixed(2)),
    thumbBefore: typeof raw.thumbBefore === 'string' ? raw.thumbBefore : null,
    thumbAfter: typeof raw.thumbAfter === 'string' ? raw.thumbAfter : null,
  }
  return { record: record, error: null }
}

// Parses one dropped file's text as a session export. Tolerates a bare
// array of sessions too (not just the documented {exportedAt, sessions}
// envelope), since that's a cheap, harmless extra to support.
function parseSessionsExportJSON(text) {
  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: 'Not valid JSON.' }
  }

  var sessionsRaw = null
  var exportedAt = null
  if (Array.isArray(parsed)) {
    sessionsRaw = parsed
  } else if (isPlainObject(parsed) && Array.isArray(parsed.sessions)) {
    sessionsRaw = parsed.sessions
    exportedAt = typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null
  } else if (isPlainObject(parsed) && isPlainObject(parsed.zones)) {
    return { ok: false, error: 'This looks like an engine-params file, not a session export — drop it in the Fitted-params viewer section below.' }
  } else {
    return { ok: false, error: 'Does not look like a session export (expected a "sessions" array).' }
  }

  var records = []
  var errors = []
  sessionsRaw.forEach(function (raw, i) {
    var res = normalizeSession(raw, i)
    if (res.record) records.push(res.record)
    else errors.push(res.error)
  })

  return {
    ok: true,
    exportedAt: exportedAt,
    records: records,
    total: sessionsRaw.length,
    skipped: errors.length,
    skippedReasons: errors,
  }
}

// Merges a freshly-parsed batch into the running in-memory list, deduping
// by session id (the only cross-device collision risk is the same file, or
// overlapping export ranges from the same device, being dropped twice).
function mergeSessionRecords(existingRecords, incomingRecords) {
  var seen = {}
  existingRecords.forEach(function (r) { seen[r.id] = true })
  var merged = existingRecords.slice()
  var added = 0
  var duplicates = 0
  incomingRecords.forEach(function (r) {
    if (seen[r.id]) {
      duplicates++
      return
    }
    seen[r.id] = true
    merged.push(r)
    added++
  })
  return { merged: merged, added: added, duplicates: duplicates }
}

/* ------------------------------------------------------------------------
   Aggregation (overview cards + charts) — all pure functions of the
   normalized record list, sanity-run under Node (see the module.exports
   guard at the bottom).
   ------------------------------------------------------------------------ */

function computeOverview(records) {
  var count = records.length
  var totalMl = 0
  var captured = 0
  var minAt = null
  var maxAt = null

  records.forEach(function (r) {
    totalMl += toFiniteNumber(r.totalMl, 0)
    if (r.thumbBefore || r.thumbAfter) captured++
    if (r.at) {
      // ISO 8601 UTC strings sort correctly as plain strings.
      if (minAt === null || r.at < minAt) minAt = r.at
      if (maxAt === null || r.at > maxAt) maxAt = r.at
    }
  })

  return {
    count: count,
    totalMl: Number(totalMl.toFixed(1)),
    avgMl: count ? Number((totalMl / count).toFixed(2)) : 0,
    captureRate: count ? captured / count : 0,
    dateRange: { start: minAt, end: maxAt },
  }
}

function weekStartISO(isoString) {
  var d = new Date(isoString)
  if (isNaN(d.getTime())) return null
  var utcDay = d.getUTCDay() // 0=Sun..6=Sat
  var mondayOffset = (utcDay + 6) % 7 // days since the most recent Monday
  var monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset))
  return monday.toISOString().slice(0, 10)
}

function consultationsPerWeek(records) {
  var counts = {}
  records.forEach(function (r) {
    if (!r.at) return
    var wk = weekStartISO(r.at)
    if (!wk) return
    counts[wk] = (counts[wk] || 0) + 1
  })
  return Object.keys(counts)
    .sort()
    .map(function (wk) { return { weekStart: wk, count: counts[wk] } })
}

function zonePopularity(records) {
  var totals = {}
  ZONE_ORDER.forEach(function (id) { totals[id] = 0 })
  records.forEach(function (r) {
    Object.keys(r.units || {}).forEach(function (zoneId) {
      var ml = toFiniteNumber(r.units[zoneId], 0)
      if (!(zoneId in totals)) totals[zoneId] = 0 // unknown zone id — still counted, still shown
      totals[zoneId] += ml
    })
  })
  return Object.keys(totals)
    .map(function (id) { return { zoneId: id, label: zoneLabel(id), totalMl: Number(totals[id].toFixed(2)) } })
    .sort(function (a, b) { return b.totalMl - a.totalMl })
}

// Buckets by the exact aesthetic id; anything present but unrecognized
// (not one of feminine/balanced/masculine) lands in "Other" rather than
// being silently folded into balanced, so odd data is visible, not hidden.
function aestheticSplit(records) {
  var counts = { feminine: 0, balanced: 0, masculine: 0, other: 0 }
  records.forEach(function (r) {
    var key = AESTHETIC_ORDER.indexOf(r.aesthetic) === -1 ? 'other' : r.aesthetic
    counts[key]++
  })
  var out = AESTHETIC_ORDER.map(function (id) {
    return { id: id, label: AESTHETIC_LABELS[id], count: counts[id] }
  })
  if (counts.other > 0) out.push({ id: 'other', label: 'Other', count: counts.other })
  return out
}

function ageDistribution(records) {
  var counts = {}
  AGE_RANGES.forEach(function (r) { counts[r] = 0 })
  var unknown = 0
  records.forEach(function (r) {
    if (AGE_RANGES.indexOf(r.ageRange) === -1) {
      unknown++
    } else {
      counts[r.ageRange]++
    }
  })
  var out = AGE_RANGES.map(function (r) { return { range: r, count: counts[r] } })
  if (unknown > 0) out.push({ range: 'Unknown', count: unknown })
  return out
}

function filterAndSortSessions(records, opts) {
  opts = opts || {}
  var query = (opts.query || '').trim().toLowerCase()
  var sortKey = opts.sortKey === 'totalMl' ? 'totalMl' : 'at'
  var dir = opts.sortDir === 'asc' ? 1 : -1

  var filtered = query
    ? records.filter(function (r) { return (r.firstName || '').toLowerCase().indexOf(query) !== -1 })
    : records.slice()

  filtered.sort(function (a, b) {
    var av = sortKey === 'totalMl' ? a.totalMl : a.at || ''
    var bv = sortKey === 'totalMl' ? b.totalMl : b.at || ''
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return 0
  })
  return filtered
}

function buildMergedSessionsExport(records) {
  return { exportedAt: new Date().toISOString(), sessions: records }
}

/* ------------------------------------------------------------------------
   Engine-params (fitted-params viewer)
   ------------------------------------------------------------------------ */

function parseEngineParamsJSON(text) {
  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: 'Not valid JSON.' }
  }
  if (Array.isArray(parsed) || (isPlainObject(parsed) && Array.isArray(parsed.sessions))) {
    return { ok: false, error: 'This looks like a session export, not engine params — drop it in the Session exports section above.' }
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.zones)) {
    return { ok: false, error: 'Does not look like an engine-params export (expected a "zones" object).' }
  }

  var rows = []
  var skipped = []
  Object.keys(parsed.zones).forEach(function (zoneId) {
    var z = parsed.zones[zoneId]
    if (!isPlainObject(z)) {
      skipped.push(zoneId)
      return
    }
    var k = typeof z.k === 'number' && Number.isFinite(z.k) ? z.k : null
    var p = typeof z.p === 'number' && Number.isFinite(z.p) ? z.p : null
    var n = typeof z.n === 'number' && Number.isFinite(z.n) ? z.n : null
    var rmse = typeof z.rmse === 'number' && Number.isFinite(z.rmse) ? z.rmse : null
    var mode = typeof z.mode === 'string' ? z.mode : 'unknown'
    var fit = { zone: zoneId, k: k, p: p, n: n, rmse: rmse, mode: mode }
    rows.push({
      zone: zoneId,
      label: zoneLabel(zoneId),
      k: k,
      p: p,
      n: n,
      rmse: rmse,
      mode: mode,
      interpretation: interpretZoneFit(fit),
    })
  })

  return {
    ok: true,
    version: typeof parsed.version === 'number' ? parsed.version : null,
    fittedAt: typeof parsed.fittedAt === 'string' ? parsed.fittedAt : null,
    rows: rows,
    skipped: skipped,
  }
}

// One-line, per-zone interpretation. Mode-aware because scalar-mode k and
// curve-mode k live on genuinely different scales (see the schema-notes
// comment at the top of this file) — treating them the same would produce
// confidently wrong advice.
function interpretZoneFit(fit) {
  var k = fit.k
  var p = fit.p
  var n = fit.n
  var mode = fit.mode
  var caveat = typeof n === 'number' && n < 3 ? ' Based on very few sessions (n=' + n + ') - treat as provisional.' : ''

  if (mode === 'scalar') {
    if (k === null) return 'No usable gain could be fit for this zone yet.' + caveat
    if (k < 1 - FIT_TOLERANCE) {
      return 'k<1 (' + k.toFixed(3) + '): engine over-predicts this zone; consider lowering zone gain toward ~' + k.toFixed(2) + 'x.' + caveat
    }
    if (k > 1 + FIT_TOLERANCE) {
      return 'k>1 (' + k.toFixed(3) + '): engine under-predicts this zone; consider raising zone gain toward ~' + k.toFixed(2) + 'x.' + caveat
    }
    return "k~1 (" + k.toFixed(3) + "): engine's current gain already matches measured outcomes for this zone (p fixed at 1 - not enough dose variety yet for an independent curve)." + caveat
  }

  if (mode === 'curve') {
    if (p === null) return 'Curve fit is missing "p" - cannot interpret shape.' + caveat
    var kNote =
      k === null
        ? ''
        : " k=" + k.toFixed(4) + " is this zone's empirical scale at 1 mL, fit directly from clinical data - independent of the current engine calibration (not a \"k=1 is correct\" multiplier the way scalar mode is)."
    if (p < 1 - FIT_TOLERANCE) {
      return "p<1 (" + p.toFixed(2) + "): response grows sub-linearly with dose - diminishing returns at higher mL; consider softening this zone's high-dose gain." + kNote + caveat
    }
    if (p > 1 + FIT_TOLERANCE) {
      return 'p>1 (' + p.toFixed(2) + '): response grows super-linearly with dose - small increases matter more at higher mL than the engine currently assumes.' + kNote + caveat
    }
    return "p~1 (" + p.toFixed(2) + "): dose-response is roughly linear, matching the engine's linear dose assumption." + kNote + caveat
  }

  return 'Unrecognized fit mode "' + mode + '" - showing raw values only.' + caveat
}

/* ------------------------------------------------------------------------
   Node sanity-run hook. Harmless in the browser: `module` is undefined
   there, so this whole block is skipped. In Node, `require('./app.js')`
   gets the pure-logic functions above without pulling in any DOM code.
   ------------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ZONES: ZONES,
    GOAL_LABELS: GOAL_LABELS,
    AESTHETIC_LABELS: AESTHETIC_LABELS,
    AGE_RANGES: AGE_RANGES,
    zoneLabel: zoneLabel,
    goalLabel: goalLabel,
    aestheticLabel: aestheticLabel,
    formatWeekLabel: formatWeekLabel,
    formatDateShort: formatDateShort,
    formatDateTime: formatDateTime,
    normalizeSession: normalizeSession,
    parseSessionsExportJSON: parseSessionsExportJSON,
    mergeSessionRecords: mergeSessionRecords,
    computeOverview: computeOverview,
    weekStartISO: weekStartISO,
    consultationsPerWeek: consultationsPerWeek,
    zonePopularity: zonePopularity,
    aestheticSplit: aestheticSplit,
    ageDistribution: ageDistribution,
    filterAndSortSessions: filterAndSortSessions,
    buildMergedSessionsExport: buildMergedSessionsExport,
    parseEngineParamsJSON: parseEngineParamsJSON,
    interpretZoneFit: interpretZoneFit,
  }
}

/* ==========================================================================
   UI layer — DOM wiring + hand-rolled canvas charts. Skipped entirely
   outside a browser (guarded so `require`-ing this file under Node for the
   sanity checks above never touches `document`).
   ========================================================================== */
;(function () {
  if (typeof document === 'undefined') return

  var FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
  var COLOR_ACCENT = '#50e3c2'
  var COLOR_GRID = 'rgba(255,255,255,0.08)'
  var COLOR_TEXT_MUTED = '#a7b1b6'
  var COLOR_TEXT_FAINT = '#77828a'
  // feminine / balanced / masculine / other — kept in sync with styles.css
  var DONUT_COLORS = ['#50e3c2', '#7fb2e0', '#e0a15c', '#8a8f98']

  var state = {
    sessions: [],
    fileCount: 0,
    importLog: [],
    sort: { key: 'at', dir: 'desc' },
    query: '',
    engineParams: null,
    paramsError: null,
  }

  function $(sel) {
    return document.querySelector(sel)
  }

  function onActivate(el, handler) {
    el.addEventListener('click', handler)
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handler(e)
      }
    })
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () { resolve(String(reader.result)) }
      reader.onerror = function () { reject(new Error('Could not read file.')) }
      reader.readAsText(file)
    })
  }

  function downloadJSON(payload, filename) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function todayStamp() {
    var d = new Date()
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  }

  /* ---------------------------------------------------------------------
     Import handling
     --------------------------------------------------------------------- */

  function handleSessionFiles(files) {
    var list = Array.prototype.slice.call(files)
    if (!list.length) return
    Promise.all(
      list.map(function (file) {
        return readFileAsText(file)
          .then(function (text) { return { file: file, result: parseSessionsExportJSON(text) } })
          .catch(function (err) { return { file: file, result: { ok: false, error: err.message || 'Could not read file.' } } })
      })
    ).then(function (outcomes) {
      outcomes.forEach(function (outcome) {
        var name = outcome.file.name
        var result = outcome.result
        if (!result.ok) {
          state.importLog.unshift({ name: name, kind: 'error', message: result.error })
          return
        }
        var merge = mergeSessionRecords(state.sessions, result.records)
        state.sessions = merge.merged
        state.fileCount++
        var bits = [merge.added + ' session(s) added']
        if (merge.duplicates) bits.push(merge.duplicates + ' duplicate(s) skipped')
        if (result.skipped) bits.push(result.skipped + ' malformed record(s) skipped')
        state.importLog.unshift({ name: name, kind: result.skipped ? 'warn' : 'ok', message: bits.join(', ') + '.' })
      })
      renderAll()
    })
  }

  function handleParamsFiles(files) {
    var list = Array.prototype.slice.call(files)
    if (!list.length) return
    var file = list[0]
    readFileAsText(file)
      .then(function (text) {
        var result = parseEngineParamsJSON(text)
        if (!result.ok) {
          state.engineParams = null
          state.paramsError = file.name + ': ' + result.error
        } else {
          state.engineParams = result
          state.paramsError = null
        }
        renderParams()
      })
      .catch(function (err) {
        state.engineParams = null
        state.paramsError = file.name + ': ' + (err.message || 'Could not read file.')
        renderParams()
      })
  }

  function wireDropzone(zoneEl, inputEl, onFiles) {
    // onActivate already limits keydown to Enter/Space before calling this,
    // so every call here (click or qualifying keydown) should open the picker.
    onActivate(zoneEl, function () {
      inputEl.click()
    })
    inputEl.addEventListener('change', function (e) {
      onFiles(e.target.files)
      inputEl.value = ''
    })
    ;['dragenter', 'dragover'].forEach(function (evt) {
      zoneEl.addEventListener(evt, function (e) {
        e.preventDefault()
        zoneEl.classList.add('drag-over')
      })
    })
    ;['dragleave', 'drop'].forEach(function (evt) {
      zoneEl.addEventListener(evt, function (e) {
        e.preventDefault()
        zoneEl.classList.remove('drag-over')
      })
    })
    zoneEl.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
    })
  }

  /* ---------------------------------------------------------------------
     Rendering — overview, import log, table
     --------------------------------------------------------------------- */

  function renderImportLog() {
    var list = $('#import-log')
    list.innerHTML = ''
    state.importLog.forEach(function (entry) {
      var li = document.createElement('li')
      li.className = 'log-entry log-' + entry.kind
      li.textContent = entry.name + ': ' + entry.message
      list.appendChild(li)
    })
    var summary = $('#import-summary')
    summary.textContent = state.fileCount
      ? state.fileCount + (state.fileCount === 1 ? ' file' : ' files') + ' imported (approx. devices) — ' + state.sessions.length + ' unique session(s) loaded.'
      : ''
  }

  function renderOverview() {
    var ov = computeOverview(state.sessions)
    $('#stat-count').textContent = String(ov.count)
    $('#stat-totalml').textContent = ov.totalMl.toFixed(1) + ' mL'
    $('#stat-avgml').textContent = ov.count ? ov.avgMl.toFixed(2) + ' mL' : '--'
    $('#stat-capture').textContent = ov.count ? Math.round(ov.captureRate * 100) + '%' : '--'
    if (!ov.dateRange.start) {
      $('#stat-daterange').textContent = '--'
    } else {
      var startLabel = formatDateShort(ov.dateRange.start)
      var endLabel = formatDateShort(ov.dateRange.end)
      $('#stat-daterange').textContent = startLabel === endLabel ? startLabel : startLabel + ' – ' + endLabel
    }
  }

  function td(text) {
    var el = document.createElement('td')
    el.textContent = text
    return el
  }

  function emptyRow(colspan, text) {
    var tr = document.createElement('tr')
    var el = document.createElement('td')
    el.colSpan = colspan
    el.className = 'empty-row'
    el.textContent = text
    tr.appendChild(el)
    return tr
  }

  function thumbImg(src, alt) {
    var img = document.createElement('img')
    img.src = src
    img.alt = alt
    img.className = 'thumb'
    img.loading = 'lazy'
    return img
  }

  function updateSortIndicators() {
    Array.prototype.forEach.call(document.querySelectorAll('#session-table thead th[data-sort]'), function (th) {
      th.classList.remove('sorted-asc', 'sorted-desc')
      if (th.getAttribute('data-sort') === state.sort.key) {
        th.classList.add(state.sort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc')
      }
    })
  }

  function renderTable() {
    var tbody = $('#session-table-body')
    tbody.innerHTML = ''
    var COLS = 7

    if (!state.sessions.length) {
      tbody.appendChild(emptyRow(COLS, 'No sessions loaded yet — drop a session export JSON above.'))
      updateSortIndicators()
      $('#session-count-label').textContent = ''
      return
    }

    var rows = filterAndSortSessions(state.sessions, { query: state.query, sortKey: state.sort.key, sortDir: state.sort.dir })

    if (!rows.length) {
      tbody.appendChild(emptyRow(COLS, 'No sessions match "' + state.query + '".'))
      updateSortIndicators()
      $('#session-count-label').textContent = '0 of ' + state.sessions.length
      return
    }

    rows.forEach(function (r) {
      var tr = document.createElement('tr')
      tr.appendChild(td(r.at ? formatDateTime(r.at) : 'Unknown date'))
      tr.appendChild(td(r.firstName || 'Anonymous'))
      tr.appendChild(td(r.ageRange || '--'))
      tr.appendChild(td(goalLabel(r.goal)))

      var zoneIds = Object.keys(r.units).sort(function (a, b) { return r.units[b] - r.units[a] })
      var zoneParts = zoneIds.map(function (id) { return zoneLabel(id) + ' ' + r.units[id].toFixed(1) })
      tr.appendChild(td(zoneParts.length ? zoneParts.join(', ') : 'No zones'))

      var mlCell = td(r.totalMl.toFixed(1) + ' mL')
      mlCell.className = 'num'
      tr.appendChild(mlCell)

      var photoCell = document.createElement('td')
      photoCell.className = 'photo-cell'
      if (r.thumbBefore) photoCell.appendChild(thumbImg(r.thumbBefore, 'Before'))
      if (r.thumbAfter) photoCell.appendChild(thumbImg(r.thumbAfter, 'After'))
      if (!r.thumbBefore && !r.thumbAfter) photoCell.textContent = '--'
      tr.appendChild(photoCell)

      tbody.appendChild(tr)
    })

    updateSortIndicators()
    $('#session-count-label').textContent = rows.length + ' of ' + state.sessions.length
  }

  /* ---------------------------------------------------------------------
     Charts — hand-rolled canvas, no libraries
     --------------------------------------------------------------------- */

  function applyCanvasSize(canvas, cssWidth, cssHeight) {
    var dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(cssWidth * dpr))
    canvas.height = Math.max(1, Math.round(cssHeight * dpr))
    canvas.style.width = cssWidth + 'px'
    canvas.style.height = cssHeight + 'px'
    var ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
  }

  function prepareCanvasFixed(canvas, cssHeight) {
    // Measure the canvas's own laid-out width (it has `width: 100%` in CSS)
    // rather than the parent .chart-card's clientWidth directly: clientWidth
    // includes the parent's own padding, and the canvas sits *inside* that
    // padding, so sizing to clientWidth would make the canvas ~2x the
    // padding too wide and push its rightmost content past the card's edge.
    var rectWidth = canvas.getBoundingClientRect().width
    var cssWidth = Math.max(1, rectWidth || canvas.parentElement.clientWidth)
    return { ctx: applyCanvasSize(canvas, cssWidth, cssHeight), width: cssWidth, height: cssHeight }
  }

  function drawEmptyState(ctx, width, height, message) {
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = COLOR_TEXT_FAINT
    ctx.font = '13px ' + FONT_STACK
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(message, width / 2, height / 2)
  }

  function niceMaxFor(maxVal) {
    if (maxVal <= 0) return 1
    return maxVal <= 5 ? maxVal + 1 : Math.ceil(maxVal * 1.15)
  }

  function drawYAxisGrid(ctx, padL, padT, plotW, plotH, niceMax) {
    ctx.strokeStyle = COLOR_GRID
    ctx.fillStyle = COLOR_TEXT_FAINT
    ctx.font = '11px ' + FONT_STACK
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ;[0, 0.5, 1].forEach(function (t) {
      var y = padT + plotH * (1 - t)
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + plotW, y)
      ctx.stroke()
      ctx.fillText(String(Math.round(niceMax * t)), padL - 8, y)
    })
  }

  function drawWeeklyChart(canvas, data) {
    var wrap = canvas.parentElement
    var minSlot = 34
    var cssWidth = Math.max(wrap.clientWidth, data.length * minSlot)
    var cssHeight = 220
    var ctx = applyCanvasSize(canvas, cssWidth, cssHeight)
    ctx.clearRect(0, 0, cssWidth, cssHeight)

    if (!data.length) {
      drawEmptyState(ctx, cssWidth, cssHeight, 'No sessions loaded yet.')
      return
    }

    var padL = 34
    var padR = 12
    var padT = 16
    var padB = 28
    var plotW = cssWidth - padL - padR
    var plotH = cssHeight - padT - padB
    var maxCount = Math.max.apply(null, data.map(function (d) { return d.count }))
    var niceMax = niceMaxFor(maxCount)

    drawYAxisGrid(ctx, padL, padT, plotW, plotH, niceMax)

    var slot = plotW / data.length
    var barW = Math.max(6, Math.min(28, slot * 0.6))
    var labelEvery = data.length <= 14 ? 1 : Math.ceil(data.length / 14)
    ctx.textAlign = 'center'
    data.forEach(function (d, i) {
      var cx = padL + slot * (i + 0.5)
      var barH = plotH * (d.count / niceMax)
      ctx.fillStyle = COLOR_ACCENT
      ctx.fillRect(cx - barW / 2, padT + plotH - barH, barW, Math.max(1, barH))
      if (i % labelEvery === 0) {
        ctx.fillStyle = COLOR_TEXT_FAINT
        ctx.textBaseline = 'top'
        ctx.font = '11px ' + FONT_STACK
        ctx.fillText(formatWeekLabel(d.weekStart), cx, padT + plotH + 8)
      }
    })
  }

  function drawZoneChart(canvas, data) {
    var res = prepareCanvasFixed(canvas, 220)
    var ctx = res.ctx
    var cssWidth = res.width
    var cssHeight = res.height
    ctx.clearRect(0, 0, cssWidth, cssHeight)

    var maxVal = Math.max.apply(null, data.map(function (d) { return d.totalMl }))
    if (!data.length || maxVal <= 0) {
      drawEmptyState(ctx, cssWidth, cssHeight, 'No zone data yet.')
      return
    }

    var padL = 92
    var padR = 52
    var padT = 10
    var padB = 10
    var rowH = (cssHeight - padT - padB) / data.length
    var plotW = cssWidth - padL - padR
    // Normalize against a max with headroom (not the raw max) so the
    // longest bar leaves room for its own "X.X mL" label instead of
    // running the label off the edge of the canvas.
    var niceMax = niceMaxFor(maxVal)

    ctx.font = '12px ' + FONT_STACK
    data.forEach(function (d, i) {
      var y = padT + rowH * i + rowH * 0.22
      var h = rowH * 0.56
      var w = plotW * (d.totalMl / niceMax)
      ctx.fillStyle = COLOR_TEXT_MUTED
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(d.label, padL - 10, y + h / 2)
      ctx.fillStyle = COLOR_ACCENT
      ctx.fillRect(padL, y, Math.max(1, w), h)
      ctx.fillStyle = COLOR_TEXT_FAINT
      ctx.textAlign = 'left'
      ctx.fillText(d.totalMl.toFixed(1) + ' mL', padL + w + 8, y + h / 2)
    })
  }

  function drawAgeChart(canvas, data) {
    var res = prepareCanvasFixed(canvas, 220)
    var ctx = res.ctx
    var cssWidth = res.width
    var cssHeight = res.height
    ctx.clearRect(0, 0, cssWidth, cssHeight)

    var total = data.reduce(function (a, d) { return a + d.count }, 0)
    if (!total) {
      drawEmptyState(ctx, cssWidth, cssHeight, 'No sessions loaded yet.')
      return
    }

    var padL = 30
    var padR = 12
    var padT = 16
    var padB = 28
    var plotW = cssWidth - padL - padR
    var plotH = cssHeight - padT - padB
    var maxCount = Math.max.apply(null, data.map(function (d) { return d.count }))
    var niceMax = niceMaxFor(maxCount)

    drawYAxisGrid(ctx, padL, padT, plotW, plotH, niceMax)

    var slot = plotW / data.length
    var barW = Math.min(48, slot * 0.55)
    ctx.textAlign = 'center'
    data.forEach(function (d, i) {
      var cx = padL + slot * (i + 0.5)
      var barH = plotH * (d.count / niceMax)
      ctx.fillStyle = d.range === 'Unknown' ? COLOR_TEXT_FAINT : COLOR_ACCENT
      ctx.fillRect(cx - barW / 2, padT + plotH - barH, barW, Math.max(1, barH))
      ctx.fillStyle = COLOR_TEXT_FAINT
      ctx.textBaseline = 'top'
      ctx.font = '11px ' + FONT_STACK
      ctx.fillText(d.range, cx, padT + plotH + 8)
    })
  }

  function drawAestheticDonut(canvas, data) {
    var res = prepareCanvasFixed(canvas, 240)
    var ctx = res.ctx
    var cssWidth = res.width
    var cssHeight = res.height
    ctx.clearRect(0, 0, cssWidth, cssHeight)

    var total = data.reduce(function (a, d) { return a + d.count }, 0)
    if (!total) {
      drawEmptyState(ctx, cssWidth, cssHeight, 'No sessions loaded yet.')
      return
    }

    var donutTop = 14
    var donutH = 140
    var cx = cssWidth / 2
    var cy = donutTop + donutH / 2
    var rOuter = donutH / 2 - 4
    var rInner = rOuter * 0.58
    var start = -Math.PI / 2

    data.forEach(function (d, i) {
      if (!d.count) return
      var slice = (d.count / total) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, rOuter, start, start + slice)
      ctx.closePath()
      ctx.fillStyle = DONUT_COLORS[i % DONUT_COLORS.length]
      ctx.fill()
      start += slice
    })

    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.arc(cx, cy, rInner, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'

    ctx.fillStyle = COLOR_TEXT_MUTED
    ctx.font = '12px ' + FONT_STACK
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(total), cx, cy - 6)
    ctx.fillStyle = COLOR_TEXT_FAINT
    ctx.font = '10px ' + FONT_STACK
    ctx.fillText('sessions', cx, cy + 10)

    var legendY = donutTop + donutH + 22
    ctx.font = '12px ' + FONT_STACK
    var items = data.map(function (d, i) {
      var pct = Math.round((d.count / total) * 100)
      return { text: d.label + ' ' + d.count + ' (' + pct + '%)', color: DONUT_COLORS[i % DONUT_COLORS.length] }
    })
    var widths = items.map(function (it) { return ctx.measureText(it.text).width + 22 })
    var totalW = widths.reduce(function (a, b) { return a + b + 16 }, -16)
    var x = Math.max(10, (cssWidth - totalW) / 2)
    items.forEach(function (it, i) {
      ctx.fillStyle = it.color
      ctx.fillRect(x, legendY - 5, 10, 10)
      ctx.fillStyle = COLOR_TEXT_MUTED
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(it.text, x + 16, legendY)
      x += widths[i] + 16
    })
  }

  function renderCharts() {
    drawWeeklyChart($('#chart-weekly'), consultationsPerWeek(state.sessions))
    drawZoneChart($('#chart-zones'), zonePopularity(state.sessions))
    drawAestheticDonut($('#chart-aesthetic'), aestheticSplit(state.sessions))
    drawAgeChart($('#chart-age'), ageDistribution(state.sessions))
  }

  /* ---------------------------------------------------------------------
     Fitted-params viewer
     --------------------------------------------------------------------- */

  function renderParams() {
    var tbody = $('#params-table-body')
    var summary = $('#params-summary')
    tbody.innerHTML = ''
    var COLS = 7

    if (state.paramsError) {
      summary.textContent = 'Error: ' + state.paramsError
      summary.classList.add('is-error')
      tbody.appendChild(emptyRow(COLS, 'Fix the file above and drop it again.'))
      return
    }
    summary.classList.remove('is-error')

    if (!state.engineParams) {
      summary.textContent = ''
      tbody.appendChild(emptyRow(COLS, 'Drop an engine-params JSON to see per-zone fit diagnostics.'))
      return
    }

    var ep = state.engineParams
    var summaryBits = [
      'Fitted ' + (ep.fittedAt ? formatDateShort(ep.fittedAt) : 'unknown date'),
      ep.rows.length + ' zone(s)',
    ]
    if (ep.skipped.length) summaryBits.push(ep.skipped.length + ' unrecognized zone entries skipped')
    summary.textContent = summaryBits.join(' — ') + '.'

    if (!ep.rows.length) {
      tbody.appendChild(emptyRow(COLS, 'This file has no usable zone entries.'))
      return
    }

    ep.rows.forEach(function (row) {
      var tr = document.createElement('tr')
      tr.appendChild(td(row.label))
      tr.appendChild(td(row.mode))
      tr.appendChild(td(row.k === null ? 'N/A' : row.k.toFixed(4)))
      tr.appendChild(td(row.p === null ? 'N/A' : row.p.toFixed(2)))
      tr.appendChild(td(row.n === null ? 'N/A' : String(row.n)))
      tr.appendChild(td(row.rmse === null ? 'N/A' : row.rmse.toFixed(4)))
      var interp = td(row.interpretation)
      interp.className = 'interp-cell'
      tr.appendChild(interp)
      tbody.appendChild(tr)
    })
  }

  /* ---------------------------------------------------------------------
     Wiring
     --------------------------------------------------------------------- */

  function updateButtons() {
    $('#btn-export-merged').disabled = state.sessions.length === 0
    $('#btn-clear').disabled = state.sessions.length === 0 && state.fileCount === 0
  }

  function renderAll() {
    renderImportLog()
    renderOverview()
    renderCharts()
    renderTable()
    updateButtons()
  }

  function init() {
    wireDropzone($('#dropzone-sessions'), $('#file-input-sessions'), handleSessionFiles)
    wireDropzone($('#dropzone-params'), $('#file-input-params'), handleParamsFiles)

    $('#session-search').addEventListener('input', function (e) {
      state.query = e.target.value
      renderTable()
    })

    Array.prototype.forEach.call(document.querySelectorAll('#session-table thead th[data-sort]'), function (th) {
      onActivate(th, function () {
        var key = th.getAttribute('data-sort')
        if (state.sort.key === key) {
          state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc'
        } else {
          state.sort.key = key
          state.sort.dir = 'desc'
        }
        renderTable()
      })
    })

    $('#btn-export-merged').addEventListener('click', function () {
      downloadJSON(buildMergedSessionsExport(state.sessions), 'clinic-dashboard-merged-sessions-' + todayStamp() + '.json')
    })

    $('#btn-clear').addEventListener('click', function () {
      state.sessions = []
      state.fileCount = 0
      state.importLog = []
      state.query = ''
      $('#session-search').value = ''
      renderAll()
    })

    var resizeTimer = null
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(renderCharts, 120)
    })

    renderAll()
    renderParams()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
