# cache-meter

Eine schmale Leiste direkt über dem Eingabefeld von Claude Code (Terminal und Desktop App).

Von links nach rechts:

1. **Cache-Restzeit** in Minuten seit der letzten Antwort, mit der echten Cache-Laufzeit der Session (5 min oder 1 h, aus dem Session-Log gelesen). Dazu ein Balken aus 20 Kästchen: grün, im letzten Viertel gelb, in den letzten 10 % rot, bei 0 „abgelaufen“. Wird jede Minute neu gezeichnet.
2. **Hit-Rate** der letzten Antwort: Anteil der Input-Tokens aus dem Cache.
3. **Wetter-Emoji** nach Kontextfüllung relativ zur Auto-Compact-Schwelle: ☀️ bis zur Hälfte, ⛅ bis 80 %, ⛈️ darüber.
4. **Kontextfüllung** in Prozent und die Auto-Compact-Schwelle der Session (sonst 83 %).
5. **Compact**-Button, bei ⛈️ hervorgehoben. Läuft gerade ein Turn oder ist es die Desktop App, wird `/compact` eingereiht.
6. **▾/▸** klappt die Leiste zu: dann nur Emoji, Cache-Restzeit und Kontext.

Nach `/compact` oder einem Klick auf Compact schreibt der Mod eine Zeile mit den Tokens vorher und nachher und die Zusammenfassung als Log-Zeilen in den Chat (das Modell liest sie nicht mit), lange Zusammenfassungen an Absätzen geteilt.

## Installation

```
claude plugin marketplace add C:\Users\litke\Documents\Claude\Mods\Cache-Meter
claude plugin install cache-meter@litke-mods --scope user
```
