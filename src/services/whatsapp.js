'use strict';

// Wandelt eine (deutsche) Telefonnummer in reine Ziffern mit Ländervorwahl um.
// "0171 1234567", "+49 171 1234567" und "0049 171 1234567" ergeben "491711234567".
// Liefert null, wenn das Ergebnis keine plausible Länge hat.
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    // Ländervorwahl ist bereits enthalten, nur das Plus entfällt.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = `49${digits.slice(1)}`;
  } else if (/^1[5-7]\d{8,9}$/.test(digits)) {
    // Deutsche Mobilnummer ohne führende 0, z. B. "171 1234567".
    digits = `49${digits}`;
  }
  // "+49 (0) 171 ..." enthält eine überzählige 0 nach der Ländervorwahl.
  if (digits.startsWith('490')) digits = `49${digits.slice(3)}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function formatChatId(input) {
  const digits = normalizePhone(input);
  return digits ? `${digits}@c.us` : null;
}

// Sendet eine Textnachricht über die WAHA API. Wirft bei Netzwerkfehlern,
// Timeout oder Nicht 2xx Antworten einen Error mit lesbarer Meldung.
async function sendText({ baseUrl, session, apiKey, chatId, text, timeoutMs = 10000 }) {
  if (!baseUrl) throw new Error('WAHA Base URL ist nicht konfiguriert.');
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/sendText`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId, text, session: session || 'default' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`WAHA antwortet nicht (Timeout nach ${timeoutMs / 1000} s): ${url}`);
    const cause = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`WAHA nicht erreichbar (${cause}): ${url}`);
  }

  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`WAHA Fehler HTTP ${response.status}: ${body.slice(0, 300) || response.statusText}`);
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return { raw: body.slice(0, 300) };
  }
}

module.exports = { normalizePhone, formatChatId, sendText };
