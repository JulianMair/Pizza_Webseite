'use strict';

const PLACEHOLDERS = ['name', 'order_id', 'timeslot', 'date', 'type', 'items', 'total', 'address', 'shop'];

// Ersetzt {platzhalter} durch Werte aus ctx. Unbekannte Platzhalter bleiben unverändert stehen.
function render(template, ctx) {
  return String(template ?? '').replace(/\{([a-z_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key] !== undefined && ctx[key] !== null ? String(ctx[key]) : match
  ));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Einfache HTML Variante eines Text Bodys für E-Mail Clients.
function textToHtml(text) {
  const body = escapeHtml(text).replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">${body}</body></html>`;
}

module.exports = { PLACEHOLDERS, render, escapeHtml, textToHtml };
