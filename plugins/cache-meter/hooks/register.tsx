import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ModelUsage } from 'claude-code'

import type { CacheInfo, ContextInfo } from '../types'

const cacheAtom = atom({ plugin: 'cache-meter', key: 'cache' } as const, null)
const contextAtom = atom({ plugin: 'cache-meter', key: 'context' } as const, null)
const collapsedAtom = atom({ plugin: 'cache-meter', key: 'collapsed' } as const, false)
const tickAtom = atom({ plugin: 'cache-meter', key: 'tick' } as const, 0)
const pathAtom = atom({ plugin: 'cache-meter', key: 'transcriptPath' } as const, null)

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000
const DEFAULT_THRESHOLD = 83
const BAR_CELLS = 20
const LOG_CHUNK = 1800

// Wetter je nach Kontextfüllung im Verhältnis zur Auto-Compact-Schwelle.
const SUNNY = '☀️' // bis zur Hälfte der Schwelle
const CLOUDY = '⛅' // bis 80 % der Schwelle
const STORM = '⛈️' // darüber: Compact wird hervorgehoben

type Weather = { emoji: string; level: 0 | 1 | 2 }

function weatherFor(ctx: ContextInfo | null): Weather {
  if (ctx === null || ctx.pct === null) return { emoji: SUNNY, level: 0 }
  const ratio = ctx.pct / ctx.thresholdPct
  if (ratio <= 0.5) return { emoji: SUNNY, level: 0 }
  if (ratio <= 0.8) return { emoji: CLOUDY, level: 1 }
  return { emoji: STORM, level: 2 }
}

function hitRate(u: ModelUsage): number | null {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (total <= 0) return null
  return Math.round((u.cache_read_input_tokens / total) * 100)
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '?'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

// ---------- Session-Log lesen (Cache-Laufzeit, letzte Antwort) ----------

async function readTail($: EngineInterface, path: string): Promise<string | null> {
  try {
    const st = await $.fs.stat(path)
    if (st.size <= 3.5 * 1024 * 1024) return await $.fs.read(path)
  } catch {
    return null
  }
  // Große Logs: nur das Ende holen.
  const tries: string[][] = [
    ['tail', '-n', '400', path],
    ['powershell', '-NoProfile', '-Command', `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Tail 400 -Encoding UTF8`],
  ]
  for (const argv of tries) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 8000 })
      if (r.exitCode === 0 && r.stdout) return r.stdout
    } catch {
      // nächster Versuch
    }
  }
  return null
}

type LogScan = { ttlMs?: number; lastAt?: number; hitPct?: number | null }

function scanLog(text: string): LogScan {
  const lines = text.split('\n')
  const out: LogScan = {}
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line.indexOf('"usage"') < 0) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type !== 'assistant' || entry.isSidechain) continue
    const u = entry.message?.usage
    if (!u) continue
    if (out.lastAt === undefined) {
      const t = Date.parse(entry.timestamp)
      if (Number.isFinite(t)) out.lastAt = t
      out.hitPct = hitRate({
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      })
    }
    const cc = u.cache_creation
    if (cc && out.ttlMs === undefined) {
      if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) out.ttlMs = ONE_HOUR
      else if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) out.ttlMs = FIVE_MIN
    }
    if (out.ttlMs !== undefined && out.lastAt !== undefined) break
  }
  return out
}

async function guessTranscriptPath($: EngineInterface): Promise<string | null> {
  try {
    const id = await $.session.id()
    const cwd = await $.session.cwd()
    const cfg =
      (await $.env.get('CLAUDE_CONFIG_DIR')) ??
      `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''}/.claude`
    const dir = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const p = `${cfg}/projects/${dir}/${id}.jsonl`
    return (await $.fs.exists(p)) ? p : null
  } catch {
    return null
  }
}

async function refreshFromLog($: EngineInterface, useTiming: boolean) {
  let path = await read($, pathAtom)
  if (!path) {
    path = await guessTranscriptPath($)
    if (path) await update($, pathAtom, () => path)
  }
  if (!path) return
  const text = await readTail($, path)
  if (!text) return
  const scan = scanLog(text)
  if (scan.ttlMs !== undefined) await $.store.set('ttlMs', scan.ttlMs)
  const storedTtl = Number(await $.store.get('ttlMs')) || FIVE_MIN
  await update($, cacheAtom, (prev): CacheInfo => {
    const base: CacheInfo = prev ?? { lastAt: null, ttlMs: storedTtl, ttlKnown: false, hitPct: null }
    const next: CacheInfo = {
      ...base,
      ttlMs: scan.ttlMs ?? base.ttlMs,
      ttlKnown: base.ttlKnown || scan.ttlMs !== undefined,
    }
    if (useTiming && scan.lastAt !== undefined && (base.lastAt === null || scan.lastAt > base.lastAt)) {
      next.lastAt = scan.lastAt
      if (scan.hitPct !== undefined) next.hitPct = scan.hitPct
    }
    return next
  })
}

// ---------- Kontext und Auto-Compact-Schwelle ----------

async function refreshContext($: EngineInterface, estimateTokens?: number) {
  let pct: number | null = null
  let thresholdPct = DEFAULT_THRESHOLD
  let thresholdKnown = false
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const ctx = usage.context
    const window = ctx.window
    if (ctx.percent !== undefined) pct = ctx.percent
    else if (estimateTokens !== undefined && window > 0) pct = Math.round((estimateTokens / window) * 100)
    const b = ctx.breakdown
    if (b && b.isAutoCompactEnabled && b.autoCompactThreshold && window > 0) {
      thresholdPct = Math.round((b.autoCompactThreshold / window) * 100)
      thresholdKnown = true
    }
  } catch {
    try {
      const ctx = (await $.session.usage()).context
      if (ctx.percent !== undefined) pct = ctx.percent
    } catch {
      // bleibt leer
    }
  }
  await update($, contextAtom, (): ContextInfo => ({ pct, thresholdPct, thresholdKnown }))
}

// ---------- Zusammenfassung in den Chat schreiben ----------

function chunkSummary(text: string): string[] {
  const paras = text.split(/\n\s*\n/)
  const chunks: string[] = []
  let cur = ''
  const push = () => {
    if (cur.trim()) chunks.push(cur.trimEnd())
    cur = ''
  }
  for (const para of paras) {
    const pieces: string[] = []
    if (para.length > LOG_CHUNK) {
      // Überlange Absätze an Zeilen, notfalls an Wörtern teilen.
      let rest = para
      while (rest.length > LOG_CHUNK) {
        let cut = rest.lastIndexOf('\n', LOG_CHUNK)
        if (cut < LOG_CHUNK / 2) cut = rest.lastIndexOf(' ', LOG_CHUNK)
        if (cut < LOG_CHUNK / 2) cut = LOG_CHUNK
        pieces.push(rest.slice(0, cut))
        rest = rest.slice(cut).replace(/^\s+/, '')
      }
      if (rest) pieces.push(rest)
    } else {
      pieces.push(para)
    }
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 2 > LOG_CHUNK) push()
      cur = cur ? `${cur}\n\n${piece}` : piece
    }
  }
  push()
  return chunks
}

function logSummary($: EngineInterface, before: number | undefined, after: number | undefined, summary: string) {
  $.ui.log(`🗜️ Compact: ${fmt(before)} Tokens vorher → ${fmt(after)} Tokens nachher`)
  const chunks = chunkSummary(summary)
  if (chunks.length === 0) {
    $.ui.log('(Keine Zusammenfassung gefunden.)')
    return
  }
  chunks.forEach((c, i) => {
    const head = chunks.length > 1 ? `Zusammenfassung (${i + 1}/${chunks.length}):\n` : 'Zusammenfassung:\n'
    $.ui.log(head + c)
  })
}

// ---------- Compact auslösen ----------

async function runCompact($: EngineInterface, isWorking: boolean, surface: string) {
  if (!isWorking && surface !== 'desktop') {
    try {
      const r = await $.session.compact()
      if (r.skip) $.ui.toast(`Compact übersprungen: ${r.skip}`)
      return
    } catch {
      // läuft gerade etwas: einreihen
    }
  }
  await $.prompt.submit({ text: '/compact', asUser: true })
  $.ui.toast(isWorking ? '/compact eingereiht: startet, sobald Claude fertig ist' : '/compact gestartet')
}

// ---------- Register ----------

async function rememberPath($: EngineInterface, path: unknown) {
  if (typeof path === 'string' && path) {
    const cur = await read($, pathAtom)
    if (cur !== path) await update($, pathAtom, () => path)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    $.clock.every(60_000, () => {
      void update($, tickAtom, n => (n ?? 0) + 1)
    })
    await refreshFromLog($, true)
    await refreshContext($)
    return r
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, cacheAtom, prev => (prev ? { ...prev, lastAt: null, hitPct: null } : prev))
      await update($, contextAtom, () => null)
      await update($, pathAtom, () => null)
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await rememberPath($, e.transcript_path)
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await rememberPath($, e.transcript_path)
    return next(e)
  })

  // Jede Antwort des Hauptmodells: Zeitpunkt und Hit-Rate.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (!e.agentId && r.usage) {
      const now = await $.clock.now()
      const pct = hitRate(r.usage)
      const storedTtl = Number(await $.store.get('ttlMs')) || FIVE_MIN
      await update($, cacheAtom, (prev): CacheInfo => ({
        ttlMs: prev?.ttlMs ?? storedTtl,
        ttlKnown: prev?.ttlKnown ?? false,
        lastAt: now,
        hitPct: pct,
      }))
    }
    return r
  })

  on('classic.Stop', async ($, e, next) => {
    await rememberPath($, e.transcript_path)
    await refreshFromLog($, false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) await refreshContext($)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || r.skip !== undefined) return r
    if (e.trigger === 'manual' || e.trigger === 'plugin') {
      const msgs = r.messages ?? []
      const summary =
        msgs.find(m => m.role === 'user' && m.text.length > 200)?.text ??
        msgs.find(m => m.text.length > 0)?.text ??
        ''
      logSummary($, r.tokensBefore, r.tokensAfter, summary)
    }
    await refreshContext($, r.tokensAfter)
    return r
  })

  // ---------- Die Leiste ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)

    await read($, tickAtom) // jede Minute neu zeichnen
    const cache = await read($, cacheAtom)
    const ctx = await read($, contextAtom)
    const collapsed = await read($, collapsedAtom)
    const now = await $.clock.now()

    const { Box, Text, Button } = $.ui.resolve(e)
    const weather = weatherFor(ctx)

    // Cache-Restzeit
    let minutesText = '–'
    let barColor: 'success' | 'warning' | 'error' = 'success'
    let filled = 0
    let expired = false
    const ttl = cache?.ttlMs ?? FIVE_MIN
    if (cache && cache.lastAt !== null) {
      const remaining = Math.max(0, cache.lastAt + ttl - now)
      const frac = remaining / ttl
      expired = remaining <= 0
      filled = Math.ceil(frac * BAR_CELLS)
      barColor = frac <= 0.1 ? 'error' : frac <= 0.25 ? 'warning' : 'success'
      minutesText = expired ? 'abgelaufen' : `${Math.ceil(remaining / 60_000)} min`
    }
    const ttlLabel = ttl >= ONE_HOUR ? '1 h' : '5 min'
    const ctxText = ctx?.pct != null ? `${ctx.pct} %` : '–'

    const toggle = (
      <Button
        key="toggle"
        plain
        label={collapsed ? '▸' : '▾'}
        onPress={() => update($, collapsedAtom, c => !c)}
      />
    )

    if (collapsed) {
      return (
        <Box flexDirection="row" gap={1}>
          {toggle}
          <Text>{weather.emoji}</Text>
          <Text color={cache?.lastAt != null ? barColor : undefined} dimColor={cache?.lastAt == null}>
            {minutesText}
          </Text>
          <Text dimColor>·</Text>
          <Text>{ctxText}</Text>
        </Box>
      )
    }

    const bar = cache?.lastAt != null && !expired
      ? (
          <Text>
            <Text color={barColor}>{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(BAR_CELLS - filled)}</Text>
          </Text>
        )
      : <Text dimColor>{'░'.repeat(BAR_CELLS)}</Text>

    const threshold = ctx?.thresholdPct ?? DEFAULT_THRESHOLD
    const isStorm = weather.level === 2

    return (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {toggle}
        <Text dimColor>Cache ({ttlLabel})</Text>
        <Text color={cache?.lastAt != null ? (expired ? 'error' : barColor) : undefined} tabular>
          {minutesText}
        </Text>
        {bar}
        <Text dimColor>│</Text>
        <Text dimColor>Hit</Text>
        <Text tabular>{cache?.hitPct != null ? `${cache.hitPct} %` : '–'}</Text>
        <Text dimColor>│</Text>
        <Text>{weather.emoji}</Text>
        <Text dimColor>Kontext</Text>
        <Text tabular color={isStorm ? 'error' : undefined}>{ctxText}</Text>
        <Text dimColor>
          / Auto-Compact {threshold} %{ctx?.thresholdKnown ? '' : ' (Standard)'}
        </Text>
        <Text dimColor>│</Text>
        <Button
          key="compact"
          label="Compact"
          variant={isStorm ? 'primary' : undefined}
          onPress={() => runCompact($, e.props.isWorking, e.surface)}
        />
      </Box>
    )
  })
}
