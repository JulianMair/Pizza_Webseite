'use strict';

// Setzt das Admin Passwort zurück und beendet alle bestehenden Sessions.
// Aufruf: docker compose exec app node src/cli/reset-password.js "NeuesPasswort"
const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Aufruf: node src/cli/reset-password.js <neues Passwort, mindestens 8 Zeichen>');
  process.exit(1);
}

const auth = require('../auth');
const { db } = require('../db');

auth.setPassword(password);
db.close();
console.log('Admin Passwort wurde geändert. Bestehende Sessions sind abgemeldet.');
