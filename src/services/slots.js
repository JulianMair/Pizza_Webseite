'use strict';

const { db } = require('../db');
const settings = require('../settings');
const time = require('../time');
const { badRequest, notFound, conflict } = require('../errors');

const SLOT_SELECT = `
  SELECT t.id, t.date, t.time, t.max_orders, t.max_items, t.locked,
         COALESCE(u.orders_count, 0) AS orders_count,
         COALESCE(u.items_count, 0) AS items_count,
         COALESCE(u.all_orders, 0) AS all_orders
  FROM timeslots t
  LEFT JOIN (
    SELECT timeslot_id,
           SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS orders_count,
           SUM(CASE WHEN status != 'cancelled' THEN capacity_count ELSE 0 END) AS items_count,
           COUNT(*) AS all_orders
    FROM orders
    GROUP BY timeslot_id
  ) u ON u.timeslot_id = t.id
`;

const stmts = {
  upcoming: db.prepare(`${SLOT_SELECT} WHERE t.date >= ? AND t.date <= ? ORDER BY t.date, t.time`),
  byDate: db.prepare(`${SLOT_SELECT} WHERE t.date = ? ORDER BY t.time`),
  byId: db.prepare(`${SLOT_SELECT} WHERE t.id = ?`),
  insert: db.prepare('INSERT OR IGNORE INTO timeslots (date, time, max_orders, max_items, locked) VALUES (?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE timeslots SET max_orders = ?, max_items = ?, locked = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM timeslots WHERE id = ?'),
  removeFreeByDate: db.prepare('DELETE FROM timeslots WHERE date = ? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.timeslot_id = timeslots.id)'),
  dates: db.prepare(`
    SELECT t.date,
           COUNT(*) AS slot_count,
           COALESCE(SUM(u.active_orders), 0) AS order_count
    FROM timeslots t
    LEFT JOIN (
      SELECT timeslot_id, SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS active_orders
      FROM orders GROUP BY timeslot_id
    ) u ON u.timeslot_id = t.id
    WHERE t.date >= ?
    GROUP BY t.date
    ORDER BY t.date
  `),
};

function decorate(slot, leadMinutes) {
  const past = time.isSlotPast(slot.date, slot.time, leadMinutes);
  return {
    id: slot.id,
    date: slot.date,
    time: slot.time,
    max_orders: slot.max_orders,
    max_items: slot.max_items,
    locked: Boolean(slot.locked),
    orders_count: slot.orders_count,
    items_count: slot.items_count,
    all_orders: slot.all_orders,
    remaining_orders: Math.max(0, slot.max_orders - slot.orders_count),
    remaining_items: Math.max(0, slot.max_items - slot.items_count),
    past,
  };
}

// Prüft beide Limits: eine weitere Bestellung und die Pizzen des Warenkorbs müssen passen.
function checkBookable(slot, capacityCount) {
  if (slot.locked) return { ok: false, reason: 'Dieser Zeitslot ist gesperrt.' };
  if (slot.past) return { ok: false, reason: 'Dieser Zeitslot ist nicht mehr buchbar.' };
  if (slot.orders_count + 1 > slot.max_orders) return { ok: false, reason: 'Dieser Zeitslot ist ausgebucht.' };
  if (slot.items_count + capacityCount > slot.max_items) {
    const free = Math.max(0, slot.max_items - slot.items_count);
    return { ok: false, reason: `In diesem Zeitslot sind nur noch ${free} Pizzen frei.` };
  }
  return { ok: true };
}

// Kommende, noch buchbare Slots für das Kunden Frontend (60 Tage im Voraus).
function listUpcoming() {
  const lead = settings.getInt('lead_minutes');
  const start = time.today();
  return stmts.upcoming
    .all(start, time.addDays(start, 60))
    .map((s) => decorate(s, lead))
    .filter((s) => !s.past)
    .map(({ all_orders: _ignored, past: _past, ...s }) => s);
}

function listByDate(date) {
  if (!time.isValidDate(date)) throw badRequest('Ungültiges Datum.');
  const lead = settings.getInt('lead_minutes');
  return stmts.byDate.all(date).map((s) => decorate(s, lead));
}

function getById(id) {
  const row = stmts.byId.get(id);
  return row ? decorate(row, settings.getInt('lead_minutes')) : null;
}

function listDates(fromDate) {
  return stmts.dates.all(fromDate);
}

function limit(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw badRequest(`${name} muss eine ganze Zahl von 0 bis 10000 sein.`);
  return n;
}

function createSlot(input) {
  const { date, time: slotTime } = input;
  if (!time.isValidDate(date)) throw badRequest('Ungültiges Datum.');
  if (!time.isValidTime(slotTime)) throw badRequest('Ungültige Uhrzeit (Format HH:MM).');
  const maxOrders = limit(input.max_orders, 'Max. Bestellungen');
  const maxItems = limit(input.max_items, 'Max. Pizzen');
  const result = stmts.insert.run(date, slotTime, maxOrders, maxItems, input.locked ? 1 : 0);
  if (result.changes === 0) throw conflict(`Für ${date} um ${slotTime} existiert bereits ein Slot.`);
  return getById(result.lastInsertRowid);
}

// Erzeugt Slots für einen Datumsbereich und ausgewählte Wochentage (0 = Sonntag).
// Das Ende ist inklusive, bestehende Slots werden übersprungen.
function generate(input) {
  const { date_from: from, date_to: to, start, end } = input;
  if (!time.isValidDate(from) || !time.isValidDate(to)) throw badRequest('Ungültiger Datumsbereich.');
  if (to < from) throw badRequest('Das Enddatum liegt vor dem Startdatum.');
  if (!time.isValidTime(start) || !time.isValidTime(end)) throw badRequest('Ungültige Uhrzeit (Format HH:MM).');
  const startMin = time.timeToMinutes(start);
  const endMin = time.timeToMinutes(end);
  if (endMin < startMin) throw badRequest('Die Endzeit liegt vor der Startzeit.');
  const interval = Number(input.interval);
  if (!Number.isInteger(interval) || interval < 5 || interval > 720) throw badRequest('Intervall muss zwischen 5 und 720 Minuten liegen.');
  const maxOrders = limit(input.max_orders, 'Max. Bestellungen');
  const maxItems = limit(input.max_items, 'Max. Pizzen');
  const weekdays = Array.isArray(input.weekdays) && input.weekdays.length
    ? new Set(input.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))
    : new Set([0, 1, 2, 3, 4, 5, 6]);

  if (to > time.addDays(from, 366)) throw badRequest('Maximal ein Jahr auf einmal erzeugen.');
  const dates = [];
  for (let d = from; d <= to; d = time.addDays(d, 1)) {
    if (weekdays.has(time.weekday(d))) dates.push(d);
  }
  const times = [];
  for (let m = startMin; m <= endMin; m += interval) times.push(time.minutesToTime(m));
  if (dates.length * times.length > 5000) throw badRequest('Zu viele Slots auf einmal (maximal 5000).');

  let created = 0;
  db.transaction(() => {
    for (const d of dates) {
      for (const t of times) created += stmts.insert.run(d, t, maxOrders, maxItems, 0).changes;
    }
  })();
  return { created, skipped: dates.length * times.length - created, dates: dates.length };
}

function updateSlot(id, input) {
  const slot = getById(id);
  if (!slot) throw notFound('Slot nicht gefunden.');
  const maxOrders = input.max_orders === undefined ? slot.max_orders : limit(input.max_orders, 'Max. Bestellungen');
  const maxItems = input.max_items === undefined ? slot.max_items : limit(input.max_items, 'Max. Pizzen');
  const locked = input.locked === undefined ? slot.locked : Boolean(input.locked);
  stmts.update.run(maxOrders, maxItems, locked ? 1 : 0, id);
  return getById(id);
}

function deleteSlot(id) {
  const slot = getById(id);
  if (!slot) throw notFound('Slot nicht gefunden.');
  if (slot.all_orders > 0) {
    throw conflict('Dieser Slot hat bereits Bestellungen und kann nicht gelöscht werden. Sperre ihn stattdessen.');
  }
  stmts.remove.run(id);
}

function deleteFreeSlotsByDate(date) {
  if (!time.isValidDate(date)) throw badRequest('Ungültiges Datum.');
  return stmts.removeFreeByDate.run(date).changes;
}

module.exports = {
  checkBookable,
  listUpcoming,
  listByDate,
  listDates,
  getById,
  createSlot,
  generate,
  updateSlot,
  deleteSlot,
  deleteFreeSlotsByDate,
};
