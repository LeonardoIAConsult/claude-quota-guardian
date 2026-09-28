#!/usr/bin/env node
'use strict';

// CLI: show dollar-denominated credits (e.g. the cloud-session promo credit).
//   node scripts/credits.js [--json]
// Goes through the same throttled, shared reading every Guardian hook uses, so
// it honors the anti-429 backoff and reuses a fresh reading instead of sending
// a request. The token goes through stdin to a child process and is never printed.

const { getThrottledUsage } = require('../lib/usage-api');

function fmtUsd(n) {
  return `USD ${n.toFixed(2)}`;
}

function fmtExpiry(iso, nowMs) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.ceil((t - nowMs) / 86_400_000);
  const date = new Date(t).toISOString().slice(0, 10);
  return days > 0 ? ` · vence ${date} (en ${days} d)` : ` · vencido ${date}`;
}

function renderCredits(credits, nowMs = Date.now()) {
  if (!credits.length) return 'Sin créditos en dólares en tu cuenta.\n';
  return credits
    .map((c) => `${c.label}: ${fmtUsd(c.used)} usados de ${fmtUsd(c.limit)} · quedan ${fmtUsd(c.remaining)}`
      + ` (${Math.round(c.pct)}%)${fmtExpiry(c.expiresAt, nowMs)}\n`)
    .join('');
}

// Turns a (throttled) usage reading into what the command prints. A reading
// stored before credits existed carries credits === undefined: that is
// "unknown", never "none" -- the next refresh (at most a minute) fills it.
function describe(result, nowMs = Date.now()) {
  if (!result.available) {
    return { ok: false, text: `No se pudo leer el uso (${result.reason}).\n` };
  }
  if (!Array.isArray(result.credits)) {
    return { ok: false, text: 'La última lectura guardada es anterior a los créditos; vuelve a intentarlo en unos minutos.\n' };
  }
  // During a backoff the reading can be minutes old: say so, so a stale amount
  // never reads as live.
  const fetched = Date.parse(result.fetchedAt);
  const ageMin = Number.isFinite(fetched) ? Math.floor((nowMs - fetched) / 60_000) : null;
  const age = ageMin !== null && ageMin >= 2 ? `(lectura de hace ${ageMin} min)\n` : '';
  return { ok: true, text: renderCredits(result.credits, nowMs) + age, credits: result.credits };
}

// The read MUST go through getThrottledUsage (anti-429 backoff + shared
// reading). Exposed as a named function so a test runs the command's real
// read path instead of re-wiring it.
function readUsage() {
  return getThrottledUsage({ cacheSeconds: 60 });
}

function main({ argv = process.argv, stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = describe(readUsage());
  if (!out.ok) {
    stderr.write(out.text);
    return 1;
  }
  stdout.write(argv.includes('--json') ? JSON.stringify(out.credits, null, 2) + '\n' : out.text);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { renderCredits, describe, readUsage, main };
