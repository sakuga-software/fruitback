# « Fruitback, simpler flow » : inventaire de la maquette du 2026-10-13

Rédigé par l'agent fru-maquette pour l'orchestrateur. Rien ici n'est estimé à l'œil : chaque valeur vient du code de la maquette déballée (`screens/*.html`, styles en ligne et feuille `<style>` de chaque écran) ou d'une mesure dans Chromium (`measures.json`). Quand une chose n'est pas dans la maquette, c'est écrit « non dessiné ».

- Source : `source/simpler-flow.html` (2 116 380 octets, sha256 `478717a9eef53360b443bd4f01cf2ec337c7b2e247a16e523bd638a47ce46fb2`).
- Déballé, dans le dépôt : `screens/NN-*.html` (le gabarit lisible de chaque écran : c'est le fichier à lire), `assets/` (les 2 logos SVG), `measures.json` (contrastes et boîtes mesurés dans Chromium). Le reste du déballage n'est pas dans le dépôt et se refait avec `tools/` à partir de la source : la planche, les 20 sous-bundles, le moteur de gabarit, React et ReactDOM 18.3.1, et le DOM rendu de chaque état.
- Captures : `shots/` et `shots/INDEX.md` (250 PNG).
- Textes mot pour mot, état par état : `SPEC-annexe-textes.md` (1 600 lignes, généré).

## 0. Ce qu'est le fichier

Un bundle autonome : une planche (« board ») de 20 `<iframe>`, chacune un sous-bundle qui embarque React 18.3.1, ReactDOM et un petit moteur de gabarits (« dc-runtime » : `<x-dc>`, `<sc-if>`, `<sc-for>`, `{{ }}`). Chaque écran est un gabarit HTML à styles en ligne, plus une classe `Component` qui calcule des valeurs d'exemple.

- **Réseau** : rendu hors ligne, toute requête autre que `file:`/`blob:`/`data:` bloquée : **0 requête sortante tentée, 0 erreur ni avertissement de console** (mesuré sur les 20 écrans, 3 largeurs). Les seules URL externes sont des `href` de liens (`https://fruitback.com`, `https://fruitback.com/self-hosting.html`, `https://chromewebstore.google.com`, `https://addons.mozilla.org`, `https://staging.acme.dev`) et les identifiants d'origine de React (jsdelivr), embarqués.
- **Consignes adressées à un agent** : aucune trouvée dans les gabarits, les scripts d'écran ni les SVG (lus en entier). Le moteur porte des commentaires de son auteur (protocole `postMessage` entre cadres), sans rapport avec nous.
- **Interactivité** : aucune. Pas un seul gestionnaire d'événement. Les états sont des propriétés énumérées (`step`, `state`). Les liens entre écrans sont des `href` vers des noms de fichiers (`Sites.dc.html`, `Notes.dc.html`, `Connectors.dc.html`, `Members.dc.html`, `Account.dc.html`, `Sign-in.dc.html`, `Main.dc.html`, `Widget-thread.dc.html`, `Admin.dc.html`, `Admin-workspaces.dc.html`, `Admin-users.dc.html`, `Admin-notes.dc.html`) : ils donnent la carte du parcours.
- **Thème sombre** : aucun (rendu `prefers-color-scheme: dark` identique au pixel au rendu clair, mesuré sur les 20 écrans). **Langue** : anglais seulement (`<html lang="en">`) ; l'écran « My account » propose pourtant « English / Français ».
- **Mouvement** : deux transitions et une animation en tout (§ 1.7).

### Les 20 écrans et leurs états (32 états)

| N° | Titre sur la planche | `<title>` | Taille de dessin | États (propriété) |
|---|---|---|---|---|
| 01 | Setup, one screen | Set up Fruitback | 1440 × 1060 | `step` : `email`, `sent`, `site`, `install` (défaut du script), `first-note` |
| 02 | Sign in | Sign in to Fruitback | 1440 × 900 | `state` : `sign-in`, `sent`, `link-opened`, `expired` |
| 03 | Invitation | Join Sakuga on Fruitback | 1440 × 900 | `state` : `invitation`, `joined` |
| 04 | Connect this browser | Connect this browser | 1440 × 900 | `state` : `ask`, `signed-out`, `connected` |
| 05 | Popup, signed out | Fruitback popup, signed out | 360 × 420 | un seul |
| 06 | Popup, site in workspace | Fruitback popup, site in your workspace | 360 × 420 | un seul |
| 07 | Popup, on | Fruitback popup, on | 360 × 540 | un seul (+ interrupteur) |
| 08 | Popup, new site | Fruitback popup, new site | 360 × 500 | un seul |
| 09 | Console, Sites | Sites, Sakuga | 1440 × 1000 | `state` : `list`, `empty`, `failed` |
| 10 | Console, Notes | Notes, Sakuga | 1440 × 1060 | un seul |
| 11 | Console, Connectors | Connectors, Sakuga | 1440 × 1000 | un seul (Linear sélectionné) |
| 12 | Console, Members | Members, Sakuga | 1440 × 1000 | un seul |
| 13 | Console, My account | My account, Fruitback | 1440 × 1040 | un seul |
| 14 | Widget, reading a note | Widget, reading a note | 1440 × 900 (scène fixe) | un seul |
| 15 | Widget, leaving a note | Widget, leaving a note | 1440 × 900 (scène fixe) | un seul |
| 16 | Widget, every note of the page | Widget, every note of the page | 1440 × 900 (scène fixe) | un seul |
| 17 | Self-hosted, instance admin | Instance, Fruitback self-hosted | 1440 × 1420 | un seul |
| 18 | Admin, workspaces | Workspaces, instance admin | 1440 × 1000 | un seul (« Acme support » sélectionné) |
| 19 | Admin, users | Users, instance admin | 1440 × 1040 | un seul (« Hugo Petit » sélectionné) |
| 20 | Admin, notes and where they went | Notes, instance admin | 1440 × 1060 | un seul |

États **non dessinés** (à inventer par le ticket, voir § 5) : tout chargement (aucun squelette, aucun indicateur) ; les erreurs de formulaire (adresse e-mail invalide, site refusé, envoi échoué) ; les menus (`aria-haspopup="menu"` du sélecteur de workspace et du « … » d'une ligne de site) ; « Rename » et « Change » de la mise en place ; les états vides de Notes, Connectors (aucun connecté), Members, Admin ; les panneaux GitHub Issues / REST API / « Connect » d'une source ; le popup sur une page où l'extension ne peut pas agir, le popup hors ligne, le popup éteint sur un site activé ; le widget pour un visiteur sans compte (le composer dessiné dit « As Mathieu, Sakuga ») ; le widget à 390 px ; les onglets « Done » et « All » de la liste ; tout e-mail (lien de connexion, invitation) ; l'écran d'une instance sans e-mail ni OAuth ; la création du premier admin d'une instance.

## 1. Jetons et composants partagés (valeurs de la maquette)

### 1.1 Couleurs

| Rôle | Valeur | Où |
|---|---|---|
| Encre (texte, bouton sombre, rail) | `#18181b` | partout |
| Texte secondaire | `#6b6b74` | sous-titres, aides, en-têtes de table, placeholders |
| Texte tertiaire | `#52525b` | onglets inactifs du widget, colonne « Signs in with », code du composant |
| Fond | `#ffffff` | pages, cartes, champs |
| Fond discret | `#fafafa` | panneaux latéraux, bloc « Check your inbox », `pre`, survol d'une ligne, état vide |
| Fond enfoncé / sélection | `#f4f4f5` | ligne sélectionnée, survol des boutons icône, rail d'onglets du widget |
| Filet | `#e4e4e7` | bordures de cartes, séparateurs |
| Bordure de contrôle | `#8a8a93` | champs, listes, boutons secondaires, interrupteur éteint |
| Accent | `#dd2c27` | bouton principal, anneau de focus, curseur de saisie, statut New, alertes |
| Accent survolé / enfoncé | `#b91c1c` | survol du bouton principal et des liens, « Leave feedback » actif |
| Accent sur fond sombre | `#ec5b57` | point de l'entrée active du rail, focus dans le rail, logo du rail |
| Rail | fond `#18181b`, entrée active `#27272a`, texte `#d4d4d8`, texte discret `#a1a1aa`, bordure de pastille `#52525b` | console et admin |
| Avatar | `#3f3f46` sur blanc, initiale `#ffffff` | membres, popup, invitation |
| Statuts | New `#dd2c27`, To do `#2563eb`, In progress `#f59e0b` (chiffre `#18181b` dessus), Done `#15803d`, Closed `#64748b` | pins, barres, listes |
| Succès | `#15803d` | « Connected », « Answering », « Active », pastille d'étape faite |
| Note non placée | `#d97706` (contour pointillé) | liste du widget |
| Logo | `#1c1917` + `#dd2c27` (clair), `#ffffff` + `#ec5b57` (sur rail) | `assets/3e4b…svg`, `7878…svg` |
| Sélection de texte | fond `#18181b`, texte `#fff` | `::selection` |

La scène « Acme Outdoor » (`#f6f6f3`, `#2f4a3a`, `#22302a`, `#dfe6df`, `#3d5c49`, Georgia…) est un site d'exemple, **pas** du Fruitback : rien à en reprendre, sauf dans l'aperçu de la mise en place (§ 2.1).

### 1.2 Typographie

- Famille : `-apple-system, system-ui, sans-serif` (console, widget) ; `system-ui, -apple-system, 'Segoe UI', sans-serif` (popup) ; mono `ui-monospace, SFMono-Regular, Menlo, monospace`. `-webkit-font-smoothing: antialiased`. Chiffres : classe `.num` = `font-variant-numeric: tabular-nums`.
- Échelle (taille / interligne / graisse / approche) : titre de page `28px / 1.15 / 700 / -0.02em` (mise en place : `30px`) ; chapeau `16px / 1.5`, `#6b6b74` ; titre de section `18px / 700` ; titre d'étape `17px / 26px / 600` ; titre de bloc `15px / 600` ou `14px / 600` ; conclusion « Your first note is in » `22px / 1.25 / 700 / -0.01em` ; titre de popup `18px / 1.3 / 700 / -0.01em` ; corps `15px / 1.5` et `14px / 1.5` (tables `14px / 1.45`) ; petit `13px` ; très petit `12px`, `11px` ; mot de vérification `22px / 700 / 0.08em` mono.
- Graisses utilisées : 400, 600, 700 seulement. Approche des boutons principaux : `-0.006em`.

### 1.3 Rayons, ombres, espacements

- Rayons : `6px` (boutons secondaires, `pre`, `code`) ; `8px` (champs, listes déroulantes, boutons icône, pastille de workspace) ; `10px` (cartes d'option, entrées du rail, boutons du popup, bloc sombre) ; `14px` (tables, panneaux, bulles du widget, cadre d'aperçu) ; `999px` (boutons principaux, puces de filtre, avatars, barres) ; pin : `border-radius: 50% 50% 50% 0` + `transform: rotate(-90deg)` (contenu contre-tourné de `90deg`).
- Ombres : pin `0 3px 10px rgba(24,24,27,.28)` ; boutons flottants du widget `0 4px 18px rgba(0,0,0,.25)` ; bulle, liste et infobulle `0 10px 30px rgba(0,0,0,.18)` ; cadre d'aperçu `0 10px 30px rgba(24,24,27,.08)` ; composer `0 14px 40px rgba(24,24,27,.22)` ; onglet actif `0 1px 3px rgba(24,24,27,.12)` ; bouton d'interrupteur `0 1px 3px rgba(0,0,0,.25)`.
- Hauteurs de contrôle : `44px` (champs et boutons de page), `40px` (filtres, boutons de panneau), `36px` (puces, boutons de bulle, boutons icône), `32px` (« Send again », fermer, onglets).
- Pas d'espacement récurrents : 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 72 px (pas de grille stricte de 4).

### 1.4 Composants

| Composant | Valeurs exactes |
|---|---|
| Bouton principal (`.b-accent`) | `height: 44px; padding: 0 22px; border: 0; border-radius: 999px; background: #dd2c27; color: #fff; font-size: 14px; font-weight: 600; letter-spacing: -0.006em`. Survol : fond `#b91c1c`. Variantes : `padding 0 24px/26px` ; pleine largeur dans les colonnes étroites ; `36px` + `13px` dans le widget. |
| Bouton secondaire (`.b-wide`) | `height: 44px; padding: 0 18px (ou 16/14); border: 1px solid #8a8a93; border-radius: 6px; background: #fff; color: #18181b; 14px/600`. Survol : fond `#fafafa`, bordure `#18181b`. Tailles `40px` et `32px` (`13px`). |
| Bouton lien (`.b-link`) | `border: 0; background: none; padding: 8–12px 0; 14px/600; color: #18181b; text-decoration: underline; text-underline-offset: 3px`. Survol : `#b91c1c`. `.b-danger` : identique. |
| Bouton icône (`.b-icon`, `.b-ghost`) | `36 × 36` (ou `32 × 32`), `border-radius: 8px` (popup : `10px`), icône `15–18px`, couleur `#6b6b74`. Survol : fond `#f4f4f5`. |
| Bouton du popup (`.b-ext`) | `height: 44px; border-radius: 10px; background: #dd2c27; color: #fff; 14px/600`, pleine largeur. Survol `#b91c1c`. |
| Désactivé | `opacity: .5; cursor: not-allowed`. |
| Champ | `height: 44px; border: 1px solid #8a8a93; border-radius: 8px; padding: 0 14px; font-size: 15px; background: #fff`. Compact : `40px`, `padding 0 12px`, `14px`. Étiquette au-dessus : `13px/600`, `gap: 6px`. Aide dessous : `13px`, `#6b6b74`. Verrouillé : bordure `#e4e4e7`, fond `#fafafa`, texte `#52525b`. `::placeholder` `#6b6b74` ; `caret-color: #dd2c27`. |
| Liste déroulante | `<select>` natif, mêmes bordure, rayon et hauteurs que le champ. |
| Case / radio | natifs, `16 × 16`, `accent-color: #18181b`. Carte radio : `padding: 14px 16px; border-radius: 10px; border: 1px solid #18181b` (choisie) ou `#e4e4e7`. |
| Interrupteur (`.switch`) | `<input type="checkbox" role="switch">`, `40 × 24`, `border-radius: 999px`, éteint `#8a8a93`, allumé `#18181b` ; pastille `18 × 18` blanche à `3px`, `translateX(16px)` allumé. |
| Pin | `26 × 26` (page), `24` (liste), `11/10/9` (puces de légende), forme de goutte (§ 1.3), chiffre `13px/600`. |
| Barre de statuts | `height: 8px; border-radius: 999px; gap: 2px`, segments en `flex: <nombre>`, `role="img"` + `aria-label` chiffré. Largeur `128px` (Sites), `96px` avec fond `#f4f4f5` (Admin), pleine largeur (popup). |
| Puce de filtre (`.chip`) | `height: 36px; padding: 0 14px; border-radius: 999px; 13px/600`, compteur en 400. Repos : bordure `#8a8a93`, fond blanc. Enfoncée (`aria-pressed="true"`) : fond et bordure `#18181b`, texte blanc, compteur `#d4d4d8`. Alerte : texte `#dd2c27`. Survol : bordure `#18181b`. |
| Table | conteneur `border: 1px solid #e4e4e7; border-radius: 14px; overflow-x: auto` ; `<table>` `min-width` propre à l'écran ; en-têtes `13px/600 #6b6b74`, `padding: 12px 16px` (bords `20px`) ; cellules `padding: 14px 16px` ; filet `#e4e4e7` ; survol de ligne `#fafafa`. |
| Panneau latéral | `flex: 1 1 340px; border: 1px solid #e4e4e7; border-radius: 14px; background: #fafafa` ; tête et corps `padding: 20px 22px` ; pied `14px 22px`. |
| Rail | `<aside class="rail">` `flex: 1 1 248px; padding: 16px 12px; background: #18181b; gap: 20px`. Entrée : `min-height: 40px; border-radius: 10px; font-size: 15px` ; inactive `padding: 0 12px 0 31px; color: #d4d4d8` ; active `padding: 0 12px; background: #27272a; color: #fff; font-weight: 600` précédée d'une goutte `9 × 9` `#ec5b57`. Survol : fond `#27272a`, texte blanc. Pied : lien `14px` + logo `82 × 16`. |
| En-tête des pages hors console | `border-bottom: 1px solid #e4e4e7` ; contenu `max-width: 1280px; padding: 0 clamp(16px, 4vw, 32px); min-height: 64px` ; logo `113 × 22`, lien vers `https://fruitback.com`. |
| Page centrée (02, 03, 04) | `main` `padding: clamp(48px, 10vh, 112px) 16px 64px` ; colonne `max-width: 400px` (02) ou `440px` (03, 04). |
| Pastille de réussite | goutte `40 × 40` `#15803d`, coche blanche `18px` (`stroke-width: 3`), ombre du pin. |
| Liste clé/valeur | `<dl>` : lignes `padding: 12px 0`, filet `#e4e4e7`, `dt` `#6b6b74`, `dd` `600` aligné à droite, `15px`. |

### 1.5 Focus et accessibilité visibles

- `:focus-visible { outline: 2px solid #dd2c27; outline-offset: 2px }` partout ; dans le rail `outline-color: #ec5b57`. Captures `*-focus2-*`.
- Structure : un `h1` par écran ; `aria-labelledby` sur les sections ; `aria-current="page"` dans le rail ; `role="status"` sur les confirmations ; `role="alert"` sur l'échec de chargement et les notes non livrées ; `role="switch"`, `role="tablist"/"tab"/"tabpanel"`, `role="dialog"` (bulle d'une note), `role="group"` (filtres), `aria-pressed` (puces, connecteur choisi), `aria-expanded` (pin ouvert), `aria-haspopup="menu"` ; étiquettes masquées (`.sr-only` et équivalent en ligne) sur les recherches et filtres ; « Current step: » masqué devant l'étape en cours.
- **Contrastes mesurés** (texte sur fond effectif, toutes paires dans `measures.json`) : texte secondaire `#6b6b74` sur blanc **5,28:1**, sur `#fafafa` 5,05, sur `#f4f4f5` 4,80 ; blanc sur accent `#dd2c27` **4,70** ; accent sur blanc 4,70 ; `#15803d` sur blanc 5,02, sur `#f4f4f5` 4,56 ; blanc sur `#2563eb` 5,17 ; `#18181b` sur `#f59e0b` 8,25 ; `#a1a1aa` sur rail 6,91 ; `#d4d4d8` sur rail 11,99. **Deux paires sous 4,5:1** : `#dd2c27` sur `#f4f4f5` = **4,28** (« 2 notes not delivered », 13px/600, dans la ligne sélectionnée de l'admin Workspaces ; « Suspended », 14px/600, ligne sélectionnée de l'admin Users). `#dd2c27` sur `#fafafa` = 4,51 (limite). Non mesuré : les textes désactivés (`opacity .5`), exemptés par WCAG.
- Contrastes non textuels (calculés) : bordure de contrôle `#8a8a93` sur blanc 3,42:1 (au-dessus des 3:1 de WCAG 1.4.11) ; filet `#e4e4e7` 1,27:1 (décoratif) ; anneau de focus `#dd2c27` sur blanc 4,70, `#ec5b57` sur le rail 5,23 et sur l'entrée active `#27272a` 4,40 ; **statut « In progress » `#f59e0b` sur blanc 2,15:1**, sous 3:1 : la couleur ne porte jamais seule l'information (libellé, chiffre ou `aria-label` à côté, partout dans la maquette), à conserver dans chaque ticket.
- Cibles : boutons de page 44 px ; boutons lien de 8–12 px de marge verticale (hauteur de 36 à 45 px) ; « Rename » et « Change » de la mise en place ont `padding: 0` (hauteur d'une ligne de texte, ~21 px) : sous 24 px.

### 1.6 Règles responsive (lues dans le CSS)

- Aucune grille à points de rupture : tout passe par `flex-wrap` et des bases (`flex: 1 1 248px` pour le rail, `flex: 999 1 640px` pour le contenu ; `flex: 1 1 400px` / `flex: 999 1 520px` pour la mise en place), des `clamp()` de marge et des `repeat(auto-fit, minmax(min(Npx, 100%), 1fr))`.
- **Une seule requête média**, sur les écrans à rail : `@media (max-width: 900px) { .rail-nav { flex-direction: row; overflow-x: auto } .rail-foot { display: none !important } }`. Sous 888 px (248 + 640) le rail passe déjà au-dessus du contenu par retour à la ligne.
- Tables : défilement horizontal dans leur conteneur (`min-width` : Sites 860, Notes 960, Members 760, Admin 620/680/700/980).
- **Défaut de la maquette, mesuré à 390 px** : les écrans à rail débordent de la fenêtre (document de 547 à 580 px ; 819 px pour Sites en liste), parce que la rangée d'onglets du rail ne se réduit pas (`min-width` automatique d'un enfant flex). À ne pas reproduire : le produit actuel a déjà été corrigé sur ce point (FRU-159).
- Popups : boîte fixe `360px` × (420 / 500 / 540). Widget : scène fixe `1440 × 900`, aucune règle mobile.

### 1.7 Mouvement

- Interrupteur : pastille `transition: transform .22s cubic-bezier(.16,1,.3,1)` ; fond `transition: background .2s` (présent dans le popup 07 seulement, absent des écrans 11, 17 et 19 : incohérence).
- Composer du widget : `@keyframes rise { from { transform: translateY(6px) scale(.96) } to { transform: none } }`, `animation: rise .42s cubic-bezier(.16,1,.3,1) both; transform-origin: bottom left` ; `@media (prefers-reduced-motion: reduce) { .composer { animation: none } }`.
- Survols : changement immédiat (aucune transition) ; pin `filter: brightness(1.06)`.

## 2. Écran par écran

Les textes complets de chaque état sont dans `SPEC-annexe-textes.md` ; ici, la structure, les valeurs propres à l'écran et les textes qui portent le parcours.

### 2.1 — 01 « Setup, one screen » (console, hors rail)

- **Surface** : `apps/console`, page publique d'inscription + mise en place. **Parcours** : arrivée depuis fruitback.com ou « Set up a workspace » de l'écran de connexion → `email` → `sent` → (clic du lien, la page « carries on by itself ») → `site` → `install` → `first-note` → « Open the console » (Sites) ou « Connect a tracker » (Connectors).
- **Mise en page** : en-tête (§ 1.4) avec à droite « Running your own server? » + lien « Self-hosting guide » (`14px`, `#6b6b74`). `main` `max-width: 1280px; padding: 48px clamp(16px,4vw,32px) 72px; display: flex; flex-wrap: wrap; gap: 56px`. Colonne de gauche `flex: 1 1 400px; max-width: 540px` ; colonne d'aperçu `flex: 999 1 520px`.
- **Titre** : `h1` « Set up Fruitback » (`30px/1.15/700/-0.02em`, `text-wrap: balance`) ; chapeau « Three steps to your first note on a live page. Hosted in Europe. » (`margin-bottom: 36px`).
- **Liste des étapes** (`<ol>`, chaque `<li>` : `grid-template-columns: 32px minmax(0,1fr); column-gap: 16px`) : pastille goutte `26 × 26` — en cours : fond `#18181b`, chiffre blanc `12px/700` ; à venir : fond blanc, bordure `1.5px solid #8a8a93`, chiffre `#6b6b74` ; faite : fond `#15803d`, coche blanche `13px`. Trait vertical `2px` `#e4e4e7`, `min-height: 24px`, sous les pastilles 1 et 2. Corps de l'étape `padding-bottom: 32px`.
- **Étape 1 « Your account »**
  - `email` : « We send you a sign-in link. No password to make up. » ; champ « Work email » (placeholder `you@studio.com`, `autocomplete="email"`) + bouton principal « Email me a link » sur une ligne (`flex-wrap`, champ `flex: 1 1 240px`) ; aide « Your workspace takes the name of your domain. Rename it whenever you like. » ; séparateur « or » ; « Continue with Google », « Continue with GitHub » (secondaires `44px`, grille `auto-fit minmax(min(180px,100%),1fr)`, `gap: 10px`).
  - `sent` : bloc `role="status"` (`padding: 18px 20px; border: 1px solid #e4e4e7; border-radius: 10px; background: #fafafa; gap: 10px`) : « Check your inbox » (`15px/600`) ; « A sign-in link is on its way to **mathieu@sakuga.dev**. Open it in this browser: this page carries on by itself. » ; « The link works once, for fifteen minutes. Nothing in it asks for a password. » (`13px`) ; bouton secondaire désactivé `40px` « Send again in 0:41 » ; lien « Use another address ».
  - faite : « Signed in as **mathieu@sakuga.dev** » ; « Workspace **Sakuga** » + lien « Rename ».
- **Étape 2 « Your site »**
  - à venir : « The address you review. » (`14px`).
  - `site` : champ « Site address » (placeholder `staging.acme.dev`, `inputmode="url"`) + aide « Any page of it will do. A pattern such as *.preview.acme.dev covers every preview build. » ; `fieldset` « Who sees the notes? » : carte radio choisie « Members of Sakuga » / « Visitors of the site see nothing. Right for staging and for a client's site. » ; carte « Everyone who visits » / « A public way to report a problem on a live site. » ; bouton « Add site ». `gap: 20px`.
  - faite : « staging.acme.dev » (`600`) ; « Members of Sakuga see the notes » + lien « Change ».
- **Étape 3 « Put it on the site »**
  - à venir : « The extension, or a script tag. »
  - `install` : « Use one, or both. » ; deux cartes (`padding: 18px; border: 1px solid #e4e4e7; border-radius: 10px; gap: 8px`, grille `auto-fit minmax(min(230px,100%),1fr)`, `gap: 12px`) : **« Browser extension »** — « Nothing to deploy. Right for a client's site you cannot touch. » / « Signs in with this account. No code to type. » / lien-bouton « Add to Chrome » + flèche (vers le Chrome Web Store) ; **« Script tag »** — « Before the closing body tag. Members see their pins on every visit. » / `<pre>` (`12px/1.55` mono, fond `#fafafa`, `overflow-x: auto`) :
    ```
    <script
      src="https://cloud.fruitback.com/fruitback.iife.js"
      data-fruitback-client="st_7k2m9q"
      defer></script>
    ```
    / bouton « Copy script ». Puis `role="status"` : « **Waiting for your first note.** Open the site, click Leave feedback, then any part of the page. » + lien « Open staging.acme.dev ».
  - `first-note` (faite) : « Extension on in Chrome » / « First note received just now ».
- **Conclusion** (`first-note`) : filet, `h2` « Your first note is in » ; « It waits in the Sakuga workspace. Send your notes to Linear, GitHub or your own API whenever you like. » ; bouton principal « Open the console » ; secondaire « Connect a tracker ».
- **Aperçu** (`aria-label="Preview of your site"`) : cadre `border-radius: 14px`, barre `44px` `#fafafa` (trois points `10px` `#e4e4e7`, pastille d'adresse `13px` : « your site » puis « staging.acme.dev »), zone `height: 620px`. Avant l'étape 3 : fond `#fafafa`, goutte grise `56 × 68`, « Your site shows here once you add it, with its pins. ». À partir de `install` : une **fausse page** « Acme Outdoor » + les deux boutons flottants du widget (réglages `36px` `#3f3f46`, « Leave feedback » `40px`) ; à `install` une infobulle sombre « Click Leave feedback, then any part of the page. » ; à `first-note` un pin rouge « 1 » sur le titre et une carte de note (« New », « The headline runs to three lines on a phone. Could it be shorter? », « Mathieu · just now »). Légende : « A preview of your site. Pins show the same way on the real page. »
- **Responsive** : à 390 px les deux colonnes s'empilent, l'aperçu passe dessous (hauteur de document 1 569 à 1 935 px), l'en-tête passe sur deux lignes. Pas de débordement horizontal (mesuré).

### 2.2 — 02 « Sign in » (console)

- **Surface** : `apps/console`, écran de connexion. **Parcours** : `sign-in` → `sent` → le lien s'ouvre dans un autre onglet → `link-opened` (dans l'onglet du lien) pendant que l'onglet d'origine continue seul ; lien périmé → `expired`. « New to Fruitback? Set up a workspace » mène à 01.
- Colonne `max-width: 400px`. `h1` `28px`.
- `sign-in` : « Sign in to Fruitback » ; « We email you a link that signs you in on this browser. » ; « Work email » ; « Email me a link » (pleine largeur) ; « or » (`margin: 22px 0`) ; « Continue with Google », « Continue with GitHub » (empilés, `gap: 10px`) ; « New to Fruitback? Set up a workspace ».
- `sent` : « Check your inbox » ; `role="status"` « A sign-in link is on its way to **mathieu@sakuga.dev**. » ; « Open it in this browser and this tab signs in by itself. The link works once, for fifteen minutes. » ; « Send again in 0:41 » (désactivé, `44px`) ; « Use another address ».
- `link-opened` : pastille de réussite ; « You are signed in » ; « Your other Fruitback tab has carried on without you. You can close this one. » ; secondaire « Continue in this tab ».
- `expired` : « This link no longer works » ; « A link works once, for fifteen minutes. This one was already used or ran out of time. » ; « Work email » ; « Send me a new link ».

### 2.3 — 03 « Invitation » (console)

- **Parcours** : l'invité ouvre le lien de l'e-mail d'invitation, **qui l'a déjà connecté** (« The link in the invitation signed you in. ») → `invitation` → « Join Sakuga » → `joined` → « Add to Chrome » ou « Open staging.acme.dev ».
- Colonne `max-width: 440px`.
- `invitation` : ligne d'origine (avatar `28px` « M », « **Mathieu** from Sakuga invited you ») ; `h1` « Review staging.acme.dev with Sakuga » ; « You join as a guest: you see and leave notes on this site only. Guests are free and never see the tracker. » ; liste clé/valeur : « Signed in as » `camille@acme.dev`, « Role » `Guest`, « Site » `staging.acme.dev` ; bouton principal « Join Sakuga » (pleine largeur) ; « The link in the invitation signed you in. Not camille@acme.dev? Use another address ».
- `joined` : pastille de réussite ; « You are in » ; « One more thing: the extension shows the notes on staging.acme.dev and lets you leave yours. It signs in with this account. » ; bouton principal « Add to Chrome » + flèche ; lien « Open staging.acme.dev » ; sous filet « Using Firefox? Get the Firefox add-on ».

### 2.4 — 04 « Connect this browser » (console)

- **Parcours** : ouvert par l'extension (« Sign in to Fruitback » du popup 05) dans un onglet. Connecté → `ask` → « Connect Chrome » → `connected` (« You can close this tab. ») ; non connecté → `signed-out` → lien e-mail → retour sur `ask`/`connected` « in the same move ».
- `ask` : `h1` « Connect this browser » ; « The Fruitback extension asks to sign in as you. It reads and leaves notes on the sites of your workspaces, and nothing else. » ; bloc sombre (`padding: 18px 20px; border-radius: 10px; background: #18181b`) : « Check that the popup shows the same word » (`14px`, `#d4d4d8`, `max-width: 220px`) et le mot « PLUM 47 » (mono `22px/700/0.08em`) ; liste : « Account » `mathieu@sakuga.dev`, « Browser » `Chrome on macOS`, « Workspaces » `Sakuga, Northwind` ; « Connect Chrome » (principal, `padding 0 26px`) ; lien « Not now » ; « You can disconnect it at any time from My account. » (`13px`).
- `signed-out` : « Sign in to connect this browser » ; « The Fruitback extension in Chrome is waiting. Sign in, and it connects in the same move. » ; « Work email » ; « Email me a link » ; « Or continue with Google or GitHub ».
- `connected` : pastille ; « Chrome is connected » ; « Open the popup on any site of Sakuga or Northwind. You can close this tab. ».

### 2.5 — 05 à 08, le popup de l'extension

Boîte `360px`, colonne flex, `font-size: 13px; line-height: 1.5`. **Tête** : `padding: 10px 10px 10px 16px`, filet ; logo `82 × 16` ; (connecté) avatar `28px` « M » avec `role="img" aria-label="Signed in as Mathieu"` ; bouton icône engrenage `36px` `aria-label="Settings and every site"`. **Corps** : `padding: 20px 16px 16px` (07 : `18px`), `gap: 14–18px`. **Pied** (connecté) : `padding: 12px 16px`, filet, adresse du compte tronquée à gauche, lien « Open the console » à droite.

- **05 signed out** (420 px) : « staging.acme.dev » (`13px`, `#6b6b74`) ; `h1` « Sign in to see and leave notes here » ; « One account for the console and this extension. The sign-in opens in a tab, and this popup picks it up by itself. » ; bouton « Sign in to Fruitback » ; pied « Running your own Fruitback? Connect it in settings ».
- **06 site in workspace** (420 px) : `h1` « staging.acme.dev » ; « In Sakuga · members see the notes » ; « **12** notes wait on this site » ; barre de statuts pleine largeur (`aria-label="3 new, 2 to do, 4 in progress, 2 done, 1 closed"`) ; « 3 new · 2 to do · 4 in progress · 2 done · 1 closed » (`12px`) ; bouton « Turn on here » ; « Chrome asks for access to this site only. » (`12px`, centré).
- **07 on** (540 px) : ligne titre + interrupteur allumé (`aria-label="Fruitback on staging.acme.dev"`) : « staging.acme.dev » / « On · Sakuga » ; section « On this page » + « 8 notes » ; cinq lignes (goutte `11px`, libellé, nombre `600`) : New 2, To do 1, In progress 3, Done 2, Closed 0 (le zéro en `#6b6b74`) ; bouton « Leave feedback » ; secondaire `40px`/`r10` « Show every note of the page ».
- **08 new site** (500 px) : `h1` « preview.lumen.studio » ; « Not in a workspace yet » ; « Add it to review it. Nothing goes on the site: members with the extension see the notes, visitors see nothing. » ; liste « Workspace » (Sakuga, Northwind) ; case cochée « Every preview build too » / « Covers *.lumen.studio, so each new preview has its notes. » ; bouton « Add to Sakuga and turn on » ; « Chrome asks for access to this site only. ».

### 2.6 — 09 « Console, Sites »

- Rail : sélecteur de workspace (`aria-haspopup="menu"`, pastille « S », « Sakuga », « Cloud workspace », chevrons) ; `nav aria-label="Workspace"` : **Sites, Notes, Connectors, Members, My account** ; pied « Help and docs » + logo.
- `main` `max-width: 1120px; padding: 40px clamp(16px,4vw,48px) 72px`. `h1` « Sites » ; « Where Sakuga collects notes, and where they stand. » ; bouton « Add a site » (état `list` seulement).
- `list` : légende des cinq statuts ; table (`min-width: 860px`) : colonnes **Site** (adresse en lien `600` + audience : « Members of Sakuga » / « Everyone who visits »), **Notes** (total + barre, ou « Waiting for the first note »), **On the page with** (« Extension, script » / « Script » / « Extension »), **Notes go to** (« Linear » / « Team Acme web » ; « GitHub Issues » / « acme/website » ; « REST API » / « 2 not delivered yet » ; « Kept in Fruitback » / « No tracker yet »), **Last note** (« 2 h ago », « · » si aucune), actions (« … », `aria-label="More for <adresse>"`). Sous la table : « A site with no tracker keeps its notes in Fruitback. Connect a tracker or see where every note went ».
- `empty` : carte (`padding: 48px clamp(20px,5vw,56px); border-radius: 14px; background: #fafafa; max-width: 640px`) : goutte rouge `40 × 48` ; « No site yet » (`20px/700`) ; « Paste the address of a site you review. Staging, a preview build or a client's live site: any page of it will do. » ; champ « Site address » + « Add site ».
- `failed` : `role="alert"` (`padding: 28px 32px; border: 1px solid #8a8a93; border-radius: 14px; max-width: 760px`) : « The sites did not load » ; « Fruitback did not answer. Your sites and notes are safe. » ; « Try again ».

### 2.7 — 10 « Console, Notes »

- `main` `max-width: 1240px`. `h1` « Notes » ; « Every note left on the sites of Sakuga, and where it went. »
- Puces `role="group" aria-label="Where the notes went"` : **All 44** (enfoncée), **Linear 17**, **GitHub Issues 23**, **REST API 2**, **Not delivered 2** (rouge).
- Filtres : recherche (« Search the text, the page or the author », étiquette masquée « Search notes ») ; « Site » (Every site + sites) ; « Status » (Any status, New, To do, In progress, Done, Closed) ; case « Only my notes ».
- Table (`min-width: 960px`) : **Note** (texte sur 2 lignes max `.clamp`, puis page + lien « Show on the page ») ; **Status** (goutte `10px` + libellé) ; **Left by** (nom + « You » / « Anonymous » / « Member » / « Guest » / « Admin » / « Verified by acme.dev ») ; **Went to** (destination `600` + référence en lien avec flèche, p. ex. « ACM-151 », « acme/website#91 » ; ou « Delivered to hooks.acme.dev » ; ou « Not delivered yet » rouge + bouton « Send again » `32px`) ; **When**.
- Pagination `nav aria-label="Pages of notes"` : « 1 to 8 of 44 » ; « Previous » (désactivé), « Next ».

### 2.8 — 11 « Console, Connectors »

- `main` `max-width: 1180px`. `h1` « Connectors » ; « Connect a tracker once. Every site of Sakuga can then send its notes there. »
- Colonne principale (`flex: 999 1 440px`, `gap: 32px`) : **« Connected »** — liste encadrée de boutons `aria-pressed` (pastille `34px` avec initiale « L », « G », « { } ») : Linear « Team Acme web · 2 sites » / « Connected » (vert) [sélectionné, fond `#f4f4f5`] ; GitHub Issues « acme/website · 1 site » / « Connected » ; REST API « hooks.acme.dev/feedback · 1 site » / « 2 notes did not arrive » (rouge). **« Add a source »** — Jira « An issue in a Jira Cloud project. » ; GitLab « An issue in a project, cloud or self-managed. » ; Trello « A card in the list you choose. » ; Notion « A row in a database. » ; Webhook « Tells Slack or any address when a note arrives. » ; chacun un bouton « Connect » (`aria-label="Connect <nom>"`).
- Panneau (§ 1.4) : « Linear » ; « Connected by Mathieu with OAuth · Team Acme web » ; « Sites sending here » (staging.acme.dev 12 notes ; *.preview.acme.dev 5 notes) ; « Status of the pins » / « Which Linear state gives each pin its status. » : cinq lignes état Linear → liste (Triage → New, Todo → To do, In Progress → In progress, Done → Done, Canceled → Closed), grille `minmax(0,1fr) 16px minmax(0,1fr)` ; interrupteurs « Show Linear comments as replies », « Attach a picture of the element » ; pied : lien « Disconnect Linear » et « Last issue created 12 min ago ».

### 2.9 — 12 « Console, Members »

- `main` `max-width: 1120px`. `h1` « Members » ; « Who sees and leaves notes, and who changes the workspace. »
- Formulaire `aria-label="Invite someone"` sur une ligne : « Email » (placeholder `name@company.com`), « Role » (Guest, one site / Member / Admin), « Site » (liste des sites), bouton « Invite ».
- Table (`min-width: 760px`) : **Person** (avatar `32px`, nom, e-mail), **Role** (Owner, Admin, Member, Guest), **Sites** (« Every site » ou le site), **Last seen**. Ligne d'invitation : avatar vide, adresse, « Invitation sent », « Sent 3 Oct », liens « Resend », « Cancel ».
- Légende des rôles (`<dl>`) : Admin « Sites, connectors and members. » ; Member « Every site. Sees the links to the tracker. » ; Guest « Only the sites shared with them. Free, and never sees the tracker. »

### 2.10 — 13 « Console, My account »

- `main` `max-width: 820px; gap: 40px`. `h1` « My account » ; « Your name on notes, how you sign in, and where. »
- **Profile** : « Name shown on notes » (`Mathieu`) ; « Language » (English, Français).
- **How you sign in** — « Any of these opens the same account, in the console and in the extension. » : « Email link » / adresse / « Always on » ; « GitHub » / « Linked as mheos » / lien « Unlink » ; « Google » / « Not linked » / bouton « Link Google ».
- **Where you are signed in** — « Disconnect a browser you no longer use. It stops showing notes at once. » : « Console · Firefox on macOS » / « Active now » / « This browser » ; « Extension · Chrome on macOS » / « Connected 12 Oct · used 2 h ago » / « Disconnect » ; « Extension · Firefox on Linux » / « Connected 2 Oct · used 3 days ago » / « Disconnect ».
- Bouton « Sign out » ; lien « Sign out everywhere ».

### 2.11 — 14 à 16, le widget sur la page

Scène fixe sur le site d'exemple. Communs : pins numérotés colorés par statut, posés au coin haut-gauche d'un cadre `2px` de la couleur du statut, `inset: -4px`, `border-radius: 6px` (cadre du pin ouvert : fond `rgba(245,158,11,.12)`) ; en bas à droite (`right: 24px; bottom: 24px; gap: 10px`) bouton réglages rond `44px` `#3f3f46` (`aria-label="Fruitback settings"`) et bouton « Leave feedback » `44px`, `padding: 0 20px`, goutte blanche `12 × 15`.

- **14 reading a note** : bulle `role="dialog" aria-label="Note 2"` `width: 360px; border-radius: 14px`. Tête (`padding: 8px 8px 8px 16px`) : goutte + « In progress » (`13px/600`) ; lien « ACM-142 in Linear » (`12px`) ; fermer `32px` (`aria-label="Close the note"`). Corps (`padding: 14px 16px; gap: 8px`) : le texte ; « Camille Durand · guest · 2 days ago » (`12px`) ; ligne de composant mono `11.5px` « HeroBanner · src/components/Hero.tsx:42 » (fond `#fafafa`, bordure, `border-radius: 6px`). Réponse (`padding: 12px 16px`) : « **Léa** · Sakuga · yesterday » (`11px`) + texte `12px`. Pied : zone « Reply to Camille » (`min-height: 36px`, `border-radius: 6px`) + bouton « Send » `36px`.
- **15 leaving a note** : bandeau `role="status"` en haut au centre (`top: 88px`, pilule `#18181b`) : « Click the part of the page your note is about » ; « Esc to stop » (`#a1a1aa`) ; bouton « Stop » (`32px`, `#3f3f46`). Élément choisi : cadre rouge `inset: -6px`, fond `rgba(221,44,39,.06)`, étiquette de composant « ProductCard » (`11px/600`, fond rouge, `border-radius: 6px 6px 6px 0`). Composer (`form.composer aria-label="New note"`, `width: 360px; border-radius: 14px`) : « New note » + « on Fell shell jacket » + fermer (`aria-label="Close without sending"`) ; zone de texte 3 lignes (placeholder et étiquette masquée « What should change? ») ; case cochée « Attach a picture of this element » (`12px`) ; pied : « As Mathieu, Sakuga » (`12px`), « Cancel » (fantôme `36px`), « Send » (principal `36px`). « Leave feedback » en bas est enfoncé (`aria-pressed="true"`, fond `#b91c1c`).
- **16 every note of the page** : panneau à droite `width: 380px`, pleine hauteur, bordure gauche, ombre ; la page est réduite d'autant (`padding-right: 428px`). Tête : « Notes on this page » (`15px/600`) / « staging.acme.dev/ » (`12px`) / fermer `36px` (`aria-label="Close the notes"`). Bouton « Leave feedback » pleine largeur `40px`. Onglets `role="tablist" aria-label="Which notes"` (rail `#f4f4f5`, `padding: 3px; border-radius: 10px`) : « Open 6 » (actif), « Done 2 », « All 8 ». Liste : boutons `.note` (`grid 30px 1fr; padding: 12px 10px; border-radius: 10px`), pin `24px`, texte 2 lignes max, méta `12px` (« In progress · Camille Durand · 2 days ago · 1 reply », « … · further down ») ; l'élément courant a le fond `#f4f4f5` et `aria-current="true"`. Section « Could not be placed · 1 » (goutte en pointillé `#d97706`) : « The promo banner says "Sping" instead of "Spring". » / « Its element is no longer on this page. The note stays here and in Linear. »

### 2.12 — 17 à 20, l'administration d'une instance auto-hébergée

Rail : pastille à bordure `#52525b` avec goutte `#ec5b57`, « feedback.acme.dev », « Self-hosted instance » ; `nav aria-label="Instance"` : **Instance, Workspaces, Users, Notes, My workspaces** (ce dernier mène à la console, Sites) ; pied « Self-hosting guide » + logo.

- **17 Instance** (`max-width: 1040px; gap: 44px`) : `h1` « Instance » ; « Everything this server runs, set from here instead of the .env file. A variable set in the environment still wins, and locks its field. »
  - **Health** (`<dl>` en grille `auto-fit minmax(min(200px,100%),1fr)`) : Worker « Answering » (vert) / « Up for 12 days » ; Database « PostgreSQL » / « Backed up 4 h ago » ; Mail « Scaleway TEM » / « Last link sent 3 min ago » ; Connectors « 1 needs a look » (rouge) / « REST API, Acme support ».
  - **Sign-in** — « How people get into this instance, in the console and in the extension. » : « Email link » / « Sent through Scaleway TEM from feedback@acme.dev » / interrupteur ; « GitHub » / « OAuth app set up 3 Sep » / lien « Edit keys » / interrupteur ; « Google » / « Not set up yet » + formulaire : « Client ID » (placeholder `1234-abc.apps.googleusercontent.com`), « Client secret » (`type="password"`, placeholder « Paste it here »), « Redirect address to give Google: » `https://feedback.acme.dev/console/auth/callback/google` + « Copy », bouton « Turn on Google ».
  - **Who can make an account** (radios) : « Only people invited to a workspace » ; « Anyone with an address at acme.dev, and people invited » (choisi) ; « Anyone ».
  - **Public address** : champ verrouillé `https://feedback.acme.dev` + « Set by FRUITBACK_PUBLIC_URL in the environment. ».
  - **Workspaces** + bouton « New workspace » : table Name / Owner / Members / Sites / Created (Acme web, nadia@acme.dev, 6, 3, 3 Sep ; Acme support, tom@acme.dev, 2, 1, 18 Sep ; Lumen, paul@lumen.studio, 1, 1, 12 Oct).
- **18 Workspaces** (`max-width: 1240px`) : `h1` « Workspaces » ; « Every workspace on this instance, who owns it and where its notes go. » ; bouton « New workspace » ; recherche « Search by name or owner » ; filtre « Show » (All workspaces / Needs a look / Suspended) ; table Workspace (« 6 people · 3 sites ») / Owner / Notes (total + barre `96px`) / Notes go to (+ « 2 notes not delivered » rouge). Panneau « Acme support » : « Owned by tom@acme.dev · created 18 Sep » ; « Where notes go » : « REST API hooks.acme.dev/fruitback », `role="alert"` « **2 notes not delivered.** The address answered 503 at 09:12 and 09:40. », bouton « Send them again », lien « See the notes » ; « People · 2 » + « Manage in Users » ; « Sites · 1 » ; liste « Owner » ; pied : « Suspend », lien « Delete the workspace ».
- **19 Users** : `h1` « Users » ; « Everyone who can sign in to this instance, and in which workspaces. » ; bouton « Invite someone » ; recherche « Search by name or address » ; filtre (All people · 8 / Instance admins · 1 / Suspended · 1 / Invited · 1) ; table Person / Workspaces (« Acme web · owner », retour à la ligne par `white-space: pre-line`) / Signs in with (« Email link, GitHub », « Google », « Not signed in yet ») / Status (« Instance admin », « Active » vert, « Suspended » rouge, « Invited » gris + « Active now », « Since 30 Sep », « Resend »). Panneau « Hugo Petit » : `role="status"` « **Suspended** on 30 Sep by Nadia Benali. Hugo cannot sign in, and his browsers were signed out. » ; « Restore access » ; « Workspaces » (rôle par liste : Member, Admin, Guest) ; « Add to a workspace » ; « Sign-in » (Email link ; « Browsers signed in » : None) ; interrupteur « Instance admin » / « Sees this admin and every workspace. » ; « Delete Hugo's account » / « His notes stay where they are, signed as a former member. »
- **20 Notes** : `h1` « Notes » ; « Every note left on this instance, and where it is stored now. » ; puces `aria-label="Where notes are stored"` : All 136, Linear 84, GitHub Issues 28, REST API 21, In Fruitback 3, Not delivered 2 ; recherche ; filtres « Workspace » et « Status » ; table Note (texte + « page · workspace ») / Status / Left by / **Stored in** (« In Fruitback » + « Not delivered to REST API » + « Send again » ; « No tracker connected ») / When ; pagination « 1 to 8 of 136 ».

## 3. Jetons : maquette contre dépôt (`origin/main` à `02c98b0`)

Sources du dépôt : console `apps/console/app/app.css` (variables HeroUI et bloc `@theme`) ; widget `packages/widget/src/theme.ts` (source de vérité, 31 jetons, clair et sombre) ; extension `apps/extension/entrypoints/popup/style.css` (alignée sur le widget par FRU-170, #198, et tenue par `apps/extension/src/design-tokens.test.ts` qui compare chaque couleur à `theme.ts`) ; e-mails `apps/worker/src/mail.ts` et page `/pair` (`pair-page.ts`) : couleurs en dur ; `design/README.md` : la planche du 2026-10-07, avec la règle « Build to it » (`docs/decisions/console.md`).

**Le constat d'ensemble** : la maquette quitte la palette « pierre chaude » (stone : `#1c1917`, `#e7e5e4`, page `#faf9f5`) pour une palette **zinc neutre** (`#18181b`, `#e4e4e7`, page blanche), remplace les **cinq couleurs de stade « fruit »** par cinq couleurs de statut franches, et introduit un **rail sombre**. L'accent (`#dd2c27` / `#b91c1c`), les rayons, les ombres et la police sont déjà ceux du dépôt.

| Jeton | Maquette | Console | Widget (clair) | Extension (clair) | Verdict |
|---|---|---|---|---|---|
| Accent | `#dd2c27` | `--accent #dd2c27` | `color-accent #dd2c27` | `--accent #dd2c27` | existe, identique |
| Accent survolé | `#b91c1c` | `--accent-hover #b91c1c` | (pas de jeton) | (pas de jeton) | existe en console |
| Accent sur sombre | `#ec5b57` | absent | sombre : `#ec6a65` | sombre : `#ec6a65` | **diffère** (`#ec5b57` contre `#ec6a65`) ; nouveau en console |
| Encre | `#18181b` | `--foreground #1c1917` | `color-text #1c1917` | `--text #1c1917` | **diffère** |
| Texte secondaire | `#6b6b74` | `--muted #736c67` | `color-text-muted #78716c` | `--muted #78716c` | **diffère** |
| Texte tertiaire | `#52525b` | absent | `color-text-subtle #7a736e` | absent | **diffère** / nouveau |
| Placeholder | `#6b6b74` | `--field-placeholder #a8a29e` | — | — | **diffère** (la maquette l'assombrit : 5,28:1 au lieu de ~2,5:1) |
| Fond de page | `#ffffff` | `--background #faf9f5` (et `--color-setup #f6f4f1`) | — | `--surface #fff` | **diffère** en console |
| Fond discret | `#fafafa` | absent (`--default #f5f5f4`) | `color-surface-raised #fffdf9` | absent | **diffère** |
| Fond enfoncé | `#f4f4f5` | `--default`/`--color-chip #f5f5f4` | — | — | **diffère** (d'un cran) |
| Filet | `#e4e4e7` | `--border #e7e5e4` | `color-border #e7e5e4` | `--line #e7e5e4` | **diffère** |
| Bordure de contrôle | `#8a8a93` | `--field-border #8f8883` | `color-border-strong #8f8883` | `--line-strong #8f8883` | **diffère** |
| Succès | `#15803d` | `--success #56802e` | `color-success #4e7d2a` | — | **diffère** |
| Danger | `#dd2c27` (texte d'alerte) | `--danger #b91c1c` | — | — | **diffère** (la maquette écrit les alertes dans l'accent) |
| Statut New | `#dd2c27` | — | `stage-new #6a7950` | — | **diffère** |
| Statut To do | `#2563eb` | — | `stage-todo #56802e` | — | **diffère** |
| Statut In progress | `#f59e0b` (+ chiffre sombre) | — | `stage-progress #ac5f00` | — | **diffère** (et le texte du pin devient sombre) |
| Statut Done | `#15803d` | `--color-done #56802e` | `stage-done #8c1d40` | — | **diffère** |
| Statut Closed | `#64748b` | — | `stage-closed #8d6e63` | — | **diffère** |
| Rail sombre (`#18181b`, `#27272a`, `#d4d4d8`, `#a1a1aa`) | oui | absent (nav claire, entrée active = carte blanche) | — | — | **nouveau** |
| Avatar `#3f3f46` | oui | `Initial` : carré encre | `color-chip #44403c` | — | **diffère** |
| Rayon contrôle | `6px` | `.wide-button` 6 px | `radius-sm 6px` | `--radius-control 6px` | existe |
| Rayon champ | `8px` | `--field-radius 8px` | — | `--radius-field 10px` | existe en console ; **diffère** dans l'extension (10 → 8 ; mais les boutons du popup passent de pilule à `10px`) |
| Rayon carte moyenne | `10px` | `rounded-[10px]` en dur | `radius-md 10px` | — | existe |
| Rayon carte | `14px` | `rounded-[14px]` en dur | `radius-lg 14px` | — | existe |
| Pilule | `999px` | `rounded-full` | `radius-pill` | `--radius-pill` | existe |
| Ombre pin | `0 3px 10px rgba(24,24,27,.28)` | — | `shadow-sm 0 3px 10px rgba(28,25,23,.28)` | — | **diffère** (teinte seulement) |
| Ombre dock | `0 4px 18px rgba(0,0,0,.25)` | — | `shadow-md` identique | — | existe |
| Ombre bulle | `0 10px 30px rgba(0,0,0,.18)` | — | `shadow-lg` identique | — | existe |
| Ombre composer | `0 14px 40px rgba(24,24,27,.22)` | — | `shadow-xl … rgba(28,25,23,.22)` | — | **diffère** (teinte) |
| Ombre du cadre d'aperçu `0 10px 30px rgba(24,24,27,.08)` | oui | carte d'étape `0 24px 60px -30px rgba(28,25,23,.25)` | — | — | **nouveau** |
| Police | `-apple-system, system-ui, sans-serif` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` | `-apple-system, system-ui, sans-serif` | `system-ui, -apple-system, 'Segoe UI', sans-serif` | existe (ordre des secours près) |
| Titre de page | `28px/700/-0.02em` | `text-[26px] font-bold tracking-[-0.02em]` | — | — | **diffère** (26 → 28) |
| Chapeau | `16px` | `15px` | — | — | **diffère** |
| Durée courte | `.22s` | aucun jeton | `duration-fast 220ms` | aucune | existe (widget) |
| Durée longue | `.42s` | aucun | `duration-slow 420ms` | aucune | existe (widget) |
| Courbe | `cubic-bezier(.16,1,.3,1)` | aucune | composer `cubic-bezier(0.22,1.2,0.36,1)`, pin `cubic-bezier(0.2,1.4,0.35,1)` | aucune | **diffère** (la maquette n'a pas de dépassement) ; et le composer passe de 220 ms à 420 ms |
| Focus | `2px solid #dd2c27`, décalage `2px` | identique | — | — | existe ; **nouveau** : `#ec5b57` dans le rail |
| Thème sombre | aucun | aucun | **oui** (31 jetons) | **oui** | la maquette ne dit rien du sombre : voir § 5 |
| `prefers-contrast: more` | aucun | — | oui | — | à garder (§ 5) |

Conséquences pour le socle : (1) `theme.ts` change de valeurs pour 13 jetons au moins, et `design-tokens.test.ts` oblige l'extension à suivre dans la même PR ; (2) `app.css` change 12 variables et gagne celles du rail et des statuts ; (3) `design/README.md` doit dire que la planche du 2026-10-07 est remplacée, sinon la règle « Build to it » de `docs/decisions/console.md` contredit la maquette ; (4) `e2e/console-kit.spec.ts` mesure des contrastes et des formes de la planche d'avant : à réécrire sur les nouvelles valeurs ; (5) les couleurs de `mail.ts` et de `pair-page.ts` sont en dur.

## 4. L'écart avec `origin/main`

Captures de l'existant : `shots-actuel/` (34 PNG, 17 écrans × 1440 et 390 ; console de `02c98b0` lancée en local sur le port 5191 dans mon worktree, worker **simulé** par `page.route` comme le font les specs `e2e/console-*.spec.ts` ; aucune base, aucun vrai worker, 0 requête hors de la machine ; journal dans `shots-actuel/capture-log.txt`). **Non capturés** : le popup et la page d'options de l'extension (il faut construire l'extension et la charger : je m'en suis tenu au code de `popup/main.ts`), le widget (code de `packages/widget/src` et images existantes `docs/assets/*.png`, `apps/extension/store/*.png`), la page `/pair` du worker, les e-mails.

### 4.1 Tableau des écrans

| Maquette | Surface | Équivalent sur `main` | Capture de l'existant | Ampleur |
|---|---|---|---|---|
| 01 Setup, one screen | console | `apps/console/app/routes/setup.tsx`, `/setup` : 4 étapes en cartes (Workspace, Source, Site, Install), une étape par écran | `A01` à `A05`, `A10` | **refonte** : 4 écrans → 1 écran à 3 étapes + aperçu |
| 02 Sign in | console | pas de page de connexion : l'étape 1 de `/setup` sert aux deux ; `/sign-in#<token>` n'est que l'atterrissage du lien (`routes/sign-in.tsx`) | `A01`, `A02`, `A06` | **nouvel écran** + 2 états nouveaux |
| 03 Invitation | console | `routes/invitations.tsx`, `/invitations` : une liste d'invitations, « Decline » / « Join » | `A07`, `A08` | **refonte** + dépend du rôle invité et d'une décision de sécurité |
| 04 Connect this browser | console (aujourd'hui : worker) | bouton « Connect this browser » de `InstallOptions` → page statique `GET /pair` du worker (`pair-page.ts`) → clic dans le popup | `A10` (le bouton) | **nouveau parcours** : serveur, console et extension |
| 05 Popup, signed out | extension | `apps/extension/entrypoints/popup/main.ts` : états « no rule » (formulaire Mode / Worker endpoint / Client id) et « Not paired » | non capturé | **refonte** |
| 06 Popup, site in workspace | extension | état `oneClick` : « This site is in the workspace {name}. » + « Turn on Fruitback here » | non capturé | moyenne (compteurs nouveaux) |
| 07 Popup, on | extension | état `status` : « Rule: … », « On · … », « Change », « Turn off here » | non capturé | **refonte** (compteurs, deux actions nouvelles) |
| 08 Popup, new site | extension | formulaire `form` (Mode, Worker endpoint, Client id) | non capturé | **nouveau** : crée un site depuis l'extension |
| 09 Console, Sites | console | `routes/sites.tsx` + `domains.tsx`, `/w/:workspace/sites` | `A09` à `A12` | **refonte** : liste → table à données nouvelles ; « Preview deploys » disparaît |
| 10 Console, Notes | console | **n'existe pas** (aucune route, aucune lecture de notes par workspace) | — | **nouveau**, le plus lourd côté serveur |
| 11 Console, Connectors | console | `routes/connectors.tsx`, `/w/:workspace/connectors` | `A13` à `A15` | moyenne à forte (panneau simplifié, sources nouvelles) |
| 12 Console, Members | console | `routes/members.tsx` | `A16` | moyenne ; forte avec le rôle invité |
| 13 Console, My account | console | `routes/account.tsx` | `A17` | moyenne ; forte côté serveur (comptes liés, navigateurs) |
| 14 Widget, reading a note | widget | `packages/widget/src/overlay.ts` (pins, fil) | non capturé | moyenne ; **répondre** est nouveau |
| 15 Widget, leaving a note | widget | `composer.ts`, `host.ts` (mode capture) | non capturé | moyenne |
| 16 Widget, every note of the page | widget | `sidebar.ts`, `orphans.ts`, `drafts.ts` | non capturé | moyenne |
| 17 Self-hosted, instance admin | console + worker | **n'existe pas** (ni rôle, ni route, ni écran) | — | **nouveau** |
| 18 Admin, workspaces | console + worker | **n'existe pas** | — | **nouveau** |
| 19 Admin, users | console + worker | **n'existe pas** | — | **nouveau** |
| 20 Admin, notes | console + worker | **n'existe pas** | — | **nouveau** |

### 4.2 Différences, écran par écran

**01 Setup** (contre `setup.tsx`)
- Disparaît : l'étape « Source / Where should feedback go? » (liste à lire) ; le champ « Workspace name » et l'écran « Name your workspace » ; la carte d'étape à pied « Step 1 of 4 » + « Continue » / « Finish » ; les pastilles « Fruitback Cloud / Self-hosted » de l'en-tête ; le mot « Set up » à côté de la marque ; le fond `#f6f4f1`.
- Apparaît : les trois étapes visibles en même temps, les étapes faites résumées avec « Rename » et « Change » ; l'aperçu du site à droite ; « Waiting for your first note. » et l'étape qui se valide seule à la première note ; la conclusion « Your first note is in » avec « Open the console » et « Connect a tracker » ; « Running your own server? Self-hosting guide ».
- Bouge : l'e-mail passe **avant** Google et GitHub (aujourd'hui les deux boutons sont au-dessus) ; l'étape « Install » devient « Put it on the site ».
- Change de texte : « Create your workspace » → « Set up Fruitback » ; « One workspace for your team, your sites and your sources. Hosted in Europe. » → « Three steps to your first note on a live page. Hosted in Europe. » ; « or with an email link » → « or » ; « Continue » → « Email me a link » ; « It works once, for fifteen minutes. » + « Open it in this browser. Nothing in it asks for a password, and ignoring it is safe. » → les deux phrases de § 2.1 ; « Which site do you review? » → « Your site » ; « Who sees the feedback? » → « Who sees the notes? » ; « The members of {workspace} » / « Visitors of the site see no note. » → « Members of Sakuga » / « Visitors of the site see nothing. Right for staging and for a client's site. » ; « Everyone who visits the site » / « For a public « report a problem ». » → « Everyone who visits » / « A public way to report a problem on a live site. » ; « Add the site » → « Add site » ; « Copy the script » → « Copy script » ; « Connect this browser » → « Add to Chrome » ; placeholder `https://staging.acme.dev` → `staging.acme.dev` ; le script perd `data-fruitback-endpoint`.

**02 Sign in** : écran nouveau. L'état `sent` reprend « Check your inbox » avec d'autres phrases ; `expired` remplace « Ask for another one. » + lien « Send a new link » par un formulaire sur place (« Send me a new link ») ; `link-opened` est nouveau (aujourd'hui l'onglet du lien **devient** la console, il n'y a pas d'onglet d'origine qui continue) ; l'état « You are not signed in yet / Fruitback did not answer. Your link still works. » d'aujourd'hui n'est pas dessiné (à garder). L'état FRU-217 « Nobody can sign in to this Fruitback yet… » n'est pas dessiné (à garder).

**03 Invitation** : aujourd'hui une **liste** (« Invitations », « For {email}. », par ligne nom du workspace, « Until {date} », puce de rôle, « Decline », « Join {workspace} ») ; la maquette montre **une** invitation, centrée sur un site, sans « Decline », sans date de fin, avec un état « You are in » qui pousse l'extension. Elle suppose trois choses qui n'existent pas : le lien **connecte** (aujourd'hui le lien ne porte rien et ne connecte pas : `SECURITY.md`) ; le rôle **Guest** limité à un site (les invitations n'acceptent que `admin` et `member`) ; l'invitation **nomme un site**.

**04 Connect this browser** : aujourd'hui la console frappe un code (`POST /console/workspaces/<id>/connect`), ouvre `GET /pair#<code>` (page du worker, anglais seul, hors jetons), et c'est **dans le popup** qu'on clique « Pair with this worker ». La maquette inverse le sens : **l'extension demande**, la **console approuve** (« Connect Chrome »), un mot de vérification (« PLUM 47 ») est montré des deux côtés, et le popup « picks it up by itself ». La connexion vaut pour **tous les workspaces du compte** (« Workspaces: Sakuga, Northwind ») alors qu'une session d'extension nomme aujourd'hui **un** workspace.

**05–08 Popup** : disparaissent du popup les mots « rule », « mode », « worker endpoint », « client id », « pair », « Log out », « Change », « Set up by hand », « All sites and rules » (remplacé par l'engrenage « Settings and every site ») ; le `h1` « Fruitback » devient le logo. Apparaissent : l'avatar du compte, le pied avec l'adresse et « Open the console », les compteurs de notes (du site, de la page, par statut), l'interrupteur, « Leave feedback » et « Show every note of the page » depuis le popup, l'ajout d'un site à un workspace depuis le popup avec « Every preview build too ». Texte : « Turn on Fruitback here » → « Turn on here ».

**09 Sites** : disparaissent le formulaire d'ajout en tête (remplacé par un bouton « Add a site » dont le formulaire n'est pas dessiné, sauf dans l'état vide), les boutons « Install » et « Remove » de la ligne (remplacés par un menu « … » non dessiné), les puces « Members » / « Everyone », toute la section **« Preview deploys »** (preuve DNS d'un domaine, FRU-103). Apparaissent : la légende des statuts, les colonnes **Notes** (total et barre), **On the page with**, **Notes go to**, **Last note**, un site-motif `*.preview.acme.dev` comme une ligne ordinaire, la phrase de pied. Textes : chapeau « The addresses you review. Adding a site is pasting its URL. » → « Where Sakuga collects notes, and where they stand. » ; vide « No site yet. Paste the address of the one you review. » → carte « No site yet » ; échec « Fruitback did not answer. Your sites are not lost. » → « The sites did not load » / « Fruitback did not answer. Your sites and notes are safe. ».

**11 Connectors** : disparaissent la carte fixe « Fruitback / The notes stay in this workspace », « Use an API key », l'état « Working », les cartes « After the beta », et dans le panneau la gestion des destinations par site (équipe, projet, « Make it the default », « Add a destination… », cinq au plus). Apparaissent : GitHub Issues **connecté**, cinq sources à bouton « Connect » actif (Jira, GitLab, Trello, Notion, Webhook), « Sites sending here » avec un compteur de notes, l'interrupteur « Attach a picture of the element », « Last issue created 12 min ago ». Textes : « Connect a source once. Every site of the workspace can then send its feedback there. » → « Connect a tracker once. Every site of Sakuga can then send its notes there. » ; « Which Linear state gives which colour on the page. » → « Which Linear state gives each pin its status. » ; « Disconnect » → « Disconnect Linear ».

**12 Members** : apparaissent l'option « Guest, one site » et la liste « Site » du formulaire, les colonnes « Sites » à valeur réelle et **« Last seen »**, « Sent 3 Oct ». Disparaissent (non dessinés) : « (you) », les puces de rôle, « Remove », le bloc d'après-invitation avec le lien à copier, l'aide « Guests, who see one site only, come later. ». Textes : chapeau « Who can see and leave feedback, and who can change the workspace. » → « Who sees and leaves notes, and who changes the workspace. » ; « Sites, connectors, members. » → « Sites, connectors and members. » ; « Every site. Sees the tracker links. » → « Every site. Sees the links to the tracker. » ; « Free, never sees the tracker. » → « Free, and never sees the tracker. ».

**13 My account** : apparaissent « Name shown on notes », « Unlink » / « Link Google », la liste des navigateurs (console et extensions) avec « Disconnect », « Sign out everywhere ». Disparaît : la carte « Delete the workspace » (non dessinée ailleurs). Textes : chapeau « How you sign in, and the workspace you are in. » → « Your name on notes, how you sign in, and where. » ; « On » → « Always on » ; « Not set up » → « Not linked ».

**14–16 Widget** : couleurs de stade (§ 3) ; le fil gagne un en-tête à statut + lien « ACM-142 in Linear » (aujourd'hui « {identifier} → »), la ligne du composant, et **un champ de réponse** (aujourd'hui on lit les réponses, on n'en écrit pas) ; le composer gagne le titre « New note · on <élément> », l'étiquette du composant, la case « Attach a picture of this element » (aujourd'hui dans les réglages), « As Mathieu, Sakuga », et perd (non dessinés) « Keep for later », « Add my name (optional) », « Remember me on this site », le choix de destination ; placeholder « What is wrong here? » → « What should change? » ; le bandeau de capture remplace « Point at an element, or move with the arrow keys and press Enter. » par « Click the part of the page your note is about » + « Esc to stop » + « Stop » ; la liste passe de 340 à 380 px, gagne les onglets « Open / Done / All », « Leave feedback », « further down », « Could not be placed · 1 », et pousse la page ; le bouton de liste du dock n'est pas dessiné.

**17–20 Admin** : tout est nouveau.

### 4.3 Ce que le « simpler flow » change dans le parcours

| # | Aujourd'hui | Maquette | Nature |
|---|---|---|---|
| P1 | 4 étapes, une par écran : Workspace → Source → Site → Install | 3 étapes sur un écran : Your account → Your site → Put it on the site | étape « Source » **supprimée** ; le nom du workspace **fusionné** dans le compte |
| P2 | Le nom du workspace est demandé (champ, ou écran « Name your workspace ») | Il est **déduit du domaine de l'e-mail**, puis renommable | étape supprimée |
| P3 | Se connecter = repasser par `/setup` | Une page « Sign in » distincte ; « Set up » pour les nouveaux | écrans séparés |
| P4 | Le lien e-mail ouvre la console dans **son** onglet | L'onglet d'origine **continue seul** ; l'onglet du lien dit « You can close this one » | nouveau comportement |
| P5 | La mise en place finit sur « Finish » | Elle finit **à la première note reçue** | critère de fin changé |
| P6 | Appairage : la console frappe un code → page `/pair` du worker → clic dans le popup | **L'extension demande, la console approuve**, mot de vérification, aucune page du worker | sens **inversé**, une étape en moins |
| P7 | L'extension s'appaire **par worker et par workspace** ; on règle « rule / mode / endpoint / client id » | **Un compte** pour la console et l'extension, tous ses workspaces ; l'auto-hébergement se règle dans « settings » | modèle simplifié |
| P8 | Un site s'ajoute dans la console seulement | Aussi **depuis le popup** (« Add to Sakuga and turn on ») | raccourci nouveau |
| P9 | Les previews : prouver un domaine par DNS, puis rattacher à un site | Un motif `*.preview.acme.dev` tapé comme adresse, ou une case « Every preview build too » | étape de preuve **supprimée** |
| P10 | L'invité reçoit un lien neutre, se connecte avec son adresse, voit la liste, rejoint | Le lien **connecte**, l'écran montre l'invitation, « Join », puis « Add to Chrome » | 2 étapes en moins |
| P11 | Les notes ne se lisent que sur la page ou dans le tracker | Une page **Notes** dans la console, et « Show on the page » | lecture nouvelle |
| P12 | On lit les réponses de l'équipe sur la page | On **répond** depuis la page | écriture nouvelle |
| P13 | L'opérateur d'une instance règle tout par le `.env` | Une **administration d'instance** dans la console | surface nouvelle |

### 4.4 Ce que cela demande côté worker, API et données

| Besoin | Existe ? | Ce qu'il faut | Migration | Critique |
|---|---|---|---|---|
| S1 Renommer un workspace ; nom par défaut tiré du domaine | Non (`POST /console/workspaces {name}` crée ; aucun renommage ; `organization/update` fermée) | une route `POST /console/workspaces/<id>` `{name}` (droit `manage-workspace`) ; le nom par défaut se calcule dans la console | non | non |
| S2 L'onglet d'origine continue après le clic du lien | Oui sans rien changer : cookie de même origine ; `BroadcastChannel` + relecture de `/console/me` | rien côté worker | non | non (touche l'écran de connexion) |
| S3 Compteurs de notes par site et par statut, dernière note, « Extension / Script » | Non : les notes ne sont pas dans PostgreSQL, aucune lecture par workspace, aucun enregistrement du canal | lecture agrégée par site ; un champ « canal » par note ; dépend de FRU-218 (les notes dans PostgreSQL, **fru-cadrage**) | **oui** (colonnes sur la table des notes, ou table d'index) | **oui** : donnée nouvelle, vie privée |
| S4 Lister les notes d'un workspace (filtres, recherche, pagination), y compris celles parties dans un tracker | Non | un **index des notes** dans la base (id, site, page, statut, auteur, destination, référence, date ; avec ou sans le texte) + `GET /console/workspaces/<id>/notes` | **oui** | **oui** : vie privée (`docs/privacy.md` : le texte d'une note envoyée à un tracker n'est pas gardé par Fruitback aujourd'hui) |
| S5 « Send again » d'une note non livrée | Oui pour REST (`…/deliveries/<d>/retry`) | relier la note à sa livraison | peut-être | non |
| S6 « Show on the page » | Non | un lien profond lu par le widget (fragment d'URL) | non | non |
| S7 Connexion de l'extension demandée par elle, approuvée dans la console | Non (`device-authorization` de better-auth est **refusé exprès** : `auth.ts`, `REFUSED_PLUGINS`) | à bâtir sur l'appairage maison : `POST /session/connect` (crée une demande, rend un secret de relève et le mot), `POST /console/connect/<id>/approve` (cookie), relève par l'extension → jeton de rafraîchissement tournant comme aujourd'hui | **oui** (table des demandes, ou colonnes sur `pairings`) | **oui** : authentification |
| S8 Une session d'extension pour tous les workspaces du compte | Non (`sessions.workspace` : un seul) | session liée au compte ; `GET /session/sites` rend les sites de tous ses workspaces | **oui** (colonne `account_id`, `workspace` facultatif) | **oui** : authentification |
| S9 Lister et couper ses navigateurs dans « My account » (console et extensions), avec « Chrome on macOS » | En partie : `GET /console/sessions`, `DELETE /console/sessions/<id>` existent et aucun écran ne les montre ; rien pour les sessions d'extension ; l'agent utilisateur n'est gardé que si `FRUITBACK_AUTH_TRACK_IP=1` | routes pour les sessions d'extension du compte ; un libellé de navigateur gardé à la connexion | **oui** | **oui** : vie privée (`docs/privacy.md` promet de ne pas garder l'agent utilisateur par défaut) |
| S10 Créer un site depuis l'extension | Non (`/console/*` refuse tout `Authorization` ; `manage-sites` passe par le cookie) | `POST /session/sites` avec le jeton de l'extension, rôle relu en base | non | **oui** : authentification |
| S11 Un motif de previews sans preuve de domaine | Non, et c'est voulu (FRU-103 : preuve DNS ; `extension` : « A wildcard would lend your session to every site it covers ») | décision avant tout code | — | **oui** : sécurité |
| S12 Rôle invité limité à un site, invitation qui nomme un site | Non (`SECURITY.md` : pas de guest tant qu'un site ne se partage pas à une personne) | table de partage site ↔ membre ; `invite-member` accepte `guest` + site ; `GET /feedback` et `/session/sites` filtrent | **oui** | **oui** : autorisation, vie privée |
| S13 Le lien d'invitation connecte | Non, et c'est écrit (`SECURITY.md` : « le lien n'a ni identifiant ni jeton ») | décision avant tout code (un lien magique dans l'e-mail d'invitation) | non | **oui** : authentification |
| S14 Changer son nom ; lier et délier GitHub / Google | Non (aucune édition du nom ; routes `link-social` / `unlink-account` fermées) | routes dédiées | non | **oui** : authentification |
| S15 « Last seen » d'un membre | Non | dernière activité par membre (session la plus récente) | peut-être | **oui** : vie privée (donnée nouvelle montrée aux autres membres) |
| S16 Répondre à une note depuis la page | Non (`NoteStore` : `create` et lecture ; aucun `POST` de commentaire) | `POST /feedback/<id>/replies` (membre vérifié), écrit dans le tracker ou la base | oui si la note est gardée par Fruitback | **oui** : écriture nouvelle sous identité vérifiée |
| S17 GitHub Issues, Jira, GitLab, Trello, Notion, Webhook comme connecteurs de workspace | Non (`linear` et `rest` seulement ; FRU-188 cadre GitHub) | un connecteur par source : hors de cette maquette | — | — |
| S18 « Attach a picture of the element » par connecteur | Non (FRU-198, Backlog) | réglage du connecteur | non | non |
| S19 Admin d'instance : rôle, lecture de tous les workspaces, comptes, notes ; suspendre ; réglages en base qui remplacent le `.env` ; politique d'inscription ; clés OAuth saisies à l'écran | Non, rien | un rôle d'instance, des routes `/console/admin/*`, une table de réglages scellés, un état « suspendu » sur compte et workspace | **oui** (plusieurs) | **oui** : authentification, secrets, vie privée, refus de démarrage |
| S20 « Backed up 4 h ago », « Up for 12 days », « Last link sent 3 min ago » | Non (le worker ne sait rien de ses sauvegardes) | à décider | — | — |

## 5. Ambiguïtés : l'option la plus simple, et sa raison

| # | Ambiguïté | Option proposée | Raison |
|---|---|---|---|
| A1 | Aucun thème sombre dans la maquette ; le widget et l'extension en ont un | Garder le sombre du widget et de l'extension ; n'y changer que les cinq couleurs de statut (mêmes teintes, éclaircies si le contraste mesuré l'exige) ; la console reste claire | ne rien retirer de ce qui marche ; `design-tokens.test.ts` mesure déjà les deux thèmes |
| A2 | Anglais seul ; `messages.test.ts` exige le français de chaque phrase | Chaque ticket écrit le français de ses phrases, avec le vocabulaire de `messages.fr.ts` (« workspace » reste « workspace », « note », « site », « connecteur ») | la CI le refuse sinon |
| A3 | Aucun état de chargement | Garder « Loading… » d'aujourd'hui, au style nouveau | non dessiné : ne rien inventer |
| A4 | Aucune erreur de formulaire | Garder les phrases de `problems.ts` / `SEND_PROBLEMS` et le composant `Problem`, recoloré | idem ; règle 3 du dépôt : ne jamais vider un champ |
| A5 | À 390 px les écrans à rail débordent dans la maquette | Rail en rangée défilante **sans** débordement du document (comme `main` depuis FRU-159) ; tolérance visuelle levée sur ce point | défaut de la maquette, déjà corrigé dans le produit |
| A6 | Menu « … » d'une ligne de site non dessiné | Trois entrées : « Install », « Change who sees the notes », « Remove » (avec le `Confirm` d'aujourd'hui) | ce sont les actions qui existent |
| A7 | « Add a site » (bouton de l'état liste) : formulaire non dessiné | Ouvre le formulaire de l'état vide (adresse + « Add site ») au-dessus de la table, avec le choix « Who sees the notes? » de la mise en place | réemploi de deux blocs dessinés |
| A8 | Sélecteur de workspace (`aria-haspopup="menu"`) non dessiné | Menu des workspaces du compte ; un seul workspace : bouton sans menu | `me.workspaces` existe déjà |
| A9 | « Rename », « Change » de la mise en place non dessinés | « Rename » : le nom devient un champ + « Save » / « Cancel » ; « Change » : rouvre l'étape 2 | le plus petit geste |
| A10 | L'aperçu « A preview of your site » montre un faux site | Une illustration fixe (la scène de la maquette), avec l'adresse du site dans la barre ; légende inchangée | un vrai aperçu (iframe ou capture) est une décision de produit et de vie privée (Q5) |
| A11 | Le panneau Linear ne montre plus les destinations par site | Garder la gestion des destinations d'aujourd'hui dans le panneau, sous « Sites sending here » | la retirer enlèverait une fonction livrée (FRU-123) sans que la maquette dise où elle va |
| A12 | Sources Jira, GitLab, Trello, Notion, Webhook avec « Connect » actif ; GitHub Issues connecté | Les lister avec leur phrase, bouton **désactivé** « After the beta » comme aujourd'hui ; GitHub Issues dans cette liste | aucun de ces connecteurs n'existe (S17) |
| A13 | « Use an API key » de Linear a disparu | La garder quand `linearOAuth` est faux (auto-hébergement sans application OAuth) | sinon une instance sans OAuth ne peut plus connecter Linear |
| A14 | La carte « Delete the workspace » a disparu de « My account » | La garder en bas de « My account » | seul endroit où un propriétaire supprime son workspace |
| A15 | « Remove » d'un membre non dessiné | Garder le `Confirm` « Remove » dans la colonne « Last seen » | fonction livrée |
| A16 | Le composer du widget n'est dessiné que pour un membre | Pour un visiteur sans compte : garder « Add my name (optional) » et « Remember me on this site » à la place de « As Mathieu, Sakuga » | décision de Mathieu : un visiteur laisse une note sans compte ; `docs/privacy.md` |
| A17 | « Keep for later » et le choix de destination absents du composer | Les garder | fonctions livrées (FRU-124, FRU-123) |
| A18 | Le bouton de liste du dock absent | Le garder | sans extension (script seul), c'est le seul moyen d'ouvrir la liste |
| A19 | La liste pousse la page de 428 px | La liste recouvre la page (comme aujourd'hui), largeur 380 px | pousser la page d'un site tiers casse sa mise en page |
| A20 | Widget à 390 px non dessiné | Garder la feuille du bas et les cibles tactiles d'aujourd'hui (FRU-157) | non dessiné |
| A21 | L'interrupteur du popup a une transition de fond, pas ceux de la console | La même transition partout (`background .2s`) | incohérence de la maquette |
| A22 | `#dd2c27` sur `#f4f4f5` = 4,28:1 (ligne sélectionnée de l'admin) | Écrire ce texte en `#b91c1c` sur fond `#f4f4f5` (5,89:1, calculé) | AA |
| A23 | « Rename » et « Change » : cible de ~21 px | Leur donner `padding: 8px 0` comme les autres boutons lien | WCAG 2.5.8 |
| A24 | Le script collé perd `data-fruitback-endpoint` | Ne l'omettre que sur le Cloud ; le garder en auto-hébergement | le script d'une instance doit connaître son worker |
| A25 | « Send again in 0:41 » | Compte à rebours de 60 s côté console ; le plafond du worker (3 liens par quart d'heure) reste | aucune route à changer |
| A26 | « Northwind », deuxième workspace | Les écrans listent `me.workspaces` | donnée d'exemple |
| A27 | Scène « Acme Outdoor », « ACM-142 », noms et dates | Données d'exemple : aucune n'entre dans le produit, sauf l'illustration A10 | — |
| A28 | Popup « Running your own Fruitback? Connect it in settings » ; page d'options non dessinée | Le lien ouvre la page d'options d'aujourd'hui, inchangée, recolorée par le socle | hors maquette |
| A29 | La planche du 2026-10-07 (`design/`) et sa règle « Build to it » | La maquette du 2026-10-13 la remplace pour les écrans qu'elle dessine ; `design/README.md` et `docs/decisions/console.md` le disent | sinon deux références se contredisent |

Les vraies décisions de produit, de sécurité ou de vie privée sont dans le rapport à l'orchestrateur et dans l'épopée Linear (questions Q1 à Q10).

## 6. Les tickets Linear (épopée FRU-230, créés le 2026-10-13)

« Critique » : migration, donnée nouvelle, authentification, vie privée, CI ou refus de démarrage ; à merger par Mathieu. La répartition en quatre agents et l'ordre des merges sont dans le commentaire de FRU-230.

| Ticket | Titre court | Écrans | Dépend de | Attend | Critique |
|---|---|---|---|---|---|
| FRU-231 | La maquette entre dans le dépôt | tous | — | — | non |
| FRU-232 | Socle de la console : jetons et kit | tous (console) | FRU-231 | Q1 | non |
| FRU-233 | Socle du widget, de l'extension, des e-mails | 05–08, 14–16 | FRU-231 | Q1 | non (visible chez les clients) |
| FRU-234 | Le cadre du workspace : rail sombre | 09–13 | FRU-232 | — | non |
| FRU-235 | Page « Sign in », onglet qui continue | 02 | FRU-232 | — | oui, par prudence (authentification, console seule) |
| FRU-236 | Renommer un workspace (worker) | 01 | — | — | non |
| FRU-237 | Résumé des sites : compteurs, dernière note, canal (worker) | 01, 06, 09 | FRU-218 | Q6 | **oui** |
| FRU-238 | L'extension demande, la console approuve (worker) | 04, 05 | — | Q8 | **oui** |
| FRU-239 | Mise en place : « Your account », « Your site » | 01 | FRU-235, FRU-236 | — | non |
| FRU-240 | « Connect this browser » (console) | 04 | FRU-235, FRU-238 | Q8 | **oui** |
| FRU-241 | L'écran d'une invitation | 03 | FRU-235 | Q2 | non tel quel |
| FRU-242 | Mise en place : étape 3, aperçu, première note | 01 | FRU-239 (FRU-237 pour la détection) | Q5 | non |
| FRU-243 | « Sites » | 09 | FRU-234 (FRU-237 pour trois colonnes) | Q4 | non |
| FRU-244 | Lister les notes d'un workspace (worker) | 10, 20 | FRU-237 | Q6 | **oui** |
| FRU-245 | « Notes » (console) | 10 | FRU-234, FRU-244 | — | non (après FRU-244) |
| FRU-246 | « Connectors » | 11 | FRU-234 | — | non |
| FRU-247 | « Members » | 12 | FRU-234 | Q7 pour « Last seen » | non |
| FRU-248 | « My account », avec les routes d'aujourd'hui | 13 | FRU-234 | — | oui, par prudence (sessions) |
| FRU-249 | Mon compte : nom, comptes liés, navigateurs de l'extension | 13 | FRU-238, FRU-248 | Q7 | **oui** |
| FRU-250 | L'invité d'un seul site | 03, 12 | FRU-241, FRU-247 | Q3 | **oui** |
| FRU-251 | Popup : coquille et « Sign in to Fruitback » | 05 | FRU-233, FRU-238 | Q8 | **oui** |
| FRU-252 | Widget : pins, cadre, dock | 14–16 | FRU-233 | — | non |
| FRU-253 | « Show on the page » : lien profond | 10 | — | — | non |
| FRU-254 | Popup sur un site du workspace | 06, 07 | FRU-251 (FRU-237 pour les compteurs du site) | — | non |
| FRU-255 | Ajouter un site depuis le popup | 08 | FRU-251, FRU-238 | Q4 | **oui** |
| FRU-256 | Widget : la bulle d'une note | 14 | FRU-252 | — | non |
| FRU-257 | Répondre à une note depuis la page | 14 | FRU-256 | Q9 | **oui** |
| FRU-258 | Widget : capture et composer | 15 | FRU-252 | — | non (vie privée à surveiller : image) |
| FRU-259 | Widget : la liste des notes | 16 | FRU-252 | — | non |
| FRU-260 | Cadrage de l'administration d'instance | 17–20 | — | Q10 | sans objet (pas de code) |
| FRU-261 | Admin d'instance : drapeau, garde, lectures (worker) | 17–19 | FRU-260, FRU-221 | Q10 | **oui** |
| FRU-262 | Administration : cadre et « Instance », en lecture | 17 | FRU-261, FRU-234 | Q10 | oui |
| FRU-263 | Administration : « Workspaces » et « Users », en lecture | 18, 19 | FRU-262 | Q10 | oui |

Non couverts par un ticket, exprès : les actions de l'administration (suspendre, supprimer, créer, changer un propriétaire), l'écran « Notes » de l'instance (20), les réglages d'instance en base : ils attendent FRU-260. Les connecteurs GitHub Issues, Jira, GitLab, Trello, Notion, Webhook : hors de cette maquette (FRU-188 pour GitHub). « Attach a picture of the element » par connecteur : FRU-198.
