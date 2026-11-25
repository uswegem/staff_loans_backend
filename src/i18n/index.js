'use strict';

// Messages the API shows people, in English or Swahili, one language at a time (D-94,
// D-109). The web app sends Accept-Language: sw when the person has chosen Swahili.
// Only message fields are translated (never names, staff numbers, figures the person
// entered, free text as typed, or agreement text).
//
// src/i18n/sw.js lists [code, English, Swahili]. The code is stable: responses carry it
// with the params, and notifications are stored as code and params and rendered in the
// reader's language when read. {name} in an entry stands for any text; the matching part
// is carried into the Swahili, translated itself when it is a known phrase or message.
//
// Every message has a Swahili entry: a CI check (tests/unit/i18nCoverage.test.js) fails
// when one is missing. If one is missing anyway, the English is shown and the miss is
// logged as i18n.missing, so it is never silent.

const CATALOGUE = require('./sw');

const byCode = new Map();
const exact = new Map(); // English -> entry
const patterns = [];
for (const [code, en, sw] of CATALOGUE) {
  const entry = { code, en, sw };
  byCode.set(code, entry);
  if (!/\{\w+\}/.test(en)) {
    exact.set(en, entry);
    continue;
  }
  const names = [];
  const source = en
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = part.match(/^\{(\w+)\}$/);
      if (m) {
        names.push(m[1]);
        return '(.+?)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  patterns.push({ re: new RegExp(`^${source}$`, 's'), names, entry });
}

const fill = (template, params, lang) =>
  Object.entries(params || {}).reduce((out, [name, value]) => out.split(`{${name}}`).join(lang === 'sw' ? inner(String(value)) : String(value)), template);

/** A carried-over value: a known phrase or message, or a list of phrases, in Swahili; otherwise as it is. */
function inner(value) {
  if (exact.has(value)) return exact.get(value).sw;
  // eslint-disable-next-line no-use-before-define
  if (/[.!?]$/.test(value) && value.includes(' ')) return translate(value, 'sw', { log: false });
  if (value.includes(', ')) {
    const parts = value.split(', ');
    if (parts.some((p) => exact.has(p))) return parts.map((p) => (exact.has(p) ? exact.get(p).sw : p)).join(', ');
  }
  return value;
}

/** { code, params } for one whole message, or null. */
function one(text) {
  if (exact.has(text)) return { code: exact.get(text).code, params: {} };
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) return { code: p.entry.code, params: Object.fromEntries(p.names.map((name, i) => [name, m[i + 1]])) };
  }
  return null;
}

const sentencesOf = (text) => text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text];

/**
 * The code and params of an English message: { code, params }, or for a message made of
 * several catalogue sentences { code: 'COMPOSITE', params: { parts: [{ code, params }] } }.
 * null when part of it has no entry.
 */
function identify(text) {
  if (typeof text !== 'string' || !text) return null;
  const whole = one(text);
  if (whole) return whole;
  const sentences = sentencesOf(text).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2) return null;
  const parts = sentences.map(one);
  return parts.every(Boolean) ? { code: 'COMPOSITE', params: { parts } } : null;
}

/** A coded message in the language. */
function render(code, params = {}, lang = 'en') {
  if (code === 'COMPOSITE') return (params.parts || []).map((p) => render(p.code, p.params, lang)).join(' ');
  const entry = byCode.get(code);
  if (!entry) return null;
  return fill(lang === 'sw' ? entry.sw : entry.en, params, lang);
}

const logged = new Set();
const missing = [];
function reportMissing(text) {
  missing.push(text);
  if (logged.has(text)) return;
  logged.add(text);
  if (logged.size > 2000) logged.clear();
  // eslint-disable-next-line global-require
  require('../utils/logger').warn('i18n.missing', { text: text.slice(0, 300) });
}

/**
 * text in the language. A Swahili request for a message with no entry gets the English,
 * and the miss is logged (never silent).
 */
function translate(text, lang, { log = true } = {}) {
  if (lang !== 'sw' || typeof text !== 'string' || !text) return text;
  const found = identify(text);
  if (found) return render(found.code, found.params, 'sw');
  // Part of a longer message may still be known: translate what is, report the rest.
  const sentences = sentencesOf(text);
  let unknown = false;
  const out = sentences
    .map((s) => {
      const t = s.trim();
      const done = one(t);
      // Prose only: identifiers, codes and fingerprints in detail fields are data, not messages.
      if (!done && /[A-Za-z]{2,} [A-Za-z]{2,}/.test(t)) unknown = true;
      return `${done ? render(done.code, done.params, 'sw') : t}${/\s$/.test(s) ? ' ' : ''}`;
    })
    .join('')
    .trim();
  if (unknown && log) reportMissing(text);
  return out;
}

/** 'sw' when the request asks for Swahili, otherwise 'en'. */
const langOf = (req) => (/^sw\b/i.test(req.get?.('Accept-Language') || '') ? 'sw' : 'en');

const LIST_KEYS = new Set(['reasons', 'problems', 'warnings', 'eligibility', 'checks', 'flags', 'messages', 'blockers', 'applyBlockers']);
const TEXT_KEYS = new Set(['message', 'reason', 'why', 'hint']);

/** Translates the message fields of a response body in place, at any depth. */
function translateBody(body, lang, depth = 0) {
  if (lang !== 'sw' || !body || typeof body !== 'object' || depth > 8) return body;
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && TEXT_KEYS.has(k)) body[k] = translate(v, lang);
    else if (Array.isArray(v) && LIST_KEYS.has(k)) body[k] = v.map((x) => (typeof x === 'string' ? translate(x, lang) : translateBody(x, lang, depth + 1)));
    else if ((k === 'details' || k === 'fieldErrors') && v && typeof v === 'object' && !Array.isArray(v)) {
      body[k] = Object.fromEntries(Object.entries(v).map(([f, msgs]) => [f, Array.isArray(msgs) ? msgs.map((m) => translate(m, lang)) : translate(msgs, lang)]));
    } else if (k === 'missing' && Array.isArray(v)) {
      body[k] = v.map((m) => (m && typeof m === 'object' && m.label ? { ...m, label: translate(m.label, lang) } : m));
    } else if (v && typeof v === 'object') translateBody(v, lang, depth + 1);
  }
  return body;
}

/**
 * Express middleware. Every response with a top-level message also carries its stable
 * messageCode and messageParams (D-109); for Swahili requests the message fields are
 * translated.
 */
function i18nResponses(req, res, next) {
  const lang = langOf(req);
  req.lang = lang;
  const json = res.json.bind(res);
  res.json = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(body);
    // A JSON copy is changed, never the original: bodies may hold shared constants.
    const copy = JSON.parse(JSON.stringify(body));
    if (typeof copy.message === 'string') {
      const id = identify(copy.message);
      if (id) Object.assign(copy, { messageCode: id.code, messageParams: id.params });
    }
    return json(translateBody(copy, lang));
  };
  next();
}

module.exports = { translate, translateBody, langOf, i18nResponses, identify, render, CATALOGUE, missing };
