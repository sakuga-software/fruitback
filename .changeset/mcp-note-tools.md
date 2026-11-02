---
'@fruitback/worker': minor
'@fruitback/shared': patch
---

The tools of `/mcp` say « note », as the contract does: `list_feedback` is `list_notes`, `get_feedback` is `get_note`, `feedback_as_text` is `notes_as_text`, `reply_to_feedback` is `reply_to_note`, and `set_feedback_status` is `set_note_status`. The old names are gone, with no alias: an agent that is already configured must reload its tools. `notes_as_text` titles a page « Notes on {url} », as the widget does, and an issue with no text is titled « Note on <tag> — path ».
