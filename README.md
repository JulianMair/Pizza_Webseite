# Pizza Vorbestellung mit Zeitslots

Selbst hostbares Vorbestellsystem für Pizzerien, Foodtrucks und Pizzaabende im Verein. Kunden wählen Pizzen, Abholung oder Lieferung und einen freien Zeitslot. In der Küchenansicht sieht das Team alle Bestellungen pro Slot inklusive Backzusammenfassung. Beim Klick auf **Fertig** bekommt der Kunde automatisch eine WhatsApp Nachricht (über [WAHA](https://waha.devlike.pro/)) und eine Mail.

**Stack:** Node.js 22, Express 5, SQLite (better-sqlite3), Alpine.js, Tailwind CSS 4, Nodemailer, Docker. Keine externen CDNs oder Webfonts: alles wird vom eigenen Server ausgeliefert.

## Funktionen

**Shop für Kunden** (Layout angelehnt an RestroPress)

* Desktop: Kategorien links, Speisekarte in der Mitte, mitscrollender Warenkorb rechts. Mobil: Warenkorb Balken unten, der sich als Panel öffnet.
* Ausverkaufte Artikel werden ausgegraut angezeigt und lassen sich nicht bestellen.
* Abholung oder Lieferung. Lieferung ist erst ab einer einstellbaren Anzahl Pizzen wählbar, darunter erscheint "Lieferung erst ab X Pizzen möglich, es fehlen noch Y".
* Zeitslots als Button Raster, nach Tagen gruppiert. Ein Slot ist nur wählbar, wenn **eine weitere Bestellung** (`max_orders`) und **alle Pizzen des Warenkorbs** (`max_items`) noch hineinpassen. Volle Slots sind ausgegraut und zeigen die Restkapazität.
* Pflichtfelder Name, Telefon (mit Hinweis auf WhatsApp Status Updates) und Mail. Bei Lieferung zusätzlich Straße/Hausnummer und Ort/Hinweise. Optionale Notiz für Sonderwünsche.
* Bestätigungsseite mit Bestellnummer und Zeitslot. Optional Eingangsbestätigung per Mail und/oder WhatsApp.

**Admin Bereich** (`/admin`, mit Passwort geschützt)

1. **Bestellungen (Live Küchenansicht):** gruppiert nach Zeitslot, Kopfzeile mit Auslastung ("18:30 Uhr, 3/5 Bestellungen, 9/12 Pizzen") und Backzusammenfassung ("4x Margherita, 3x Salami"). Bestellkarten mit Status `Offen`, `In Zubereitung`, `Fertig` (plus `Storniert`, gibt den Platz im Slot wieder frei). Neue Bestellungen erscheinen sofort per Server Sent Events, optional mit Signalton. Zu jeder Bestellung wird angezeigt, ob WhatsApp und Mail erfolgreich verschickt wurden, mit Fehlertext und Button "erneut senden".
2. **Speisekarte:** Kategorien und Artikel anlegen, bearbeiten, löschen. Schalter Verfügbar/Ausverkauft direkt in der Liste. Pro Artikel der Schalter **"zählt als Pizza"**: nur diese Artikel zählen für die Slot Kapazität und die Liefer Mindestmenge, Getränke belegen also keinen Ofenplatz.
3. **Einstellungen & Zeitslots:** Slot Generator (Zeitraum, Wochentage, Start, Ende, Intervall, Limits), einzelne Slots anlegen, Limits pro Slot ändern, Slots sperren oder löschen. Bestellannahme pausieren, Mindestanzahl für Lieferung, Vorlaufzeit. WAHA und SMTP Zugangsdaten mit Testversand, frei editierbare Vorlagen. Admin Passwort ändern, alte Daten löschen.

## Schnellstart mit Docker

Voraussetzung: Docker mit Compose Plugin.

```bash
git clone https://github.com/JulianMair/Pizza_Webseite.git
cd Pizza_Webseite
cp .env.example .env
# .env bearbeiten: mindestens ADMIN_PASSWORD, WAHA_API_KEY und WAHA_DASHBOARD_PASSWORD setzen
docker compose up -d --build
```

* Shop: <http://localhost:3000>
* Admin: <http://localhost:3000/admin> (Benutzer und Passwort aus `.env`)

Die Datenbank liegt in `./data/pizza.db` und wird beim ersten Start automatisch angelegt, inklusive einer Demo Speisekarte und Slots für heute und morgen (abschaltbar mit `SEED_DEMO_DATA=false`).

Ohne WhatsApp: in der `.env` die Zeile `COMPOSE_PROFILES=waha` auskommentieren. Dann startet nur der Shop.

## WhatsApp über WAHA einrichten

WAHA ist eine selbst gehostete WhatsApp HTTP API, die als zusätzlicher Container mitläuft. Die App schickt Nachrichten per `POST {WAHA_URL}/api/sendText` mit dem Body `{"chatId": "491711234567@c.us", "text": "...", "session": "default"}` und dem Header `X-Api-Key`. Telefonnummern werden automatisch umgewandelt: `0171 1234567`, `+49 171 1234567` und `0049 171 1234567` werden zu `491711234567@c.us`.

1. In der `.env` einen langen Zufallswert als `WAHA_API_KEY` eintragen, zum Beispiel erzeugt mit `openssl rand -hex 24`. Derselbe Wert gilt automatisch für WAHA und für die App.
2. `docker compose up -d` ausführen.
3. Das WAHA Dashboard öffnen: <http://localhost:3001/dashboard>. Aus Sicherheitsgründen ist es nur auf dem Server selbst erreichbar. Von einem anderen Rechner per SSH Tunnel: `ssh -L 3001:localhost:3001 benutzer@server`, danach im eigenen Browser <http://localhost:3001/dashboard> öffnen.
4. Mit `WAHA_DASHBOARD_USERNAME` und `WAHA_DASHBOARD_PASSWORD` anmelden, im Dashboard den API Key hinterlegen, die Session `default` starten und den QR Code mit dem Handy scannen (WhatsApp, Verknüpfte Geräte, Gerät hinzufügen).
5. Im Admin Bereich unter **Einstellungen & Zeitslots, WhatsApp (WAHA)** eine Testnachricht an die eigene Nummer schicken.

Läuft WAHA bereits woanders, `COMPOSE_PROFILES` auskommentieren und `WAHA_URL` auf die vorhandene Instanz setzen (oder im Admin Bereich eintragen).

Solange keine Session verbunden ist, meldet die App zum Beispiel `WAHA Fehler HTTP 422: Session "default" does not exist`. Der Status der Bestellung wird trotzdem gespeichert.

> **Wichtig:** WAHA nutzt WhatsApp Web und ist keine offizielle Schnittstelle von Meta. WhatsApp kann Nummern sperren, die automatisiert Nachrichten verschicken. Empfehlung: eine eigene Nummer für den Shop verwenden und nur Kunden anschreiben, die tatsächlich bestellt haben. Die kostenlose WAHA Core Version unterstützt genau eine Session namens `default`.

## Mailversand per SMTP

Zugangsdaten entweder in der `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) oder im Admin Bereich unter **E-Mail (SMTP)** eintragen und eine Testmail senden.

* Port 587 mit STARTTLS: `SMTP_SECURE=false`
* Port 465 mit SSL/TLS: `SMTP_SECURE=true`

Ohne SMTP Host und Absenderadresse wird der Mailversand übersprungen und in der Küchenansicht als "übersprungen" angezeigt.

## Einstellungen aus der .env und aus dem Admin Bereich

Die Werte für WAHA und SMTP aus der `.env` gelten als Vorbelegung. Sobald ein Bereich im Admin gespeichert wurde, haben die Werte aus der Datenbank Vorrang. Passwort Felder bleiben beim Speichern unverändert, wenn sie leer gelassen werden; gespeicherte Geheimnisse werden nie an den Browser ausgeliefert.

| Variable | Standard | Bedeutung |
|---|---|---|
| `APP_PORT` | `3000` | Port des Shops auf dem Host |
| `ADMIN_USER` | `admin` | Benutzername für `/admin` |
| `ADMIN_PASSWORD` | leer | Admin Passwort. Leer: beim ersten Start wird ein Passwort erzeugt und im Log ausgegeben |
| `SESSION_SECRET` | automatisch | Schlüssel für Login Cookies |
| `APP_TIMEZONE` | `Europe/Berlin` | Zeitzone für Slots und Vorlaufzeit |
| `COOKIE_SECURE` | `false` | `true` hinter HTTPS |
| `TRUST_PROXY` | `false` | `1` hinter einem Reverse Proxy |
| `ORDER_RATE_LIMIT` | `60` | Bestellungen pro IP in 10 Minuten |
| `SEED_DEMO_DATA` | `true` | Demo Daten beim ersten Start |
| `WAHA_URL` | `http://waha:3000` | WAHA Basis URL |
| `WAHA_SESSION` | `default` | WAHA Session |
| `WAHA_API_KEY` | leer | API Key für WAHA (Container und App) |
| `COMPOSE_PROFILES` | `waha` | WAHA Container mitstarten |
| `WAHA_PORT`, `WAHA_BIND` | `3001`, `127.0.0.1` | Erreichbarkeit des WAHA Dashboards |
| `WAHA_DASHBOARD_USERNAME`, `WAHA_DASHBOARD_PASSWORD` | `admin`, leer | Login für das WAHA Dashboard |
| `SMTP_*` | leer | SMTP Vorbelegung, siehe oben |

## Betrieb im Internet

Für den öffentlichen Betrieb gehört ein Reverse Proxy mit HTTPS davor, zum Beispiel Caddy:

```
pizza.example.com {
    reverse_proxy localhost:3000
}
```

Dann in der `.env` `COOKIE_SECURE=true` und `TRUST_PROXY=1` setzen. Bei nginx für die Live Ansicht `proxy_buffering off;` aktivieren (die App sendet zusätzlich `X-Accel-Buffering: no`).

Impressum und Datenschutzerklärung sind Sache des Betreibers. Die Links dazu lassen sich unter **Bestellannahme** hinterlegen und erscheinen im Footer und im Checkout.

## Wartung

* **Backup:** Container stoppen und `./data/pizza.db` kopieren, oder im laufenden Betrieb `sqlite3 data/pizza.db ".backup backup.db"`.
* **Admin Passwort vergessen:** `docker compose exec -u node app node src/cli/reset-password.js "NeuesPasswort"`
* **Update:** `git pull && docker compose up -d --build`
* **Logs:** `docker compose logs -f app` (Fehler beim WhatsApp oder Mailversand erscheinen mit Bestellnummer)
* **Datensparsamkeit:** Unter **Sicherheit & Daten** lassen sich Bestellungen inklusive Kundendaten löschen, die älter als N Tage sind.

## Lokale Entwicklung ohne Docker

```bash
npm install
npm run build:css     # erzeugt public/css/app.css
npm run dev           # Server mit Auto Reload auf http://localhost:3000
npm run watch:css     # optional in zweitem Terminal
npm test              # Unit und Integrationstests
```

## Wie die Kapazitätsprüfung funktioniert

Der Shop graut Slots bereits im Browser aus. Entscheidend ist aber die Prüfung beim Absenden: Die Bestellung läuft in einer SQLite Transaktion mit `BEGIN IMMEDIATE`. Darin werden Artikel und Preise aus der Datenbank geladen (Preise aus dem Browser werden ignoriert), die aktuelle Auslastung des Slots frisch gezählt und erst dann gespeichert. Zwei Kunden können den letzten Platz also nicht gleichzeitig bekommen; der zweite erhält eine Meldung und wählt einen anderen Slot. Ein Integrationstest schickt 20 parallele Bestellungen auf einen Slot mit 5 Plätzen und erwartet genau 5 Erfolge.

## Projektstruktur

```
├── Dockerfile, docker-entrypoint.sh, docker-compose.yml, .env.example
├── frontend/styles.css        Tailwind Quelle
├── public/
│   ├── index.html, js/shop.js     Shop (Alpine.js)
│   └── admin.html, js/admin.js    Admin Bereich (Alpine.js)
├── src/
│   ├── server.js              Express Setup
│   ├── config.js, db.js       Konfiguration, Schema, Demo Daten
│   ├── settings.js, auth.js   Einstellungen, Login
│   ├── events.js              Live Updates (SSE)
│   ├── routes/                public.js, admin.js
│   ├── services/              orders, slots, menu, notify, whatsapp, mailer, templates
│   └── cli/reset-password.js
└── test/                      node:test Tests
```

## Bewusst nicht enthalten

Online Bezahlung, Artikelbilder, Extras/Beläge als Auswahl (Sonderwünsche laufen über die Notiz), Prüfung des Liefergebiets, Liefergebühr und eine Statusseite für Kunden.
