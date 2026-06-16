# Deploy auf GitHub Pages

Dieser Ordner ist repo-fertig. `index.html` ist bereits der richtige Einstieg
(lädt die neue modulare Engine). Es ist **kein Build** nötig.

## Schritte

1. Den **gesamten Inhalt dieses Ordners** ins Repo legen (alle Dateien + die
   Ordner `sim/ net/ render/ ui/ app/ .github/` und **dein `assets/`-Ordner**, siehe unten).
2. GitHub → **Settings → Pages → Source: „GitHub Actions"** einmalig auswählen.
3. Push auf `main`. Der mitgelieferte Workflow (`.github/workflows/pages.yml`)
   deployt automatisch; die Seite erscheint unter `https://<user>.github.io/<repo>/`.

Alternativ ohne Workflow: **Settings → Pages → Deploy from a branch → `main` / `/root`**.
Die Datei `.nojekyll` sorgt dafür, dass alle Dateien unverändert ausgeliefert werden.

## Zwei Dinge, die DU mitbringen musst

1. **`assets/`-Ordner.** Kopiere deinen bestehenden `assets/`-Ordner aus dem
   Originalprojekt unverändert hier hinein (Bildnamen mit Endung `.PNG`,
   Großschreibung — wichtig, da GitHub case-sensitive ist). Ohne ihn läuft das
   Spiel mit Platzhalter-Grafiken; mit ihm sieht es wie gewohnt aus.
   Audio liegt unter `assets/audio/music_menu.mp3` und `assets/audio/music_game.mp3`.

2. **Firebase-Config** (nur für Multiplayer). In `net/firebase.js` steht
   `apiKey: "redacted"`. Trag dort deine echte Firebase-Web-Config ein — am
   einfachsten den `firebaseConfig`-Block aus deiner alten
   `firebase-multiplayer.js` 1:1 hineinkopieren. Für Single-Player ist nichts
   nötig. Sichere die Datenbank über **Realtime Database Security Rules** ab
   (der Key darf öffentlich im Repo stehen).

## Wichtig (Stolperfallen)

- **Case-Sensitivity:** GitHub/Linux unterscheidet Groß-/Kleinschreibung. Alle
  Bildpfade enden auf `.PNG` (großgeschrieben, Entscheidung D1). Deine Asset-
  Dateien müssen exakt so heißen, sonst werden sie online nicht gefunden
  (auch wenn es lokal unter Windows/macOS funktioniert hat).
- **Kein `file://`:** ES-Module + Service Worker brauchen http(s). GitHub Pages
  erfüllt das. Lokales Testen: `npx serve .`, nicht per Doppelklick öffnen.
- **Relative Pfade:** Alles nutzt `./`-Pfade, läuft also auch im Unterpfad
  `user.github.io/repo/` ohne Anpassung.
- **Tests (optional):** `npm test` führt die Determinismus-/Lockstep-Tests aus
  (laufen auch in GitHub Actions, falls du es erweitern willst).

## Was im Repo liegt
Laufzeit: `index.html`, `style.css`, `mobile.css`, `manifest.json`, `sw.js`,
`database.js`, `database-ext.js`, `save.js`, `sim/`, `net/`, `render/`, `ui/`, `app/`.
Doku/Dev: `README.md`, `DEPLOY.md`, `package.json`, `build.mjs`, `tests/`, `.gitignore`,
`.nojekyll`, `.github/workflows/pages.yml`.
Nicht enthalten (bewusst): die alte `index.html`, `firebase-multiplayer.js`,
`systems.legacy.js`.
