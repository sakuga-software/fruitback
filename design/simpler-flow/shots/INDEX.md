# Captures de la maquette « Fruitback, simpler flow » (2026-10-13)

Source : `../source/simpler-flow.html` (sha256 `478717a9eef5…`). Rendu : Chromium de Playwright 1.58.2, hors ligne (toute requête non `file:`/`blob:`/`data:` bloquée ; **0 requête sortante tentée, 0 message de console**), `deviceScaleFactor` 1, animations figées, pleine page.
Script : `../tools/capture.cjs`. Mesures (contrastes, boîtes) : `../measures.json`. Le DOM rendu de chaque état n'est pas dans le dépôt : le script le refait.

Nommage : `NN-<écran>-<état>-<largeur>.png`. Suffixes : `focus2` = après deux `Tab` (anneau de focus visible) ; `hover-<classe>` = détail recadré au survol de la première occurrence de la classe ; `switches-inverted` = tous les interrupteurs cliqués une fois ; `360` = taille native du popup.

Notes de lecture :
- La maquette n'a **aucun gestionnaire d'événement** : les états sont des valeurs de propriété (`step`/`state`) posées par `__dcSetProps`. Aucun menu, aucune modale ne s'ouvre ; les boutons `aria-haspopup="menu"` n'ont pas de menu dessiné.
- **Pas de thème sombre** : rendu `prefers-color-scheme: dark` identique au pixel près au rendu clair sur les 20 écrans (mesuré). **Une seule langue** : anglais (`<html lang="en">`).
- À 390 px, les écrans à rail (09 à 13, 17 à 20) **débordent horizontalement** (largeur de document 547 à 580 px, 819 px pour 09 liste) : la colonne « largeur doc » le montre. Les écrans widget (14 à 16) sont une scène fixe de 1440 × 900 : leur capture « 390 » fait 1440 px de large et n'est pas une maquette mobile.
- Les popups (05 à 08) sont des boîtes fixes de 360 px : la capture de référence est la `360`.


## 01 — Setup, one screen

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `01-setup-email-1440.png` | 1440 | 1440 × 900 |  |
| `01-setup-sent-1440.png` | 1440 | 1440 × 900 |  |
| `01-setup-site-1440.png` | 1440 | 1440 × 931 |  |
| `01-setup-install-1440.png` | 1440 | 1440 × 1161 |  |
| `01-setup-first-note-1440.png` | 1440 | 1440 × 900 |  |
| `01-setup-email-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : A:Self-hosting guide |
| `01-setup-email-hover-b-accent-1440.png` | 1440 | 142 × 44 | détail au survol de .b-accent |
| `01-setup-email-hover-b-wide-1440.png` | 1440 | 352 × 44 | détail au survol de .b-wide |
| `01-setup-email-390.png` | 390 | 390 × 1668 |  |
| `01-setup-sent-390.png` | 390 | 390 × 1569 |  |
| `01-setup-site-390.png` | 390 | 390 × 1725 |  |
| `01-setup-install-390.png` | 390 | 390 × 1935 |  |
| `01-setup-first-note-390.png` | 390 | 390 × 1606 |  |
| `01-setup-email-focus2-390.png` | 390 | 390 × 1668 | focus après 2 Tab : A:Self-hosting guide |
| `01-setup-email-hover-b-accent-390.png` | 390 | 142 × 44 | détail au survol de .b-accent |
| `01-setup-email-hover-b-wide-390.png` | 390 | 310 × 44 | détail au survol de .b-wide |

## 02 — Sign in

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `02-sign-in-sign-in-1440.png` | 1440 | 1440 × 900 |  |
| `02-sign-in-sent-1440.png` | 1440 | 1440 × 900 |  |
| `02-sign-in-link-opened-1440.png` | 1440 | 1440 × 900 |  |
| `02-sign-in-expired-1440.png` | 1440 | 1440 × 900 |  |
| `02-sign-in-sign-in-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : INPUT:you@studio.com |
| `02-sign-in-sign-in-hover-b-accent-1440.png` | 1440 | 400 × 44 | détail au survol de .b-accent |
| `02-sign-in-sign-in-hover-b-wide-1440.png` | 1440 | 400 × 44 | détail au survol de .b-wide |
| `02-sign-in-sign-in-390.png` | 390 | 390 × 844 |  |
| `02-sign-in-sent-390.png` | 390 | 390 × 844 |  |
| `02-sign-in-link-opened-390.png` | 390 | 390 × 844 |  |
| `02-sign-in-expired-390.png` | 390 | 390 × 844 |  |
| `02-sign-in-sign-in-focus2-390.png` | 390 | 390 × 844 | focus après 2 Tab : INPUT:you@studio.com |
| `02-sign-in-sign-in-hover-b-accent-390.png` | 390 | 358 × 44 | détail au survol de .b-accent |
| `02-sign-in-sign-in-hover-b-wide-390.png` | 390 | 358 × 44 | détail au survol de .b-wide |

## 03 — Invitation

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `03-invitation-invitation-1440.png` | 1440 | 1440 × 900 |  |
| `03-invitation-joined-1440.png` | 1440 | 1440 × 900 |  |
| `03-invitation-invitation-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : BUTTON:Join Sakuga |
| `03-invitation-invitation-hover-b-accent-1440.png` | 1440 | 440 × 44 | détail au survol de .b-accent |
| `03-invitation-invitation-390.png` | 390 | 390 × 844 |  |
| `03-invitation-joined-390.png` | 390 | 390 × 844 |  |
| `03-invitation-invitation-focus2-390.png` | 390 | 390 × 844 | focus après 2 Tab : BUTTON:Join Sakuga |
| `03-invitation-invitation-hover-b-accent-390.png` | 390 | 358 × 44 | détail au survol de .b-accent |

## 04 — Connect this browser

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `04-connect-browser-ask-1440.png` | 1440 | 1440 × 900 |  |
| `04-connect-browser-signed-out-1440.png` | 1440 | 1440 × 900 |  |
| `04-connect-browser-connected-1440.png` | 1440 | 1440 × 900 |  |
| `04-connect-browser-ask-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : BUTTON:Connect Chrome |
| `04-connect-browser-ask-hover-b-accent-1440.png` | 1440 | 165 × 44 | détail au survol de .b-accent |
| `04-connect-browser-ask-hover-b-link-1440.png` | 1440 | 56 × 41 | détail au survol de .b-link |
| `04-connect-browser-ask-390.png` | 390 | 390 × 844 |  |
| `04-connect-browser-signed-out-390.png` | 390 | 390 × 844 |  |
| `04-connect-browser-connected-390.png` | 390 | 390 × 844 |  |
| `04-connect-browser-ask-focus2-390.png` | 390 | 390 × 844 | focus après 2 Tab : BUTTON:Connect Chrome |
| `04-connect-browser-ask-hover-b-accent-390.png` | 390 | 165 × 44 | détail au survol de .b-accent |
| `04-connect-browser-ask-hover-b-link-390.png` | 390 | 56 × 41 | détail au survol de .b-link |

## 05 — Popup, signed out

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `05-popup-signed-out-default-1440.png` | 1440 | 1440 × 900 |  |
| `05-popup-signed-out-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : BUTTON:Sign in to Fruitback |
| `05-popup-signed-out-default-hover-b-ext-1440.png` | 1440 | 328 × 44 | détail au survol de .b-ext |
| `05-popup-signed-out-default-hover-b-icon-1440.png` | 1440 | 36 × 36 | détail au survol de .b-icon |
| `05-popup-signed-out-default-390.png` | 390 | 390 × 844 |  |
| `05-popup-signed-out-default-focus2-390.png` | 390 | 390 × 844 | focus après 2 Tab : BUTTON:Sign in to Fruitback |
| `05-popup-signed-out-default-hover-b-ext-390.png` | 390 | 328 × 44 | détail au survol de .b-ext |
| `05-popup-signed-out-default-hover-b-icon-390.png` | 390 | 36 × 36 | détail au survol de .b-icon |
| `05-popup-signed-out-default-360.png` | 360 | 360 × 600 |  |
| `05-popup-signed-out-default-focus2-360.png` | 360 | 360 × 600 | focus après 2 Tab : BUTTON:Sign in to Fruitback |
| `05-popup-signed-out-default-hover-b-ext-360.png` | 360 | 328 × 44 | détail au survol de .b-ext |
| `05-popup-signed-out-default-hover-b-icon-360.png` | 360 | 36 × 36 | détail au survol de .b-icon |

## 06 — Popup, site in workspace

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `06-popup-site-in-workspace-default-1440.png` | 1440 | 1440 × 900 |  |
| `06-popup-site-in-workspace-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : BUTTON:Turn on here |
| `06-popup-site-in-workspace-default-hover-b-ext-1440.png` | 1440 | 328 × 44 | détail au survol de .b-ext |
| `06-popup-site-in-workspace-default-hover-b-icon-1440.png` | 1440 | 36 × 36 | détail au survol de .b-icon |
| `06-popup-site-in-workspace-default-390.png` | 390 | 390 × 844 |  |
| `06-popup-site-in-workspace-default-focus2-390.png` | 390 | 390 × 844 | focus après 2 Tab : BUTTON:Turn on here |
| `06-popup-site-in-workspace-default-hover-b-ext-390.png` | 390 | 328 × 44 | détail au survol de .b-ext |
| `06-popup-site-in-workspace-default-hover-b-icon-390.png` | 390 | 36 × 36 | détail au survol de .b-icon |
| `06-popup-site-in-workspace-default-360.png` | 360 | 360 × 600 |  |
| `06-popup-site-in-workspace-default-focus2-360.png` | 360 | 360 × 600 | focus après 2 Tab : BUTTON:Turn on here |
| `06-popup-site-in-workspace-default-hover-b-ext-360.png` | 360 | 328 × 44 | détail au survol de .b-ext |
| `06-popup-site-in-workspace-default-hover-b-icon-360.png` | 360 | 36 × 36 | détail au survol de .b-icon |

## 07 — Popup, on

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `07-popup-on-default-1440.png` | 1440 | 1440 × 900 |  |
| `07-popup-on-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : INPUT:Fruitback on staging.acme.dev |
| `07-popup-on-default-hover-b-ext-1440.png` | 1440 | 328 × 44 | détail au survol de .b-ext |
| `07-popup-on-default-hover-b-wide-1440.png` | 1440 | 328 × 40 | détail au survol de .b-wide |
| `07-popup-on-default-hover-b-icon-1440.png` | 1440 | 36 × 36 | détail au survol de .b-icon |
| `07-popup-on-default-switches-inverted-1440.png` | 1440 | 1440 × 900 | 1 interrupteur(s) inversé(s) |
| `07-popup-on-default-390.png` | 390 | 390 × 844 |  |
| `07-popup-on-default-focus2-390.png` | 390 | 390 × 844 | focus après 2 Tab : INPUT:Fruitback on staging.acme.dev |
| `07-popup-on-default-hover-b-ext-390.png` | 390 | 328 × 44 | détail au survol de .b-ext |
| `07-popup-on-default-hover-b-wide-390.png` | 390 | 328 × 40 | détail au survol de .b-wide |
| `07-popup-on-default-hover-b-icon-390.png` | 390 | 36 × 36 | détail au survol de .b-icon |
| `07-popup-on-default-switches-inverted-390.png` | 390 | 390 × 844 | 1 interrupteur(s) inversé(s) |
| `07-popup-on-default-360.png` | 360 | 360 × 600 |  |
| `07-popup-on-default-focus2-360.png` | 360 | 360 × 600 | focus après 2 Tab : INPUT:Fruitback on staging.acme.dev |
| `07-popup-on-default-hover-b-ext-360.png` | 360 | 328 × 44 | détail au survol de .b-ext |
| `07-popup-on-default-hover-b-wide-360.png` | 360 | 328 × 40 | détail au survol de .b-wide |
| `07-popup-on-default-hover-b-icon-360.png` | 360 | 36 × 36 | détail au survol de .b-icon |
| `07-popup-on-default-switches-inverted-360.png` | 360 | 360 × 600 | 1 interrupteur(s) inversé(s) |

## 08 — Popup, new site

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `08-popup-new-site-default-1440.png` | 1440 | 1440 × 900 |  |
| `08-popup-new-site-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : SELECT:Sakuga / Northwind |
| `08-popup-new-site-default-hover-b-ext-1440.png` | 1440 | 328 × 44 | détail au survol de .b-ext |
| `08-popup-new-site-default-hover-b-icon-1440.png` | 1440 | 36 × 36 | détail au survol de .b-icon |
| `08-popup-new-site-default-390.png` | 390 | 390 × 844 |  |
| `08-popup-new-site-default-focus2-390.png` | 390 | 390 × 844 | focus après 2 Tab : SELECT:Sakuga / Northwind |
| `08-popup-new-site-default-hover-b-ext-390.png` | 390 | 328 × 44 | détail au survol de .b-ext |
| `08-popup-new-site-default-hover-b-icon-390.png` | 390 | 36 × 36 | détail au survol de .b-icon |
| `08-popup-new-site-default-360.png` | 360 | 360 × 600 |  |
| `08-popup-new-site-default-focus2-360.png` | 360 | 360 × 600 | focus après 2 Tab : SELECT:Sakuga / Northwind |
| `08-popup-new-site-default-hover-b-ext-360.png` | 360 | 328 × 44 | détail au survol de .b-ext |
| `08-popup-new-site-default-hover-b-icon-360.png` | 360 | 36 × 36 | détail au survol de .b-icon |

## 09 — Console, Sites

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `09-console-sites-list-1440.png` | 1440 | 1440 × 900 |  |
| `09-console-sites-empty-1440.png` | 1440 | 1440 × 900 |  |
| `09-console-sites-failed-1440.png` | 1440 | 1440 × 900 |  |
| `09-console-sites-list-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : A:Sites |
| `09-console-sites-list-hover-b-accent-1440.png` | 1440 | 110 × 44 | détail au survol de .b-accent |
| `09-console-sites-list-hover-b-ghost-1440.png` | 1440 | 36 × 36 | détail au survol de .b-ghost |
| `09-console-sites-list-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `09-console-sites-list-hover-row-1440.png` | 1440 | 1022 × 68 | détail au survol de .row |
| `09-console-sites-list-390.png` | 390 | 819 × 895 (DÉBORDE) |  |
| `09-console-sites-empty-390.png` | 390 | 547 × 844 (DÉBORDE) |  |
| `09-console-sites-failed-390.png` | 390 | 547 × 844 (DÉBORDE) |  |
| `09-console-sites-list-focus2-390.png` | 390 | 819 × 895 (DÉBORDE) | focus après 2 Tab : A:Sites |
| `09-console-sites-list-hover-b-accent-390.png` | 390 | 110 × 44 | détail au survol de .b-accent |
| `09-console-sites-list-hover-b-ghost-390.png` | 390 | 36 × 36 | détail au survol de .b-ghost |
| `09-console-sites-list-hover-nav-link-390.png` | 390 | 84 × 40 | détail au survol de .nav-link |
| `09-console-sites-list-hover-row-390.png` | 390 | 860 × 68 | détail au survol de .row |

## 10 — Console, Notes

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `10-console-notes-default-1440.png` | 1440 | 1440 × 1019 |  |
| `10-console-notes-default-focus2-1440.png` | 1440 | 1440 × 1019 | focus après 2 Tab : A:Sites |
| `10-console-notes-default-hover-b-wide-1440.png` | 1440 | 92 × 32 | détail au survol de .b-wide |
| `10-console-notes-default-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `10-console-notes-default-hover-row-1440.png` | 1440 | 1093 × 81 | détail au survol de .row |
| `10-console-notes-default-hover-chip-1440.png` | 1440 | 71 × 36 | détail au survol de .chip |
| `10-console-notes-default-390.png` | 390 | 547 × 1408 (DÉBORDE) |  |
| `10-console-notes-default-focus2-390.png` | 390 | 547 × 1408 (DÉBORDE) | focus après 2 Tab : A:Sites |
| `10-console-notes-default-hover-b-wide-390.png` | 390 | 92 × 32 | détail au survol de .b-wide |
| `10-console-notes-default-hover-nav-link-390.png` | 390 | 77 × 40 | détail au survol de .nav-link |
| `10-console-notes-default-hover-row-390.png` | 390 | 960 × 104 | détail au survol de .row |
| `10-console-notes-default-hover-chip-390.png` | 390 | 71 × 36 | détail au survol de .chip |

## 11 — Console, Connectors

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `11-console-connectors-default-1440.png` | 1440 | 1440 × 902 |  |
| `11-console-connectors-default-focus2-1440.png` | 1440 | 1440 × 902 | focus après 2 Tab : A:Sites |
| `11-console-connectors-default-hover-b-wide-1440.png` | 1440 | 91 × 40 | détail au survol de .b-wide |
| `11-console-connectors-default-hover-b-danger-1440.png` | 1440 | 122 × 37 | détail au survol de .b-danger |
| `11-console-connectors-default-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `11-console-connectors-default-hover-pick-1440.png` | 1440 | 712 × 65 | détail au survol de .pick |
| `11-console-connectors-default-switches-inverted-1440.png` | 1440 | 1440 × 902 | 2 interrupteur(s) inversé(s) |
| `11-console-connectors-default-390.png` | 390 | 549 × 1929 (DÉBORDE) |  |
| `11-console-connectors-default-focus2-390.png` | 390 | 549 × 1929 (DÉBORDE) | focus après 2 Tab : A:Sites |
| `11-console-connectors-default-hover-b-wide-390.png` | 390 | 91 × 40 | détail au survol de .b-wide |
| `11-console-connectors-default-hover-b-danger-390.png` | 390 | 122 × 37 | détail au survol de .b-danger |
| `11-console-connectors-default-hover-nav-link-390.png` | 390 | 77 × 40 | détail au survol de .nav-link |
| `11-console-connectors-default-hover-pick-390.png` | 390 | 356 × 65 | détail au survol de .pick |
| `11-console-connectors-default-switches-inverted-390.png` | 390 | 549 × 1929 (DÉBORDE) | 2 interrupteur(s) inversé(s) |

## 12 — Console, Members

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `12-console-members-default-1440.png` | 1440 | 1440 × 900 |  |
| `12-console-members-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : A:Sites |
| `12-console-members-default-hover-b-accent-1440.png` | 1440 | 85 × 44 | détail au survol de .b-accent |
| `12-console-members-default-hover-b-link-1440.png` | 1440 | 50 × 36 | détail au survol de .b-link |
| `12-console-members-default-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `12-console-members-default-390.png` | 390 | 548 × 1185 (DÉBORDE) |  |
| `12-console-members-default-focus2-390.png` | 390 | 548 × 1185 (DÉBORDE) | focus après 2 Tab : A:Sites |
| `12-console-members-default-hover-b-accent-390.png` | 390 | 85 × 44 | détail au survol de .b-accent |
| `12-console-members-default-hover-b-link-390.png` | 390 | 50 × 36 | détail au survol de .b-link |
| `12-console-members-default-hover-nav-link-390.png` | 390 | 77 × 40 | détail au survol de .nav-link |

## 13 — Console, My account

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `13-console-account-default-1440.png` | 1440 | 1440 × 1035 |  |
| `13-console-account-default-focus2-1440.png` | 1440 | 1440 × 1035 | focus après 2 Tab : A:Sites |
| `13-console-account-default-hover-b-wide-1440.png` | 1440 | 114 × 40 | détail au survol de .b-wide |
| `13-console-account-default-hover-b-link-1440.png` | 1440 | 43 × 37 | détail au survol de .b-link |
| `13-console-account-default-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `13-console-account-default-390.png` | 390 | 548 × 1298 (DÉBORDE) |  |
| `13-console-account-default-focus2-390.png` | 390 | 548 × 1298 (DÉBORDE) | focus après 2 Tab : A:Sites |
| `13-console-account-default-hover-b-wide-390.png` | 390 | 114 × 40 | détail au survol de .b-wide |
| `13-console-account-default-hover-b-link-390.png` | 390 | 43 × 37 | détail au survol de .b-link |
| `13-console-account-default-hover-nav-link-390.png` | 390 | 77 × 40 | détail au survol de .nav-link |

## 14 — Widget, reading a note

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `14-widget-reading-default-1440.png` | 1440 | 1440 × 900 |  |
| `14-widget-reading-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : BUTTON:2 |
| `14-widget-reading-default-hover-b-accent-1440.png` | 1440 | 64 × 36 | détail au survol de .b-accent |
| `14-widget-reading-default-hover-b-icon-1440.png` | 1440 | 32 × 32 | détail au survol de .b-icon |
| `14-widget-reading-default-hover-pin-1440.png` | 1440 | 26 × 26 | détail au survol de .pin |
| `14-widget-reading-default-390.png` | 390 | 1440 × 900 (DÉBORDE) |  |
| `14-widget-reading-default-focus2-390.png` | 390 | 1440 × 900 (DÉBORDE) | focus après 2 Tab : BUTTON:2 |
| `14-widget-reading-default-hover-b-accent-390.png` | 390 | 64 × 36 | détail au survol de .b-accent |
| `14-widget-reading-default-hover-b-icon-390.png` | 390 | 32 × 32 | détail au survol de .b-icon |
| `14-widget-reading-default-hover-pin-390.png` | 390 | 26 × 26 | détail au survol de .pin |

## 15 — Widget, leaving a note

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `15-widget-leaving-default-1440.png` | 1440 | 1440 × 900 |  |
| `15-widget-leaving-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : TEXTAREA:What should change? |
| `15-widget-leaving-default-hover-b-accent-1440.png` | 1440 | 68 × 36 | détail au survol de .b-accent |
| `15-widget-leaving-default-hover-b-ghost-1440.png` | 1440 | 67 × 36 | détail au survol de .b-ghost |
| `15-widget-leaving-default-hover-b-icon-1440.png` | 1440 | 32 × 32 | détail au survol de .b-icon |
| `15-widget-leaving-default-390.png` | 390 | 1440 × 900 (DÉBORDE) |  |
| `15-widget-leaving-default-focus2-390.png` | 390 | 1440 × 900 (DÉBORDE) | focus après 2 Tab : TEXTAREA:What should change? |
| `15-widget-leaving-default-hover-b-accent-390.png` | 390 | 68 × 36 | détail au survol de .b-accent |
| `15-widget-leaving-default-hover-b-ghost-390.png` | 390 | 67 × 36 | détail au survol de .b-ghost |
| `15-widget-leaving-default-hover-b-icon-390.png` | 390 | 32 × 32 | détail au survol de .b-icon |

## 16 — Widget, every note of the page

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `16-widget-all-notes-default-1440.png` | 1440 | 1440 × 900 |  |
| `16-widget-all-notes-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : BUTTON:Leave feedback |
| `16-widget-all-notes-default-hover-b-accent-1440.png` | 1440 | 343 × 40 | détail au survol de .b-accent |
| `16-widget-all-notes-default-hover-b-icon-1440.png` | 1440 | 36 × 36 | détail au survol de .b-icon |
| `16-widget-all-notes-default-hover-note-1440.png` | 1440 | 363 × 84 | détail au survol de .note |
| `16-widget-all-notes-default-390.png` | 390 | 1440 × 900 (DÉBORDE) |  |
| `16-widget-all-notes-default-focus2-390.png` | 390 | 1440 × 900 (DÉBORDE) | focus après 2 Tab : BUTTON:Leave feedback |
| `16-widget-all-notes-default-hover-b-accent-390.png` | 390 | 343 × 40 | détail au survol de .b-accent |
| `16-widget-all-notes-default-hover-b-icon-390.png` | 390 | 36 × 36 | détail au survol de .b-icon |
| `16-widget-all-notes-default-hover-note-390.png` | 390 | 363 × 84 | détail au survol de .note |

## 17 — Self-hosted, instance admin

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `17-admin-instance-default-1440.png` | 1440 | 1440 × 1384 |  |
| `17-admin-instance-default-focus2-1440.png` | 1440 | 1440 × 1384 | focus après 2 Tab : A:Workspaces |
| `17-admin-instance-default-hover-b-accent-1440.png` | 1440 | 147 × 44 | détail au survol de .b-accent |
| `17-admin-instance-default-hover-b-wide-1440.png` | 1440 | 141 × 40 | détail au survol de .b-wide |
| `17-admin-instance-default-hover-b-link-1440.png` | 1440 | 61 × 37 | détail au survol de .b-link |
| `17-admin-instance-default-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `17-admin-instance-default-switches-inverted-1440.png` | 1440 | 1440 × 1384 | 2 interrupteur(s) inversé(s) |
| `17-admin-instance-default-390.png` | 390 | 579 × 2007 (DÉBORDE) |  |
| `17-admin-instance-default-focus2-390.png` | 390 | 579 × 2007 (DÉBORDE) | focus après 2 Tab : A:Workspaces |
| `17-admin-instance-default-hover-b-accent-390.png` | 390 | 147 × 44 | détail au survol de .b-accent |
| `17-admin-instance-default-hover-b-wide-390.png` | 390 | 141 × 40 | détail au survol de .b-wide |
| `17-admin-instance-default-hover-b-link-390.png` | 390 | 61 × 37 | détail au survol de .b-link |
| `17-admin-instance-default-hover-nav-link-390.png` | 390 | 127 × 40 | détail au survol de .nav-link |
| `17-admin-instance-default-switches-inverted-390.png` | 390 | 579 × 2007 (DÉBORDE) | 2 interrupteur(s) inversé(s) |

## 18 — Admin, workspaces

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `18-admin-workspaces-default-1440.png` | 1440 | 1440 × 900 |  |
| `18-admin-workspaces-default-focus2-1440.png` | 1440 | 1440 × 900 | focus après 2 Tab : A:Workspaces |
| `18-admin-workspaces-default-hover-b-accent-1440.png` | 1440 | 151 × 44 | détail au survol de .b-accent |
| `18-admin-workspaces-default-hover-b-wide-1440.png` | 1440 | 143 × 40 | détail au survol de .b-wide |
| `18-admin-workspaces-default-hover-b-link-1440.png` | 1440 | 146 × 37 | détail au survol de .b-link |
| `18-admin-workspaces-default-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `18-admin-workspaces-default-hover-row-1440.png` | 1440 | 723 × 68 | détail au survol de .row |
| `18-admin-workspaces-default-390.png` | 390 | 580 × 1436 (DÉBORDE) |  |
| `18-admin-workspaces-default-focus2-390.png` | 390 | 580 × 1436 (DÉBORDE) | focus après 2 Tab : A:Workspaces |
| `18-admin-workspaces-default-hover-b-accent-390.png` | 390 | 151 × 44 | détail au survol de .b-accent |
| `18-admin-workspaces-default-hover-b-wide-390.png` | 390 | 143 × 40 | détail au survol de .b-wide |
| `18-admin-workspaces-default-hover-b-link-390.png` | 390 | 146 × 37 | détail au survol de .b-link |
| `18-admin-workspaces-default-hover-nav-link-390.png` | 390 | 101 × 40 | détail au survol de .nav-link |
| `18-admin-workspaces-default-hover-row-390.png` | 390 | 680 × 68 | détail au survol de .row |

## 19 — Admin, users

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `19-admin-users-default-1440.png` | 1440 | 1440 × 903 |  |
| `19-admin-users-default-focus2-1440.png` | 1440 | 1440 × 903 | focus après 2 Tab : A:Workspaces |
| `19-admin-users-default-hover-b-accent-1440.png` | 1440 | 146 × 44 | détail au survol de .b-accent |
| `19-admin-users-default-hover-b-wide-1440.png` | 1440 | 133 × 40 | détail au survol de .b-wide |
| `19-admin-users-default-hover-b-link-1440.png` | 1440 | 133 × 33 | détail au survol de .b-link |
| `19-admin-users-default-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `19-admin-users-default-switches-inverted-1440.png` | 1440 | 1440 × 903 | 1 interrupteur(s) inversé(s) |
| `19-admin-users-default-390.png` | 390 | 578 × 1770 (DÉBORDE) |  |
| `19-admin-users-default-focus2-390.png` | 390 | 578 × 1770 (DÉBORDE) | focus après 2 Tab : A:Workspaces |
| `19-admin-users-default-hover-b-accent-390.png` | 390 | 146 × 44 | détail au survol de .b-accent |
| `19-admin-users-default-hover-b-wide-390.png` | 390 | 133 × 40 | détail au survol de .b-wide |
| `19-admin-users-default-hover-b-link-390.png` | 390 | 133 × 33 | détail au survol de .b-link |
| `19-admin-users-default-hover-nav-link-390.png` | 390 | 101 × 40 | détail au survol de .nav-link |
| `19-admin-users-default-switches-inverted-390.png` | 390 | 578 × 1770 (DÉBORDE) | 1 interrupteur(s) inversé(s) |

## 20 — Admin, notes and where they went

| Fichier | Largeur de vue | Largeur × hauteur du document | Note |
|---|---|---|---|
| `20-admin-notes-default-1440.png` | 1440 | 1440 × 1059 |  |
| `20-admin-notes-default-focus2-1440.png` | 1440 | 1440 × 1059 | focus après 2 Tab : A:Workspaces |
| `20-admin-notes-default-hover-b-wide-1440.png` | 1440 | 92 × 32 | détail au survol de .b-wide |
| `20-admin-notes-default-hover-nav-link-1440.png` | 1440 | 225 × 40 | détail au survol de .nav-link |
| `20-admin-notes-default-hover-row-1440.png` | 1440 | 1093 × 104 | détail au survol de .row |
| `20-admin-notes-default-hover-chip-1440.png` | 1440 | 79 × 36 | détail au survol de .chip |
| `20-admin-notes-default-390.png` | 390 | 578 × 1385 (DÉBORDE) |  |
| `20-admin-notes-default-focus2-390.png` | 390 | 578 × 1385 (DÉBORDE) | focus après 2 Tab : A:Workspaces |
| `20-admin-notes-default-hover-b-wide-390.png` | 390 | 92 × 32 | détail au survol de .b-wide |
| `20-admin-notes-default-hover-nav-link-390.png` | 390 | 101 × 40 | détail au survol de .nav-link |
| `20-admin-notes-default-hover-row-390.png` | 390 | 980 × 104 | détail au survol de .row |
| `20-admin-notes-default-hover-chip-390.png` | 390 | 79 × 36 | détail au survol de .chip |
