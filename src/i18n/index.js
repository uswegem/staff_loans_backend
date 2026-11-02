'use strict';

// Messages the API shows people, in English or Swahili (D-94). The web app sends
// Accept-Language: sw when the person has chosen Swahili; English is the default and
// the fallback for anything not yet translated. Only message fields are translated
// (never names, staff numbers, figures the person entered or agreement text).
//
// src/i18n/sw.js lists [English, Swahili] pairs. {name} in an entry stands for any
// text; the matching part is carried into the Swahili, translated itself when it is a
// known phrase or a comma-separated list of them.

const SW = require('./sw');

const exact = new Map();
const patterns = [];
for (const [en, sw] of SW) {
  if (!/\{\w+\}/.test(en)) {
    exact.set(en, sw);
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
  patterns.push({ re: new RegExp(`^${source}$`, 's'), names, sw });
}

/** A carried-over value: a known phrase or message, or a list of phrases, in Swahili; otherwise as it is. */
function inner(value) {
  if (exact.has(value)) return exact.get(value);
  // eslint-disable-next-line no-use-before-define
  if (/[.!?]$/.test(value) && value.includes(' ')) return translate(value, 'sw');
  if (value.includes(', ')) {
    const parts = value.split(', ');
    if (parts.some((p) => exact.has(p))) return parts.map((p) => exact.get(p) ?? p).join(', ');
  }
  return value;
}

function one(text) {
  if (exact.has(text)) return exact.get(text);
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) return p.names.reduce((out, name, i) => out.split(`{${name}}`).join(inner(m[i + 1])), p.sw);
  }
  return null;
}

/** text in the language; untranslated text stays in English. Sentences are tried one by one. */
function translate(text, lang) {
  if (lang !== 'sw' || typeof text !== 'string' || !text) return text;
  const whole = one(text);
  if (whole != null) return whole;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  if (!sentences || sentences.length < 2) return text;
  return sentences.map((s) => {
    const t = s.trim();
    const done = one(t);
    return `${done ?? t}${/\s$/.test(s) ? ' ' : ''}`;
  }).join('').trim();
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

/** Express middleware: res.json translates message fields for Swahili requests. */
function i18nResponses(req, res, next) {
  const lang = langOf(req);
  req.lang = lang;
  if (lang === 'sw') {
    const json = res.json.bind(res);
    // A JSON copy is translated, never the original: bodies may hold shared constants.
    res.json = (body) => json(body && typeof body === 'object' ? translateBody(JSON.parse(JSON.stringify(body)), lang) : body);
  }
  next();
}

module.exports = { translate, translateBody, langOf, i18nResponses };
