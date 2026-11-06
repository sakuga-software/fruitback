---
'@fruitback/worker': minor
'@fruitback/console': minor
---

The trigger of a site can start a Claude Code routine of the team. « Connectors » takes the Fire URL and the token of the routine: Fruitback keeps the token encrypted, sends it to api.anthropic.com only, and never shows it again. A call carries identifiers only, and notes sent together start one session. The panel of the routine shows « Session started » with the link of each session. A refused token stops the call at once, and the routine needs attention.
