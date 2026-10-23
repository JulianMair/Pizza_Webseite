'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { render, textToHtml } = require('../src/services/templates');

test('Platzhalter werden ersetzt', () => {
  const text = render('Hallo {name}, Bestellung #{order_id} ({type}) um {timeslot} Uhr', {
    name: 'Anna',
    order_id: 1001,
    type: 'Abholung',
    timeslot: '18:30',
  });
  assert.equal(text, 'Hallo Anna, Bestellung #1001 (Abholung) um 18:30 Uhr');
});

test('unbekannte oder leere Platzhalter bleiben stehen', () => {
  assert.equal(render('{name} {unbekannt}', { name: 'Ben' }), 'Ben {unbekannt}');
  assert.equal(render('{address}', { address: null }), '{address}');
  assert.equal(render('{address}', { address: '' }), '');
});

test('HTML Variante maskiert Sonderzeichen', () => {
  const html = textToHtml('<b>Pizza</b> & "Cola"\nZeile 2');
  assert.match(html, /&lt;b&gt;Pizza&lt;\/b&gt; &amp; &quot;Cola&quot;<br>Zeile 2/);
});
