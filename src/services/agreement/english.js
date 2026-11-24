'use strict';

// English amounts in words and dates for English agreement templates (BRD 8: amount and
// instalment "in figures and words"), the counterpart of swahili.js.

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function under100(n) {
  if (n < 20) return ONES[n];
  const o = n % 10;
  return o ? `${TENS[Math.floor(n / 10)]}-${ONES[o]}` : TENS[Math.floor(n / 10)];
}

function under1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} hundred` : '', r ? under100(r) : ''].filter(Boolean).join(' and ');
}

/** 4500000 → "Four million five hundred thousand shillings only" */
function amountInWords(value) {
  const n = Math.round(value);
  if (!n) return 'Zero shillings only';
  const parts = [];
  const b = Math.floor(n / 1e9);
  const m = Math.floor((n % 1e9) / 1e6);
  const th = Math.floor((n % 1e6) / 1e3);
  const r = n % 1e3;
  if (b) parts.push(`${under1000(b)} billion`);
  if (m) parts.push(`${under1000(m)} million`);
  if (th) parts.push(`${under1000(th)} thousand`);
  // "one million and fifty": a remainder under 100 after a larger part takes "and".
  if (r) parts.push(parts.length && r < 100 ? `and ${under100(r)}` : under1000(r));
  const words = parts.join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} shillings only`;
}

const tzs = (n) => `TZS ${Math.round(n).toLocaleString('en-US')}`;

/** '2026-11-25' → '25 November 2026' */
function dateEn(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

module.exports = { amountInWords, tzs, dateEn };
