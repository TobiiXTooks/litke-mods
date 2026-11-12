export type CacheInfo = {
  /** Zeitpunkt der letzten Hauptantwort in $.clock.now()-Millisekunden. */
  lastAt: number | null
  /** Cache-Laufzeit der Session in Millisekunden (5 min oder 1 h). */
  ttlMs: number
  /** Ob die Laufzeit aus dem Session-Log gelesen wurde. */
  ttlKnown: boolean
  /** Anteil der Input-Tokens der letzten Antwort aus dem Cache, 0..100. */
  hitPct: number | null
}

export type ContextInfo = {
  /** Kontextfüllung in Prozent des Kontextfensters. */
  pct: number | null
  /** Auto-Compact-Schwelle in Prozent des Kontextfensters. */
  thresholdPct: number
  /** Ob die Schwelle aus der Session stammt (sonst 83 %). */
  thresholdKnown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': {
      cache: CacheInfo | null
      context: ContextInfo | null
      collapsed: boolean
      tick: number
      transcriptPath: string | null
    }
  }
}
