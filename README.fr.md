# PocketClaude

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md)

Une PWA auto-hébergée pour **contrôler et surveiller à distance les sessions Claude Code de votre ordinateur**, depuis votre téléphone ou n'importe quel navigateur. Elle pilote votre CLI `claude` local déjà connecté (fonctionne avec votre abonnement Max/Pro — **aucun coût d'API supplémentaire**), accessible partout via un tunnel Cloudflare.

- Suivez toutes les conversations Claude Code en direct
- Envoyez des prompts pour reprendre une session récente — ou en démarrer une nouvelle
- **Approbation par outil** : avant que Claude n'exécute un outil, recevez une notification push et touchez autoriser/refuser
- **Streaming token par token + relances en cours de tâche** : les réponses s'affichent au fil de l'écriture ; envoyer à une session active l'alimente au processus en cours (exécuté au tour suivant, sans démarrage à froid) ; les sessions tournent en parallèle
- Connexion par clé (générée automatiquement au premier lancement)
- Rendu Markdown propre (assaini par DOMPurify), coloration syntaxique, coller/joindre des images
- Voir les images / audio / vidéos / PDF générés par Claude ; prévisualiser un dev server sur le téléphone
- Explorateur de fichiers intégré + lecteur Markdown
- **8 langues d'interface**, thèmes clair/sombre, effort de réflexion réglable, saisie vocale
- Installable comme app, notifications push à la fin des tâches — localisées par appareil
- Fonctionne hors ligne / derrière un pare-feu (tous les assets auto-hébergés)

> ⚠️ **Elle contrôle la machine sur laquelle elle tourne.** Lancée sur l'ordinateur A, elle ne contrôle que le Claude de A. Elle lit le `~/.claude` local et invoque le CLI `claude` local.

---

## Prérequis

- **Node.js 18+**
- **Claude Code / Claude Desktop installé et connecté** (abonnement Max ou Pro) — si `claude` fonctionne dans votre terminal, c'est bon
- (pour l'accès distant) **cloudflared** — pas d'installation préalable, exécuté via `npx`

Fonctionne sous **Windows / macOS / Linux** (chemin du CLI et répertoires de données détectés automatiquement).

## Installation

```bash
git clone https://github.com/SakuraNeco/PocketClaude.git
cd PocketClaude
npm install
```

## Lancement

```bash
npm start
```

Vous verrez :

```
PocketClaude server → http://localhost:3000
login key:   xxxxxxxxxxxxxxxxxxxxxxxx
claude CLI:  /path/to/claude
```

Ouvrez <http://localhost:3000> et saisissez la **login key** du journal de démarrage (une fois par appareil).

> La clé est stockée dans `.auth-token` (gitignore) — supprimez-la et redémarrez pour en générer une nouvelle, ou définissez `CC_AUTH_TOKEN`. Si la ligne `claude CLI` est erronée, copiez `.env.example` vers `.env` et pointez `CLAUDE_PATH` vers votre `claude`.

## Accès depuis le téléphone (tunnel Cloudflare)

```bash
npm run tunnel
```

Affiche une URL `https://xxxx.trycloudflare.com` — ouvrez-la sur votre téléphone et saisissez la clé. Pour une URL stable, utilisez un [tunnel nommé](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) Cloudflare pointant vers `http://localhost:3000`.

> ⚠️ **Vous utilisez votre propre domaine (tunnel nommé) ?** Les règles WAF gérées de Cloudflare renvoient 403 sur des chemins comme `/node_modules/…`, cassant les aperçus `/proxy` des dev servers Vite. Ajoutez une règle personnalisée dans le tableau de bord Cloudflare : Hostname égal à votre sous-domaine → action **Skip** (cochez toutes les règles gérées + toutes les règles personnalisées restantes). PocketClaude possède sa propre authentification par clé et ne dépend pas du WAF.

## Installer comme app + push

1. Ouvrez l'URL https dans le navigateur du téléphone
2. Ajouter à l'écran d'accueil
3. Ouvrez depuis l'icône et touchez **Activer les notifications** (le push web iOS ne fonctionne qu'après l'ajout à l'écran d'accueil)

---

## Utilisation

- Choisissez la conversation dans le sélecteur **Envoyer à**, écrivez, envoyez.
- **Modes de permission** :
  | Mode | Comportement |
  |------|-----------|
  | Approuver chaque `interactive` | Chaque appel d'outil est poussé sur le téléphone ; autorisez/refusez (refus auto après 120 s) |
  | Auto-édition `acceptEdits` (défaut) | Modifications de fichiers auto-approuvées |
  | Tout auto `bypassPermissions` | Tout autorisé — le plus capable, le moins protégé |
  | Mode plan `plan` | Planifie seulement, aucun changement |
- **Modèle** : Défaut / Fable 5 / Opus / Sonnet / Haiku · **Effort** : Défaut / Faible / Moyen / Élevé / Très élevé / Max
- En haut à droite : **langue** (8) et **thème**. À côté du champ : **saisie vocale**.
- Le bouton **Fichiers** de la barre latérale explore le dossier de la session ; les `.md` s'ouvrent dans le lecteur intégré.

### Notes / limites connues

- **Sessions de streaming persistantes** : les réponses s'affichent token par token ; un envoi vers une session occupée est transmis au processus en cours (exécuté après le tour actuel, sans démarrage à froid), pour ajouter des consignes ou relancer sans redémarrage. Les sessions tournent en parallèle ; chaque processus se ferme après 5 min d'inactivité.
- **Impossible de contrôler la propre session de PocketClaude** depuis le web (elle redémarrerait et tuerait le serveur) — bloqué automatiquement.
- Les messages vers une session **ouverte dans Desktop** sont écrits dans le fichier mais n'apparaissent dans cette fenêtre qu'après réouverture.
- **Pas de redémarrage automatique** : fermer le terminal / redémarrer / un crash l'arrête. Utilisez `pm2`, `launchd` (mac) ou le Planificateur de tâches (win).

## Sécurité

- Tout sauf le shell de la PWA exige la clé (comparaison timing-safe ; cookie HttpOnly).
- `/media` et `/files` sont confinés à votre répertoire personnel (avec vérification des limites de chemin).
- L'approbation interactive est **fail-closed** : si le pont n'atteint pas le serveur, il refuse.
- Tout le Markdown est assaini par DOMPurify ; les fichiers texte (HTML compris) sont servis en `text/plain`.
- `/proxy` n'atteint que les ports référencés par une session (étendez avec `CC_PROXY_ALLOW`).
- `/auth` limite la force brute ; les sessions sous le répertoire temporaire de l'OS sont masquées.
- `.audit.log` consigne connexions, envois, arrêts et décisions de permission.

## Variables d'environnement (toutes optionnelles — voir `.env.example`)

| Variable | Description |
|----------|-------------|
| `PORT` | Port du serveur (3000 par défaut) |
| `CLAUDE_PATH` | Chemin du CLI `claude` (auto-détecté sinon) |
| `CC_AUTH_TOKEN` | Clé de connexion (auto-générée dans `.auth-token` sinon) |
| `CC_PROXY_ALLOW` | Ports supplémentaires autorisés pour `/proxy` (séparés par des virgules) |
| `VAPID_SUBJECT` | Contact Web Push `mailto:` |

Les clés VAPID, la clé de connexion, les abonnements push et les uploads sont générés **par installation** et gitignorés.

## Développement

```bash
npm test        # node --test — tests unitaires des fonctions pures
node --check server.js
```

La CI exécute vérification de syntaxe + tests sur Node 18/20/22.

## Licence

MIT
