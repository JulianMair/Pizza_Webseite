'use strict';

// Integrationstest: startet den echten Server als Kindprozess und spricht ihn per HTTP an.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const time = require('../src/time');

const PASSWORD = 'integration-test-pw';
let server;
let base;
let cookie;

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: {
        ...process.env,
        PORT: '0',
        DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pizza-http-')),
        ADMIN_PASSWORD: PASSWORD,
        ORDER_RATE_LIMIT: '1000',
        SEED_DEMO_DATA: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server startet nicht:\n${output}`)), 10000);
    proc.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Läuft auf Port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ proc, port: Number(match[1]) });
      }
    });
    proc.stderr.on('data', (chunk) => { output += chunk; });
  });
}

async function call(method, url, body, { admin = false, csrf = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin && cookie) headers.Cookie = cookie;
  if (admin && csrf) headers['X-Requested-With'] = 'fetch';
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Minimaler WAHA Ersatz, der eingehende Requests aufzeichnet.
function startMockWaha() {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'true_491711234567@c.us_ABC' }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, requests, port: srv.address().port })));
}

function closedPort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const customer = { name: 'Paul Parallel', phone: '+49 171 1234567', email: 'paul@example.com' };
let margheritaId;
let slotId;

test.before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.port}`;
  const menu = await call('GET', '/api/menu');
  margheritaId = menu.body.categories[0].items.find((i) => i.name === 'Margherita').id;
});

test.after(() => {
  server.proc.kill('SIGTERM');
});

test('Admin API ist geschützt', async () => {
  assert.equal((await call('GET', '/api/admin/orders')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { username: 'admin', password: 'falsch' })).status, 401);
  const login = await call('POST', '/api/admin/login', { username: 'admin', password: PASSWORD });
  assert.equal(login.status, 200);
  assert.ok(cookie && cookie.startsWith('pizza_admin='));
  assert.equal((await call('GET', '/api/admin/orders', undefined, { admin: true })).status, 200);
  // Schreibende Requests ohne X-Requested-With (z. B. Formular einer fremden Seite) werden abgelehnt.
  assert.equal((await call('PUT', '/api/admin/settings', { shop_name: 'X' }, { admin: true, csrf: false })).status, 403);
});

test('20 parallele Bestellungen auf einen Slot mit 5 Plätzen: genau 5 gehen durch', async () => {
  await call('PUT', '/api/admin/settings', { wa_confirm_enabled: false, mail_confirm_enabled: false }, { admin: true });
  const created = await call('POST', '/api/admin/slots', { date: time.addDays(time.today(), 1), time: '18:15', max_orders: 5, max_items: 100 }, { admin: true });
  assert.equal(created.status, 201);
  slotId = created.body.slot.id;

  const results = await Promise.all(Array.from({ length: 20 }, () => call('POST', '/api/orders', {
    type: 'pickup',
    slot_id: slotId,
    customer,
    items: [{ id: margheritaId, quantity: 1 }],
  })));
  const ok = results.filter((r) => r.status === 201);
  const full = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 5);
  assert.equal(full.length, 15);
  assert.equal(full[0].body.code, 'slot_unavailable');

  const slotsRes = await call('GET', '/api/slots');
  const slot = slotsRes.body.slots.find((s) => s.id === slotId);
  assert.equal(slot.orders_count, 5);
  assert.equal(slot.remaining_orders, 0);
});

test('Status "Fertig" sendet WhatsApp an WAHA mit korrektem Body und API Key', async () => {
  const waha = await startMockWaha();
  try {
    const saved = await call('PUT', '/api/admin/settings', {
      waha_url: `http://127.0.0.1:${waha.port}`,
      waha_session: 'default',
      waha_api_key: 'geheim-123',
      wa_ready_enabled: true,
      mail_ready_enabled: true,
    }, { admin: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.waha_api_key, '', 'API Key wird nicht ausgeliefert');
    assert.equal(saved.body.settings.waha_api_key_set, true);

    const res = await call('PATCH', '/api/admin/orders/1001/status', { status: 'ready' }, { admin: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'ready');
    assert.equal(res.body.notifications.whatsapp.status, 'sent');
    assert.equal(res.body.notifications.email.status, 'skipped');

    assert.equal(waha.requests.length, 1);
    const [req] = waha.requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/sendText');
    assert.equal(req.headers['x-api-key'], 'geheim-123');
    assert.equal(req.body.chatId, '491711234567@c.us');
    assert.equal(req.body.session, 'default');
    assert.match(req.body.text, /Paul Parallel/);
    assert.match(req.body.text, /#1001/);

    // Erneutes Setzen auf "Fertig" verschickt nichts doppelt.
    await call('PATCH', '/api/admin/orders/1001/status', { status: 'preparing' }, { admin: true });
    await call('PATCH', '/api/admin/orders/1001/status', { status: 'ready' }, { admin: true });
    assert.equal(waha.requests.length, 1);
  } finally {
    waha.srv.close();
  }
});

test('WAHA und SMTP nicht erreichbar: Statuswechsel klappt trotzdem, Fehler werden gemeldet', async () => {
  const deadPort = await closedPort();
  await call('PUT', '/api/admin/settings', {
    waha_url: `http://127.0.0.1:${deadPort}`,
    smtp_host: '127.0.0.1',
    smtp_port: deadPort,
    smtp_from: 'shop@example.com',
  }, { admin: true });

  const res = await call('PATCH', '/api/admin/orders/1002/status', { status: 'ready' }, { admin: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'ready');
  assert.equal(res.body.notifications.whatsapp.status, 'failed');
  assert.match(res.body.notifications.whatsapp.error, /WAHA nicht erreichbar/);
  assert.equal(res.body.notifications.email.status, 'failed');
  assert.match(res.body.notifications.email.error, /SMTP Fehler/);

  const day = await call('GET', `/api/admin/orders?date=${time.addDays(time.today(), 1)}`, undefined, { admin: true });
  const order = day.body.slots.flatMap((s) => s.orders).find((o) => o.id === 1002);
  assert.equal(order.notifications.ready.whatsapp.status, 'failed');
  assert.equal(order.notifications.ready.email.status, 'failed');
});
