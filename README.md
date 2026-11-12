# litke-mods

Claude-Code-Mods als Plugin-Marketplace.

```bash
claude plugin marketplace add TobiiXTooks/litke-mods
claude plugin install cache-meter@litke-mods --scope user
```

| Mod | Herkunft |
| --- | --- |
| cache-meter | eigene Mod |
| next-steps | übernommen von [hamzafer](https://github.com/hamzafer) |
| blast-radius, replay-theater, token-weather | [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground) |

Die Plugins haben kein `version`-Feld. Claude nimmt deshalb den Commit-SHA als Version, und jeder Push kommt beim nächsten Update an.
