---
'@fruitback/worker': minor
'@fruitback/console': minor
---

A workspace can connect Jira Cloud, by consent at Atlassian (OAuth 2.0), on a server whose operator sets `FRUITBACK_JIRA_OAUTH`. Each note becomes an issue of the project a site chooses, with its files attached, and its pin takes the stage of the status of the issue. Fruitback takes no API token of Jira, keeps the token of the consent encrypted, and says « Needs attention » when Atlassian refuses it or ends it.
