'use strict';

// Draws each key as a 144x144 SVG. Square shapes only, same colours as the board.

const C = {
  bg: '#0c0c0f', track: '#26262e', text: '#ededf0', muted: '#8d8d9a', purple: '#8457e6',
  ok: '#3fb950', warn: '#d9a520', down: '#e5484d', pending: '#4c8dff', idle: '#5c5c68',
};
const FONT = 'Arial, Helvetica, sans-serif';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function text(str, x, y, size, fill, { anchor = 'middle', weight = 'bold', opacity = 1 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}">${esc(str)}</text>`;
}

function key(stripe, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
    `<rect width="144" height="144" fill="${C.bg}"/><rect width="144" height="12" fill="${stripe}"/>${body}</svg>`;
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

// Largest size from `max` down to `min` at which the text fits the key.
function fit(str, max, min, width = 128) {
  const size = Math.floor(width / (Math.max(1, str.length) * 0.58));
  return Math.max(min, Math.min(max, size));
}

function cut(str, size, width = 128) {
  const room = Math.max(3, Math.floor(width / (size * 0.58)));
  return str.length > room ? `${str.slice(0, room - 1)}…` : str;
}

// Breaks a name into lines of about `room` characters, at spaces, dashes and dots where it can.
function wrap(str, room, maxLines) {
  const parts = String(str).split(/(?<=[\s\-_.:/])/);
  const lines = [];
  let line = '';
  for (let part of parts) {
    while (part.length > room) {
      if (line) { lines.push(line); line = ''; }
      lines.push(part.slice(0, room));
      part = part.slice(room);
    }
    if ((line + part).trimEnd().length > room) { lines.push(line); line = part; } else line += part;
  }
  if (line.trim()) lines.push(line);
  const out = lines.map((l) => l.trim()).filter(Boolean);
  if (out.length > maxLines) {
    out.length = maxLines;
    out[maxLines - 1] = `${out[maxLines - 1].slice(0, room - 1)}…`;
  }
  return out;
}

// view = { board, error }. board is the last good answer (may be null),
// error is a short reason when the latest read failed.

function noData(view, label) {
  return key(C.down, text(label, 72, 44, 18, C.muted) + text('NO DATA', 72, 86, 24, C.down) +
    text(view.error, 72, 118, fit(view.error, 18, 12), C.text, { weight: 'normal' }));
}

function overall(view) {
  const b = view.board;
  if (view.error) return noData(view, 'RSVX');
  if (!b || !b.ready) return key(C.pending, text('RSVX', 72, 44, 18, C.purple) + text('...', 72, 90, 54, C.text) + text('CHECKING', 72, 126, 16, C.muted));
  if (!b.bad) {
    return key(C.ok, text('RSVX', 72, 44, 18, C.purple) + text('OK', 72, 98, 58, C.text) + text(`${b.live}/${b.live}`, 72, 128, 20, C.ok));
  }
  const colour = C[b.overall];
  return key(colour, text('RSVX', 72, 44, 18, C.purple) + text(String(b.bad), 72, 98, 62, colour) +
    text(b.overall === 'down' ? 'DOWN' : 'ATTENTION', 72, 128, b.overall === 'down' ? 20 : 17, C.text));
}

const barColour = (v) => (v >= 95 ? C.down : v >= 85 ? C.warn : C.purple);
const shortLabel = (l) => (/^disk/i.test(l) ? 'DISK' : l.toUpperCase().slice(0, 5));

function pickBar(bars, metric) {
  if (metric === 'cpu') return bars.find((x) => /^cpu/i.test(x.label));
  if (metric === 'ram') return bars.find((x) => /^ram/i.test(x.label));
  if (metric === 'disk') return bars.filter((x) => /^disk/i.test(x.label)).sort((a, z) => z.value - a.value)[0]; // the fullest disk
  return null;
}

function load(view, settings) {
  const b = view.board;
  const metric = settings.metric || 'all';
  if (!b) return view.error ? noData(view, 'LOAD') : key(C.pending, text('LOAD', 72, 84, 22, C.muted));
  const dim = view.error ? 0.4 : 1;
  const stripe = view.error ? C.down : C.purple;

  if (metric !== 'all') {
    const bar = pickBar(b.bars, metric);
    if (!bar) return key(C.idle, text(metric.toUpperCase(), 72, 44, 18, C.muted) + text('N/A', 72, 96, 40, C.muted));
    const colour = barColour(bar.value);
    return key(view.error ? C.down : colour,
      text(shortLabel(bar.label), 72, 44, 20, C.muted) +
      text(`${Math.round(bar.value)}%`, 72, 96, 48, colour === C.purple ? C.text : colour, { opacity: dim }) +
      `<rect x="12" y="114" width="120" height="12" fill="${C.track}"/>` +
      `<rect x="12" y="114" width="${Math.round(120 * bar.value / 100)}" height="12" fill="${colour}" fill-opacity="${dim}"/>`);
  }

  // CPU, RAM and the fullest disk, one row each.
  const rows = [pickBar(b.bars, 'cpu'), pickBar(b.bars, 'ram'), pickBar(b.bars, 'disk')].filter(Boolean);
  let body = '';
  rows.forEach((bar, i) => {
    const y = 26 + i * 39;
    const colour = barColour(bar.value);
    body += text(shortLabel(bar.label), 10, y + 18, 19, C.muted, { anchor: 'start' }) +
      text(`${Math.round(bar.value)}%`, 134, y + 18, 21, colour === C.purple ? C.text : colour, { anchor: 'end', opacity: dim }) +
      `<rect x="10" y="${y + 24}" width="124" height="7" fill="${C.track}"/>` +
      `<rect x="10" y="${y + 24}" width="${Math.round(124 * bar.value / 100)}" height="7" fill="${colour}" fill-opacity="${dim}"/>`;
  });
  return key(stripe, body || text('NO BARS', 72, 84, 20, C.muted));
}

function service(view, settings) {
  const b = view.board;
  const name = settings.service || '';
  if (!name) return key(C.idle, text('PICK A', 72, 70, 22, C.muted) + text('SERVICE', 72, 98, 22, C.muted));
  const lines = wrap(name, 10, 2);
  const size = Math.min(...lines.map((l) => fit(l, 26, 17)));
  const title = (colour, opacity = 1) => lines.map((l, i) =>
    text(cut(l, size), 72, (lines.length === 1 ? 72 : 56) + i * (size + 4), size, colour, { opacity })).join('');

  if (!b) return view.error ? noData(view, cut(name, 18)) : key(C.pending, title(C.muted));
  const s = b.services.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (view.error) return key(C.down, title(C.text, 0.4) + text('NO DATA', 72, 124, 19, C.down));
  if (!s) return key(C.idle, title(C.muted) + text('NOT WATCHED', 72, 124, 15, C.muted));
  const up = s.state === 'ok';
  const colour = C[s.state] || C.idle;
  return key(colour, title(C.text) + text(up ? 'RUNNING' : s.state === 'down' ? 'DOWN' : s.state.toUpperCase(), 72, 124, 20, colour));
}

function failure(view, index) {
  const b = view.board;
  if (view.error) return noData(view, 'FAILED');
  if (!b || !b.ready) return key(C.pending, text('CHECKING', 72, 84, 18, C.muted));
  if (!b.failures.length) return key(C.ok, text('NOTHING', 72, 74, 22, C.text) + text('FAILING', 72, 102, 22, C.text));
  const i = ((index % b.failures.length) + b.failures.length) % b.failures.length;
  const f = b.failures[i];
  const colour = C[f.state];
  const lines = wrap(f.name, 11, 3);
  const top = lines.length === 3 ? 62 : lines.length === 2 ? 72 : 84;
  return key(colour,
    text(`${i + 1}/${b.failures.length}`, 10, 36, 16, C.muted, { anchor: 'start', weight: 'normal' }) +
    text(f.group, 134, 36, 15, colour, { anchor: 'end' }) +
    lines.map((l, n) => text(l, 72, top + n * 24, 21, C.text)).join('') +
    text(f.state === 'down' ? 'DOWN' : 'ATTENTION', 72, 134, 14, colour));
}

module.exports = { overall, load, service, failure, wrap };
