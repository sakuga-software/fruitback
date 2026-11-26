---
'@fruitback/worker': minor
'@fruitback/console': minor
---

The list of the connectors says the health of each one: how many of its deliveries did not arrive, how many notes went to it, and when its last send arrived. The worker keeps that moment on the connector (migration 0054): when an address takes a delivery, and when a tracker takes a note. The Connectors screen shows it in a « Last delivery » column (« 12 min ago », « None yet »), counts the notes in « Used by » (« 2 sites · 31 notes »), says « Healthy » for a tracker that its tracker does not refuse, and reads the list of the sends of an address only when some of them wait.
