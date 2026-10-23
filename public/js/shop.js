'use strict';

(function () {
  const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const dayFormatter = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const longDayFormatter = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC' });
  const STORAGE_KEY = 'pizza-shop-v1';

  function storageLoad() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function storageSave(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Speichern ist nur Komfort, z. B. im privaten Modus nicht verfügbar.
    }
  }

  // crypto.randomUUID gibt es nur in sicheren Kontexten (HTTPS), daher eigener Fallback.
  function randomToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
  }

  function addDays(date, days) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Fehler ${res.status}`);
    return res.json();
  }

  document.addEventListener('alpine:init', () => {
    Alpine.data('shop', () => ({
      shop: { shop_name: '', ordering_enabled: true, min_delivery_items: 0, notifications: {} },
      categories: [],
      slots: [],
      loading: true,
      loadError: null,
      cart: [],
      orderType: 'pickup',
      selectedDate: null,
      selectedSlotId: null,
      view: 'menu',
      cartOpen: false,
      activeCategory: null,
      notice: null,
      customer: { name: '', phone: '', email: '', street: '', city: '', note: '' },
      errors: {},
      formError: null,
      submitting: false,
      confirmation: null,
      clientToken: randomToken(),

      async init() {
        const saved = storageLoad();
        if (Array.isArray(saved.cart)) this.cart = saved.cart.filter((l) => Number.isInteger(l.id) && Number.isInteger(l.quantity) && l.quantity > 0);
        if (saved.orderType === 'delivery') this.orderType = 'delivery';
        if (saved.customer) Object.assign(this.customer, saved.customer, { note: '' });

        try {
          await Promise.all([this.loadShop(), this.loadMenu(), this.loadSlots()]);
          this.reconcileCart();
        } catch (err) {
          this.loadError = 'Die Speisekarte konnte nicht geladen werden. Bitte Seite neu laden.';
        } finally {
          this.loading = false;
        }
        this.$nextTick(() => this.setupScrollSpy());

        setInterval(() => this.loadSlots().catch(() => {}), 30000);
        setInterval(() => this.loadMenu().then(() => this.reconcileCart()).catch(() => {}), 60000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') this.loadSlots().catch(() => {});
        });
      },

      async loadShop() {
        this.shop = await getJson('/api/shop');
        document.title = `${this.shop.shop_name} | Online bestellen`;
      },

      async loadMenu() {
        const data = await getJson('/api/menu');
        this.categories = data.categories.filter((c) => c.items.length > 0);
        if (!this.activeCategory && this.categories.length) this.activeCategory = this.categories[0].id;
      },

      async loadSlots() {
        const data = await getJson('/api/slots');
        this.slots = data.slots;
        if (!this.selectedDate || !this.dates.includes(this.selectedDate)) {
          this.selectedDate = this.dates.find((d) => this.slotsForDate(d).some((s) => this.slotState(s).ok)) || this.dates[0] || null;
        }
        if (this.selectedSlotId) {
          const slot = this.selectedSlot;
          if (!slot || !this.slotState(slot).ok) {
            this.selectedSlotId = null;
            this.notice = 'Dein gewählter Zeitslot ist nicht mehr verfügbar. Bitte wähle einen neuen.';
          }
        }
      },

      // Entfernt Artikel, die es nicht mehr gibt, und prüft Bestellart und Slot.
      reconcileCart() {
        const before = this.cart.length;
        this.cart = this.cart.filter((l) => this.itemsById[l.id]);
        if (this.cart.length !== before) this.notice = 'Einige Artikel gibt es nicht mehr und wurden aus dem Warenkorb entfernt.';
        this.afterCartChange(false);
      },

      setupScrollSpy() {
        if (!('IntersectionObserver' in window)) return;
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) this.activeCategory = Number(entry.target.dataset.category) || entry.target.dataset.category;
          }
        }, { rootMargin: '-20% 0px -70% 0px' });
        document.querySelectorAll('[data-category]').forEach((el) => observer.observe(el));
      },

      scrollToCategory(id) {
        this.activeCategory = id;
        const el = document.getElementById(`cat-${id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },

      // Warenkorb
      get itemsById() {
        const map = {};
        for (const c of this.categories) for (const i of c.items) map[i.id] = i;
        return map;
      },

      get cartLines() {
        return this.cart
          .map((l) => {
            const item = this.itemsById[l.id];
            return item ? { ...item, quantity: l.quantity, lineTotal: item.price_cents * l.quantity } : null;
          })
          .filter(Boolean);
      },

      get itemCount() {
        return this.cartLines.reduce((s, l) => s + l.quantity, 0);
      },

      get pizzaCount() {
        return this.cartLines.reduce((s, l) => s + (l.counts_capacity ? l.quantity : 0), 0);
      },

      get totalCents() {
        return this.cartLines.reduce((s, l) => s + l.lineTotal, 0);
      },

      get hasUnavailable() {
        return this.cartLines.some((l) => !l.available);
      },

      qtyInCart(id) {
        const line = this.cart.find((l) => l.id === id);
        return line ? line.quantity : 0;
      },

      add(item) {
        if (!item.available || !this.shop.ordering_enabled) return;
        const line = this.cart.find((l) => l.id === item.id);
        if (line) {
          if (line.quantity >= 50) return;
          line.quantity += 1;
        } else {
          this.cart.push({ id: item.id, quantity: 1 });
        }
        this.afterCartChange();
        this.flash(`${item.name} hinzugefügt`);
      },

      inc(id) {
        const line = this.cart.find((l) => l.id === id);
        if (line && line.quantity < 50) line.quantity += 1;
        this.afterCartChange();
      },

      dec(id) {
        const line = this.cart.find((l) => l.id === id);
        if (!line) return;
        line.quantity -= 1;
        if (line.quantity <= 0) this.cart = this.cart.filter((l) => l.id !== id);
        this.afterCartChange();
      },

      remove(id) {
        this.cart = this.cart.filter((l) => l.id !== id);
        this.afterCartChange();
      },

      afterCartChange(clearNotice = true) {
        if (clearNotice) this.notice = null;
        if (this.orderType === 'delivery' && !this.deliveryAllowed) {
          this.orderType = 'pickup';
          if (this.itemCount > 0) this.notice = `Lieferung ist erst ab ${this.shop.min_delivery_items} Pizzen möglich. Die Bestellart wurde auf Abholung gesetzt.`;
        }
        if (this.selectedSlotId) {
          const slot = this.selectedSlot;
          if (!slot || !this.slotState(slot).ok) {
            this.selectedSlotId = null;
            this.notice = 'Der gewählte Zeitslot hat nicht genug Kapazität für deinen Warenkorb. Bitte wähle einen anderen.';
          }
        }
        this.persist();
      },

      persist() {
        storageSave({ cart: this.cart, orderType: this.orderType, customer: { ...this.customer, note: '' } });
      },

      // Bestellart
      get deliveryAllowed() {
        return this.pizzaCount >= this.shop.min_delivery_items;
      },

      get missingForDelivery() {
        return Math.max(0, this.shop.min_delivery_items - this.pizzaCount);
      },

      setType(type) {
        if (type === 'delivery' && !this.deliveryAllowed) return;
        this.orderType = type;
        this.notice = null;
        this.persist();
      },

      // Zeitslots
      get dates() {
        return [...new Set(this.slots.map((s) => s.date))];
      },

      slotsForDate(date) {
        return this.slots.filter((s) => s.date === date);
      },

      get selectedSlot() {
        return this.slots.find((s) => s.id === this.selectedSlotId) || null;
      },

      // Ein Slot ist nur wählbar, wenn eine weitere Bestellung UND alle Pizzen des Warenkorbs hineinpassen.
      slotState(slot) {
        if (slot.locked) return { ok: false, label: 'gesperrt' };
        const noPizzaLeft = slot.remaining_items <= 0 && (this.pizzaCount > 0 || this.itemCount === 0);
        if (slot.orders_count + 1 > slot.max_orders || noPizzaLeft) return { ok: false, label: 'ausgebucht' };
        if (slot.items_count + this.pizzaCount > slot.max_items) return { ok: false, label: `nur ${slot.remaining_items} frei` };
        return { ok: true, label: `noch ${slot.remaining_items} frei` };
      },

      dateHasFreeSlot(date) {
        return this.slotsForDate(date).some((s) => this.slotState(s).ok);
      },

      selectDate(date) {
        this.selectedDate = date;
      },

      selectSlot(slot) {
        if (!this.slotState(slot).ok) return;
        this.selectedSlotId = slot.id;
        this.notice = null;
      },

      dateLabel(date) {
        if (date === this.shop.today) return 'Heute';
        if (date === addDays(this.shop.today, 1)) return 'Morgen';
        return dayFormatter.format(new Date(`${date}T12:00:00Z`));
      },

      longDate(date) {
        return longDayFormatter.format(new Date(`${date}T12:00:00Z`));
      },

      get checkoutBlocker() {
        if (!this.shop.ordering_enabled) return 'Bestellungen sind gerade pausiert.';
        if (this.itemCount === 0) return 'Dein Warenkorb ist noch leer.';
        if (this.hasUnavailable) return 'Bitte ausverkaufte Artikel entfernen.';
        if (!this.slots.length) return 'Aktuell sind keine Zeitslots verfügbar.';
        if (!this.selectedSlotId) return 'Bitte wähle einen Zeitslot.';
        return null;
      },

      goCheckout() {
        if (this.checkoutBlocker) return;
        this.cartOpen = false;
        this.flashMessage = null;
        this.formError = null;
        this.errors = {};
        this.view = 'checkout';
        window.scrollTo({ top: 0 });
      },

      backToMenu() {
        this.view = 'menu';
        window.scrollTo({ top: 0 });
      },

      // Checkout
      validate() {
        const e = {};
        const c = this.customer;
        if (c.name.trim().length < 2) e.name = 'Bitte deinen Namen angeben.';
        if (c.phone.replace(/\D/g, '').length < 9) e.phone = 'Bitte eine gültige Telefonnummer angeben.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email.trim())) e.email = 'Bitte eine gültige E-Mail-Adresse angeben.';
        if (this.orderType === 'delivery') {
          if (!c.street.trim()) e.street = 'Bitte Straße und Hausnummer angeben.';
          if (!c.city.trim()) e.city = 'Bitte Ort angeben.';
        }
        this.errors = e;
        return Object.keys(e).length === 0;
      },

      async submit() {
        if (this.submitting) return;
        this.formError = null;
        if (!this.validate()) {
          this.formError = 'Bitte prüfe die markierten Felder.';
          return;
        }
        this.submitting = true;
        this.persist();
        try {
          const res = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              type: this.orderType,
              slot_id: this.selectedSlotId,
              items: this.cart,
              customer: this.customer,
              client_token: this.clientToken,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            this.confirmation = { ...data.order, street: this.customer.street, city: this.customer.city };
            this.cart = [];
            this.selectedSlotId = null;
            this.customer.note = '';
            this.clientToken = randomToken();
            this.persist();
            this.view = 'confirmation';
            window.scrollTo({ top: 0 });
            this.loadSlots().catch(() => {});
            return;
          }
          await this.handleOrderError(res.status, data);
        } catch {
          this.formError = 'Keine Verbindung zum Server. Bitte prüfe deine Internetverbindung und versuche es erneut.';
        } finally {
          this.submitting = false;
        }
      },

      async handleOrderError(status, data) {
        const message = data.error || 'Die Bestellung konnte nicht abgeschlossen werden.';
        if (status === 409 && data.code === 'slot_unavailable') {
          await this.loadSlots().catch(() => {});
          this.selectedSlotId = null;
          this.notice = `${message} Bitte wähle einen anderen Zeitslot.`;
          this.view = 'menu';
          this.cartOpen = true;
          window.scrollTo({ top: 0 });
          return;
        }
        if (status === 409 && data.code === 'items_unavailable') {
          await this.loadMenu().catch(() => {});
          this.notice = message;
          this.view = 'menu';
          this.cartOpen = true;
          return;
        }
        if (status === 503) {
          await this.loadShop().catch(() => {});
        }
        this.formError = message;
      },

      newOrder() {
        this.confirmation = null;
        this.view = 'menu';
        window.scrollTo({ top: 0 });
      },

      // Hilfsfunktionen
      money(cents) {
        return money.format(cents / 100);
      },

      flashMessage: null,
      flashTimer: null,
      flash(message) {
        this.flashMessage = message;
        clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => { this.flashMessage = null; }, 1800);
      },
    }));
  });
})();
