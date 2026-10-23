'use strict';

const config = require('./config');

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Liefert Datum und Uhrzeit eines Zeitpunkts in der konfigurierten Zeitzone.
function localParts(at = Date.now()) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function today() {
  return localParts().date;
}

// Vergleichbarer Schlüssel für lokale Wandzeit, z. B. "2026-10-24 18:30".
function slotKey(date, time) {
  return `${date} ${time}`;
}

// Ein Slot ist buchbar, wenn er mindestens leadMinutes in der Zukunft liegt.
function isSlotPast(date, time, leadMinutes = 0) {
  const cutoff = localParts(Date.now() + Math.max(0, leadMinutes) * 60000);
  return slotKey(date, time) < slotKey(cutoff.date, cutoff.time);
}

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

const dateLabelFormatter = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatDateDe(date) {
  return dateLabelFormatter.format(new Date(`${date}T12:00:00Z`));
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  localParts,
  today,
  isSlotPast,
  addDays,
  weekday,
  formatDateDe,
  isValidDate,
  isValidTime,
  timeToMinutes,
  minutesToTime,
  nowIso,
};
