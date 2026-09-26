/* csv.js — minimal RFC 4180 CSV encode/parse, no dependencies. */
'use strict';

function encodeCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// rows: array of objects; columns: array of keys (also the header line)
function stringify(columns, rows) {
  const lines = [columns.map(encodeCell).join(',')];
  rows.forEach(r => lines.push(columns.map(c => encodeCell(r[c])).join(',')));
  return lines.join('\r\n') + '\r\n';
}

// Returns array of objects keyed by the header row. Handles quoted cells, doubled quotes, embedded newlines.
function parse(text) {
  const rows = [];
  let row = [], cell = '', inQ = false, i = 0;
  text = String(text || '').replace(/^﻿/, '');
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
      i += (ch === '\r' && text[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(r => r.length > 1 || r[0] !== '').map(r => {
    const o = {};
    header.forEach((h, k) => { o[h] = r[k] === undefined ? '' : r[k]; });
    return o;
  });
}

module.exports = { encodeCell, stringify, parse };
