'use strict';

// Swahili amounts in words and dates for the Mkataba (BRD 8: amount and instalment
// "in figures and words"). Ported from the prototype's swWords().

const ONES = ['', 'moja', 'mbili', 'tatu', 'nne', 'tano', 'sita', 'saba', 'nane', 'tisa'];
const TENS = ['', 'kumi', 'ishirini', 'thelathini', 'arobaini', 'hamsini', 'sitini', 'sabini', 'themanini', 'tisini'];
const MONTHS = ['Januari', 'Februari', 'Machi', 'Aprili', 'Mei', 'Juni', 'Julai', 'Agosti', 'Septemba', 'Oktoba', 'Novemba', 'Desemba'];

function under100(n) {
  const t = Math.floor(n / 10);
  const o = n % 10;
  return [TENS[t], o ? ONES[o] : ''].filter(Boolean).join(' na ');
}

function under1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `mia ${ONES[h]}` : '', r ? under100(r) : ''].filter(Boolean).join(' na ');
}

/** 4500000 → "Shilingi milioni nne na elfu mia tano tu" */
function amountInWords(value) {
  const n = Math.round(value);
  if (!n) return 'Shilingi sifuri tu';
  const parts = [];
  const b = Math.floor(n / 1e9);
  const m = Math.floor((n % 1e9) / 1e6);
  const th = Math.floor((n % 1e6) / 1e3);
  const r = n % 1e3;
  if (b) parts.push(`bilioni ${under1000(b)}`);
  if (m) parts.push(`milioni ${under1000(m)}`);
  if (th) parts.push(`elfu ${under1000(th)}`);
  if (r) parts.push(under1000(r));
  const last = parts.pop();
  return `Shilingi ${parts.length ? `${parts.join(', ')} na ${last}` : last} tu`;
}

const tshs = (n) => `Tshs ${Math.round(n).toLocaleString('en-US')}`;

/** '2026-11-25' → '25 Novemba 2026' */
function dateSw(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

module.exports = { amountInWords, tshs, dateSw };
