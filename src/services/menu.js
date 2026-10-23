'use strict';

const { db } = require('../db');
const time = require('../time');
const { badRequest, notFound } = require('../errors');

const stmts = {
  categories: db.prepare('SELECT id, name, sort_order FROM categories ORDER BY sort_order, name'),
  items: db.prepare(`
    SELECT id, category_id, name, description, price_cents, available, counts_capacity, sort_order
    FROM menu_items ORDER BY sort_order, name
  `),
  itemById: db.prepare('SELECT * FROM menu_items WHERE id = ?'),
  categoryById: db.prepare('SELECT * FROM categories WHERE id = ?'),
  insertCategory: db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)'),
  updateCategory: db.prepare('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?'),
  deleteCategory: db.prepare('DELETE FROM categories WHERE id = ?'),
  insertItem: db.prepare(`
    INSERT INTO menu_items (category_id, name, description, price_cents, available, counts_capacity, sort_order, created_at, updated_at)
    VALUES (@category_id, @name, @description, @price_cents, @available, @counts_capacity, @sort_order, @now, @now)
  `),
  updateItem: db.prepare(`
    UPDATE menu_items SET category_id = @category_id, name = @name, description = @description, price_cents = @price_cents,
      available = @available, counts_capacity = @counts_capacity, sort_order = @sort_order, updated_at = @now
    WHERE id = @id
  `),
  setAvailability: db.prepare('UPDATE menu_items SET available = ?, updated_at = ? WHERE id = ?'),
  deleteItem: db.prepare('DELETE FROM menu_items WHERE id = ?'),
};

function mapItem(row) {
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    price_cents: row.price_cents,
    available: Boolean(row.available),
    counts_capacity: Boolean(row.counts_capacity),
    sort_order: row.sort_order,
  };
}

// Speisekarte gruppiert nach Kategorien. Artikel ohne Kategorie landen unter "Weitere".
function getMenu() {
  const categories = stmts.categories.all().map((c) => ({ ...c, items: [] }));
  const byId = new Map(categories.map((c) => [c.id, c]));
  const uncategorized = { id: null, name: 'Weitere', sort_order: 9999, items: [] };
  for (const row of stmts.items.all()) {
    (byId.get(row.category_id) || uncategorized).items.push(mapItem(row));
  }
  if (uncategorized.items.length) categories.push(uncategorized);
  return categories;
}

function text(value, name, { min = 0, max }) {
  const s = String(value ?? '').trim();
  if (s.length < min) throw badRequest(`${name} fehlt.`);
  if (s.length > max) throw badRequest(`${name} ist zu lang (maximal ${max} Zeichen).`);
  return s;
}

function sortOrder(value) {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < -100000 || n > 100000) throw badRequest('Sortierung muss eine ganze Zahl sein.');
  return n;
}

function createCategory(input) {
  const id = stmts.insertCategory.run(text(input.name, 'Name', { min: 1, max: 60 }), sortOrder(input.sort_order)).lastInsertRowid;
  return stmts.categoryById.get(id);
}

function updateCategory(id, input) {
  if (!stmts.categoryById.get(id)) throw notFound('Kategorie nicht gefunden.');
  stmts.updateCategory.run(text(input.name, 'Name', { min: 1, max: 60 }), sortOrder(input.sort_order), id);
  return stmts.categoryById.get(id);
}

// Artikel der gelöschten Kategorie bleiben erhalten und erscheinen unter "Weitere".
function deleteCategory(id) {
  if (stmts.deleteCategory.run(id).changes === 0) throw notFound('Kategorie nicht gefunden.');
}

function parsePrice(input) {
  if (input.price_cents !== undefined) {
    const n = Number(input.price_cents);
    if (Number.isInteger(n) && n >= 0 && n <= 1000000) return n;
  } else if (input.price !== undefined) {
    const n = Number(String(input.price).replace(',', '.'));
    if (Number.isFinite(n) && n >= 0 && n <= 10000) return Math.round(n * 100);
  }
  throw badRequest('Ungültiger Preis.');
}

function itemParams(input) {
  const categoryId = input.category_id === null || input.category_id === '' || input.category_id === undefined ? null : Number(input.category_id);
  if (categoryId !== null && !stmts.categoryById.get(categoryId)) throw badRequest('Kategorie existiert nicht.');
  return {
    category_id: categoryId,
    name: text(input.name, 'Name', { min: 1, max: 100 }),
    description: text(input.description, 'Beschreibung', { max: 500 }),
    price_cents: parsePrice(input),
    available: input.available === false ? 0 : 1,
    counts_capacity: input.counts_capacity === false ? 0 : 1,
    sort_order: sortOrder(input.sort_order),
    now: time.nowIso(),
  };
}

function createItem(input) {
  const id = stmts.insertItem.run(itemParams(input)).lastInsertRowid;
  return mapItem(stmts.itemById.get(id));
}

function updateItem(id, input) {
  if (!stmts.itemById.get(id)) throw notFound('Artikel nicht gefunden.');
  stmts.updateItem.run({ ...itemParams(input), id });
  return mapItem(stmts.itemById.get(id));
}

function setAvailability(id, available) {
  if (stmts.setAvailability.run(available ? 1 : 0, time.nowIso(), id).changes === 0) throw notFound('Artikel nicht gefunden.');
  return mapItem(stmts.itemById.get(id));
}

// Bestehende Bestellungen behalten ihren Snapshot von Name und Preis.
function deleteItem(id) {
  if (stmts.deleteItem.run(id).changes === 0) throw notFound('Artikel nicht gefunden.');
}

module.exports = {
  getMenu,
  createCategory,
  updateCategory,
  deleteCategory,
  createItem,
  updateItem,
  setAvailability,
  deleteItem,
};
