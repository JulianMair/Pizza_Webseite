'use strict';

(function () {
  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const dayFormatter = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const shortDayFormatter = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const STORAGE_KEY = 'pizza-admin-v1';

  const STATUS = {
    open: { label: 'Offen', badge: 'bg-amber-100 text-amber-800 ring-amber-200', border: 'border-l-amber-400' },
    preparing: { label: 'In Zubereitung', badge: 'bg-sky-100 text-sky-800 ring-sky-200', border: 'border-l-sky-500' },
    ready: { label: 'Fertig', badge: 'bg-emerald-100 text-emerald-800 ring-emerald-200', border: 'border-l-emerald-500' },
    cancelled: { label: 'Storniert', badge: 'bg-stone-200 text-stone-600 ring-stone-300', border: 'border-l-stone-300' },
  };

  const SECTIONS = {
    general: ['shop_name', 'shop_subtitle', 'ordering_enabled', 'closed_message', 'min_delivery_items', 'lead_minutes', 'imprint_url', 'privacy_url'],
    whatsapp: ['waha_url', 'waha_session', 'waha_api_key', 'wa_confirm_enabled', 'wa_ready_enabled', 'wa_tpl_confirm', 'wa_tpl_ready_pickup', 'wa_tpl_ready_delivery'],
    email: ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_from_name', 'mail_confirm_enabled', 'mail_ready_enabled',
      'mail_tpl_confirm_subject', 'mail_tpl_confirm_body', 'mail_tpl_ready_subject', 'mail_tpl_ready_pickup_body', 'mail_tpl_ready_delivery_body'],
  };

  function addDays(date, days) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function prefsLoad() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function prefsSave(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Nur Komfort, kein Fehler.
    }
  }

  document.addEventListener('alpine:init', () => {
    Alpine.data('admin', () => ({
      ready: false,
      authenticated: false,
      user: '',
      loginForm: { username: '', password: '', error: null, busy: false },
      tab: 'orders',
      toasts: [],
      toastSeq: 0,

      // Bestellungen
      today: null,
      date: null,
      dates: [],
      daySlots: [],
      hideDone: false,
      showEmpty: false,
      sound: true,
      live: false,
      busy: {},
      loadingOrders: false,
      refreshTimer: null,
      pollTimer: null,
      eventSource: null,
      audio: null,

      // Speisekarte
      categories: [],
      newCategory: { name: '', sort_order: 0 },
      itemModal: null,
      itemSaving: false,

      // Einstellungen
      settingsTab: 'slots',
      settings: null,
      clearSecrets: [],
      timezone: '',
      saving: null,
      slotDate: null,
      slotList: [],
      gen: { date_from: '', date_to: '', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '17:00', end: '21:00', interval: 15, max_orders: 5, max_items: 12 },
      single: { date: '', time: '18:00', max_orders: 5, max_items: 12 },
      testPhone: '',
      testEmail: '',
      testResult: { whatsapp: null, email: null },
      testing: null,
      pw: { current: '', next: '', confirm: '' },
      cleanupDays: 90,

      weekdayNames: [['1', 'Mo'], ['2', 'Di'], ['3', 'Mi'], ['4', 'Do'], ['5', 'Fr'], ['6', 'Sa'], ['0', 'So']],
      placeholders: ['{name}', '{order_id}', '{timeslot}', '{date}', '{type}', '{items}', '{total}', '{address}', '{shop}'],

      async init() {
        const prefs = prefsLoad();
        this.hideDone = Boolean(prefs.hideDone);
        this.showEmpty = Boolean(prefs.showEmpty);
        this.sound = prefs.sound !== false;
        try {
          const me = await this.api('GET', '/api/admin/me');
          this.user = me.user;
          this.loginForm.username = me.user;
          if (me.authenticated) await this.start();
        } catch (err) {
          this.toast('error', err.message);
        } finally {
          this.ready = true;
        }
      },

      async api(method, url, body) {
        const options = {
          method,
          headers: { Accept: 'application/json', 'X-Requested-With': 'fetch' },
          credentials: 'same-origin',
        };
        if (body !== undefined) {
          options.headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify(body);
        }
        let res;
        try {
          res = await fetch(url, options);
        } catch {
          throw new Error('Server nicht erreichbar. Bitte Verbindung prüfen.');
        }
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 && !url.endsWith('/login')) {
          this.logoutLocal();
          throw new Error('Sitzung abgelaufen, bitte erneut anmelden.');
        }
        if (!res.ok) {
          const err = new Error(data.error || `Fehler ${res.status}`);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      },

      async login() {
        this.loginForm.busy = true;
        this.loginForm.error = null;
        try {
          await this.api('POST', '/api/admin/login', { username: this.loginForm.username, password: this.loginForm.password });
          this.loginForm.password = '';
          await this.start();
        } catch (err) {
          this.loginForm.error = err.message;
        } finally {
          this.loginForm.busy = false;
        }
      },

      async logout() {
        await this.api('POST', '/api/admin/logout').catch(() => {});
        this.logoutLocal();
      },

      logoutLocal() {
        this.authenticated = false;
        if (this.eventSource) this.eventSource.close();
        this.eventSource = null;
        this.live = false;
      },

      async start() {
        this.authenticated = true;
        await this.loadDates();
        this.date = this.today;
        this.slotDate = this.today;
        this.single.date = this.today;
        this.gen.date_from = this.today;
        this.gen.date_to = addDays(this.today, 6);
        await Promise.all([this.loadOrders(), this.loadMenu(), this.loadSettings()]);
        this.connectEvents();
        if (!this.pollTimer) {
          // Fallback, falls SSE durch einen Proxy unterbrochen wird.
          this.pollTimer = setInterval(() => {
            if (this.authenticated && !this.live) this.loadOrders(true);
          }, 60000);
        }
      },

      toast(type, message, timeout) {
        const id = ++this.toastSeq;
        this.toasts.push({ id, type, message });
        setTimeout(() => this.dismiss(id), timeout || (type === 'success' ? 4000 : 9000));
      },

      dismiss(id) {
        this.toasts = this.toasts.filter((t) => t.id !== id);
      },

      savePrefs() {
        prefsSave({ hideDone: this.hideDone, showEmpty: this.showEmpty, sound: this.sound });
      },

      // Live Updates
      connectEvents() {
        if (this.eventSource) this.eventSource.close();
        const es = new EventSource('/api/admin/events');
        this.eventSource = es;
        es.onopen = () => {
          this.live = true;
          this.loadOrders(true);
        };
        es.onerror = () => {
          this.live = false;
        };
        es.addEventListener('order:new', (e) => {
          const data = JSON.parse(e.data);
          this.toast('info', `Neue Bestellung #${data.id} für ${this.shortDate(data.date)}`);
          if (this.sound) this.beep();
          this.loadDates();
          if (data.date === this.date) this.scheduleRefresh();
          if (data.date === this.slotDate) this.loadSlotList();
        });
        es.addEventListener('order:updated', (e) => {
          const data = JSON.parse(e.data);
          if (data.date === this.date) this.scheduleRefresh();
        });
        es.addEventListener('slots:changed', () => {
          this.loadDates();
          this.scheduleRefresh();
        });
      },

      scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.loadOrders(true), 250);
      },

      toggleSound() {
        this.sound = !this.sound;
        this.savePrefs();
        if (this.sound) this.beep();
      },

      // Kurzer Signalton über WebAudio, ohne Audiodatei.
      beep() {
        try {
          this.audio = this.audio || new (window.AudioContext || window.webkitAudioContext)();
          const ctx = this.audio;
          [0, 0.18].forEach((offset) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
            gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + offset + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.15);
            osc.connect(gain).connect(ctx.destination);
            osc.start(ctx.currentTime + offset);
            osc.stop(ctx.currentTime + offset + 0.16);
          });
        } catch {
          // Ton ist optional.
        }
      },

      // Tab 1: Bestellungen
      async loadDates() {
        const data = await this.api('GET', '/api/admin/order-dates');
        this.today = data.today;
        this.dates = data.dates;
      },

      async loadOrders(silent = false) {
        if (!this.date) return;
        if (!silent) this.loadingOrders = true;
        try {
          const data = await this.api('GET', `/api/admin/orders?date=${encodeURIComponent(this.date)}`);
          if (data.date === this.date) this.daySlots = data.slots;
        } catch (err) {
          if (!silent) this.toast('error', err.message);
        } finally {
          this.loadingOrders = false;
        }
      },

      setDate(date) {
        if (!date) return;
        this.date = date;
        this.loadOrders();
      },

      shiftDate(days) {
        this.setDate(addDays(this.date, days));
      },

      get visibleSlots() {
        return this.daySlots.filter((s) => this.showEmpty || s.orders.length > 0);
      },

      get emptySlots() {
        return this.daySlots.filter((s) => s.orders.length === 0);
      },

      slotOrders(slot) {
        return this.hideDone ? slot.orders.filter((o) => o.status === 'open' || o.status === 'preparing') : slot.orders;
      },

      get dayStats() {
        const orders = this.daySlots.flatMap((s) => s.orders).filter((o) => o.status !== 'cancelled');
        return {
          orders: orders.length,
          open: orders.filter((o) => o.status === 'open' || o.status === 'preparing').length,
          pizzas: orders.reduce((s, o) => s + o.capacity_count, 0),
          revenue: orders.reduce((s, o) => s + o.total_cents, 0),
        };
      },

      summaryText(list) {
        return list.map((i) => `${i.quantity}x ${i.name}`).join(', ');
      },

      percent(value, max) {
        if (!max) return 100;
        return Math.min(100, Math.round((value / max) * 100));
      },

      barColor(value, max) {
        const p = this.percent(value, max);
        if (p >= 100) return 'bg-brand-500';
        if (p >= 75) return 'bg-amber-400';
        return 'bg-emerald-500';
      },

      status(order) {
        return STATUS[order.status] || STATUS.open;
      },

      async setStatus(order, status) {
        if (status === order.status) return;
        if (status === 'cancelled' && !confirm(`Bestellung #${order.id} von ${order.customer_name} wirklich stornieren? Der Platz im Slot wird wieder frei.`)) {
          this.loadOrders(true);
          return;
        }
        this.busy = { ...this.busy, [order.id]: status };
        try {
          const result = await this.api('PATCH', `/api/admin/orders/${order.id}/status`, { status });
          this.replaceOrder(result.order);
          if (result.warning) this.toast('warning', result.warning);
          if (result.notifications) this.reportNotifications(order.id, result.notifications, 'Fertig Meldung');
          else this.toast('success', `Bestellung #${order.id}: ${STATUS[status].label}`);
        } catch (err) {
          this.toast('error', err.message);
          this.loadOrders(true);
        } finally {
          const { [order.id]: _done, ...rest } = this.busy;
          this.busy = rest;
        }
      },

      async resend(order, kind) {
        this.busy = { ...this.busy, [order.id]: 'notify' };
        try {
          const result = await this.api('POST', `/api/admin/orders/${order.id}/notify`, { kind });
          this.replaceOrder(result.order);
          this.reportNotifications(order.id, result.notifications, kind === 'ready' ? 'Fertig Meldung' : 'Bestätigung');
        } catch (err) {
          this.toast('error', err.message);
        } finally {
          const { [order.id]: _done, ...rest } = this.busy;
          this.busy = rest;
        }
      },

      reportNotifications(orderId, n, label) {
        const describe = (name, r) => {
          if (r.status === 'sent') return `${name} ✓ gesendet`;
          if (r.status === 'skipped') return `${name} übersprungen (${r.error})`;
          return `${name} FEHLGESCHLAGEN: ${r.error}`;
        };
        const text = `#${orderId} ${label}: ${describe('WhatsApp', n.whatsapp)} · ${describe('E-Mail', n.email)}`;
        const failed = n.whatsapp.status === 'failed' || n.email.status === 'failed';
        const allSkipped = n.whatsapp.status === 'skipped' && n.email.status === 'skipped';
        this.toast(failed ? 'warning' : allSkipped ? 'info' : 'success', text, failed ? 15000 : 7000);
      },

      replaceOrder(updated) {
        this.daySlots = this.daySlots.map((slot) => ({
          ...slot,
          orders: slot.orders.map((o) => (o.id === updated.id ? updated : o)),
        }));
        this.scheduleRefresh();
      },

      notif(order, kind, channel) {
        const n = order.notifications[kind]?.[channel];
        if (!n) return { icon: '·', cls: 'text-stone-300', title: 'Noch nicht gesendet' };
        if (n.status === 'sent') return { icon: '✓', cls: 'text-emerald-600', title: `Gesendet ${this.time(n.at)}` };
        if (n.status === 'skipped') return { icon: '–', cls: 'text-stone-400', title: `Übersprungen: ${n.error}` };
        return { icon: '⚠', cls: 'text-brand-600', title: `Fehler: ${n.error}` };
      },

      notifErrors(order) {
        const errors = [];
        for (const kind of ['confirmation', 'ready']) {
          for (const channel of ['whatsapp', 'email']) {
            const n = order.notifications[kind]?.[channel];
            if (n && n.status === 'failed') errors.push({ kind, channel, error: n.error });
          }
        }
        return errors;
      },

      hasFailed(order, kind) {
        return ['whatsapp', 'email'].some((c) => order.notifications[kind]?.[c]?.status === 'failed');
      },

      async toggleOrdering() {
        const value = !this.settings.ordering_enabled;
        try {
          const data = await this.api('PUT', '/api/admin/settings', { ordering_enabled: value });
          this.settings.ordering_enabled = data.settings.ordering_enabled;
          this.toast('success', value ? 'Bestellannahme ist wieder aktiv.' : 'Bestellannahme pausiert.');
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      // Tab 2: Speisekarte
      async loadMenu() {
        const data = await this.api('GET', '/api/admin/menu');
        this.categories = data.categories;
      },

      get realCategories() {
        return this.categories.filter((c) => c.id !== null);
      },

      async addCategory() {
        try {
          await this.api('POST', '/api/admin/categories', this.newCategory);
          this.newCategory = { name: '', sort_order: (this.realCategories.length + 1) };
          await this.loadMenu();
          this.toast('success', 'Kategorie angelegt.');
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      async saveCategory(cat) {
        try {
          await this.api('PUT', `/api/admin/categories/${cat.id}`, { name: cat.name, sort_order: Number(cat.sort_order) });
          await this.loadMenu();
          this.toast('success', 'Kategorie gespeichert.');
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      async deleteCategory(cat) {
        if (!confirm(`Kategorie "${cat.name}" löschen? Enthaltene Artikel bleiben erhalten und erscheinen unter "Weitere".`)) return;
        try {
          await this.api('DELETE', `/api/admin/categories/${cat.id}`);
          await this.loadMenu();
          this.toast('success', 'Kategorie gelöscht.');
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      openItem(item, categoryId) {
        this.itemModal = item
          ? { ...item, price: (item.price_cents / 100).toFixed(2).replace('.', ',') }
          : { id: null, name: '', description: '', price: '', category_id: categoryId ?? this.realCategories[0]?.id ?? null, available: true, counts_capacity: true, sort_order: 0 };
      },

      async saveItem() {
        const m = this.itemModal;
        const body = {
          name: m.name,
          description: m.description,
          price: m.price,
          category_id: m.category_id === '' || m.category_id === null ? null : Number(m.category_id),
          available: m.available,
          counts_capacity: m.counts_capacity,
          sort_order: Number(m.sort_order) || 0,
        };
        this.itemSaving = true;
        try {
          if (m.id) await this.api('PUT', `/api/admin/menu/${m.id}`, body);
          else await this.api('POST', '/api/admin/menu', body);
          this.itemModal = null;
          await this.loadMenu();
          this.toast('success', 'Artikel gespeichert.');
        } catch (err) {
          this.toast('error', err.message);
        } finally {
          this.itemSaving = false;
        }
      },

      async deleteItem(item) {
        if (!confirm(`"${item.name}" wirklich löschen? Bestehende Bestellungen bleiben unverändert.`)) return;
        try {
          await this.api('DELETE', `/api/admin/menu/${item.id}`);
          await this.loadMenu();
          this.toast('success', 'Artikel gelöscht.');
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      async toggleAvailability(item) {
        const next = !item.available;
        item.available = next;
        try {
          await this.api('PATCH', `/api/admin/menu/${item.id}/availability`, { available: next });
          this.toast('success', `${item.name}: ${next ? 'verfügbar' : 'ausverkauft'}`);
        } catch (err) {
          item.available = !next;
          this.toast('error', err.message);
        }
      },

      // Tab 3: Einstellungen
      async loadSettings() {
        const data = await this.api('GET', '/api/admin/settings');
        this.settings = data.settings;
        this.timezone = data.timezone;
        this.clearSecrets = [];
        await this.loadSlotList();
      },

      async saveSettings(section) {
        const body = {};
        for (const key of SECTIONS[section]) body[key] = this.settings[key];
        body.clear_secrets = this.clearSecrets.filter((k) => SECTIONS[section].includes(k));
        this.saving = section;
        try {
          const data = await this.api('PUT', '/api/admin/settings', body);
          this.settings = data.settings;
          this.clearSecrets = this.clearSecrets.filter((k) => !SECTIONS[section].includes(k));
          this.toast('success', 'Einstellungen gespeichert.');
        } catch (err) {
          this.toast('error', err.message);
        } finally {
          this.saving = null;
        }
      },

      toggleClearSecret(key) {
        this.clearSecrets = this.clearSecrets.includes(key) ? this.clearSecrets.filter((k) => k !== key) : [...this.clearSecrets, key];
      },

      async sendTestWhatsapp() {
        this.testing = 'whatsapp';
        this.testResult.whatsapp = null;
        try {
          this.testResult.whatsapp = await this.api('POST', '/api/admin/settings/test-whatsapp', { phone: this.testPhone });
        } catch (err) {
          this.testResult.whatsapp = { ok: false, error: err.message };
        } finally {
          this.testing = null;
        }
      },

      async sendTestEmail() {
        this.testing = 'email';
        this.testResult.email = null;
        try {
          this.testResult.email = await this.api('POST', '/api/admin/settings/test-email', { to: this.testEmail });
        } catch (err) {
          this.testResult.email = { ok: false, error: err.message };
        } finally {
          this.testing = null;
        }
      },

      async changePassword() {
        if (this.pw.next !== this.pw.confirm) {
          this.toast('error', 'Die neuen Passwörter stimmen nicht überein.');
          return;
        }
        try {
          await this.api('POST', '/api/admin/password', { current: this.pw.current, next: this.pw.next });
          this.pw = { current: '', next: '', confirm: '' };
          this.toast('success', 'Passwort geändert. Andere Geräte wurden abgemeldet.');
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      async cleanup() {
        if (!confirm(`Alle Bestellungen und Slots löschen, die älter als ${this.cleanupDays} Tage sind? Das kann nicht rückgängig gemacht werden.`)) return;
        try {
          const r = await this.api('POST', '/api/admin/cleanup', { days: Number(this.cleanupDays) });
          this.toast('success', `${r.orders} Bestellungen und ${r.slots} Slots vor dem ${this.shortDate(r.cutoff)} gelöscht.`);
          await this.loadDates();
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      // Zeitslots verwalten
      async loadSlotList() {
        if (!this.slotDate) return;
        const data = await this.api('GET', `/api/admin/slots?date=${encodeURIComponent(this.slotDate)}`);
        if (data.date === this.slotDate) this.slotList = data.slots;
      },

      setSlotDate(date) {
        if (!date) return;
        this.slotDate = date;
        this.loadSlotList().catch((err) => this.toast('error', err.message));
      },

      async createSingle() {
        try {
          await this.api('POST', '/api/admin/slots', {
            date: this.single.date,
            time: this.single.time,
            max_orders: Number(this.single.max_orders),
            max_items: Number(this.single.max_items),
          });
          this.toast('success', `Slot ${this.single.time} Uhr angelegt.`);
          this.setSlotDate(this.single.date);
          this.loadDates();
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      get genPreview() {
        const g = this.gen;
        if (!g.date_from || !g.date_to || g.date_to < g.date_from || !g.start || !g.end || Number(g.interval) < 5) return { days: 0, slots: 0 };
        const [sh, sm] = g.start.split(':').map(Number);
        const [eh, em] = g.end.split(':').map(Number);
        const perDay = (eh * 60 + em) >= (sh * 60 + sm) ? Math.floor(((eh * 60 + em) - (sh * 60 + sm)) / Number(g.interval)) + 1 : 0;
        let days = 0;
        for (let d = g.date_from, i = 0; d <= g.date_to && i < 400; d = addDays(d, 1), i += 1) {
          if (g.weekdays.map(Number).includes(new Date(`${d}T12:00:00Z`).getUTCDay())) days += 1;
        }
        return { days, slots: days * perDay };
      },

      toggleWeekday(day) {
        const d = Number(day);
        this.gen.weekdays = this.gen.weekdays.includes(d) ? this.gen.weekdays.filter((x) => x !== d) : [...this.gen.weekdays, d];
      },

      async generate() {
        try {
          const r = await this.api('POST', '/api/admin/slots/generate', {
            ...this.gen,
            interval: Number(this.gen.interval),
            max_orders: Number(this.gen.max_orders),
            max_items: Number(this.gen.max_items),
          });
          this.toast('success', `${r.created} Slots erzeugt${r.skipped ? `, ${r.skipped} bereits vorhanden` : ''}.`);
          this.setSlotDate(this.gen.date_from);
          this.loadDates();
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      async updateSlot(slot, patch) {
        try {
          const data = await this.api('PUT', `/api/admin/slots/${slot.id}`, patch);
          Object.assign(slot, data.slot);
        } catch (err) {
          this.toast('error', err.message);
          this.loadSlotList();
        }
      },

      async deleteSlot(slot) {
        if (!confirm(`Slot ${slot.time} Uhr löschen?`)) return;
        try {
          await this.api('DELETE', `/api/admin/slots/${slot.id}`);
          this.slotList = this.slotList.filter((s) => s.id !== slot.id);
          this.loadDates();
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      async deleteFreeSlots() {
        if (!confirm(`Alle Slots ohne Bestellungen am ${this.shortDate(this.slotDate)} löschen?`)) return;
        try {
          const r = await this.api('DELETE', `/api/admin/slots?date=${encodeURIComponent(this.slotDate)}`);
          this.toast('success', `${r.deleted} Slots gelöscht.`);
          this.loadSlotList();
          this.loadDates();
        } catch (err) {
          this.toast('error', err.message);
        }
      },

      // Formatierung
      plusDays(date, days) {
        return addDays(date, days);
      },

      money(cents) {
        return money.format(cents / 100);
      },

      longDate(date) {
        return date ? dayFormatter.format(new Date(`${date}T12:00:00Z`)) : '';
      },

      shortDate(date) {
        return date ? shortDayFormatter.format(new Date(`${date}T12:00:00Z`)) : '';
      },

      // Uhrzeiten in der Zeitzone des Servers, unabhängig vom Gerät.
      time(iso) {
        if (!iso) return '';
        try {
          return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: this.timezone || undefined }).format(new Date(iso));
        } catch {
          return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        }
      },

      dateOptionLabel(d) {
        const prefix = d.date === this.today ? 'Heute, ' : '';
        return `${prefix}${this.shortDate(d.date)} · ${d.order_count} Best. · ${d.slot_count} Slots`;
      },
    }));
  });
})();
