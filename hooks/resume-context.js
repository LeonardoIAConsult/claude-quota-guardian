#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../lib/paths');
const { atomicWriteFileSync } = require('../lib/atomic-write');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// Whatever checkpointFile names is injected into the new session as trusted
// context ("continue directly"), and pending.json is a plain local file. Only
// auto-load a markdown checkpoint that really lives in this project's
// continuity dir, where /continuity-checkpoint writes it. Links are resolved
// on both sides and hard-linked files refused: a junction, symlink or hard
// link could otherwise make a path that looks inside point at any file (a
// credential). A repo's own files are never auto-loaded either.
function allowedCheckpoint(file, cwd) {
  if (typeof file !== 'string' || !/\.md$/i.test(file)) return false;
  try {
    const real = fs.realpathSync.native(file);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.nlink !== 1) return false;
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const dir = fs.realpathSync.native(paths.projectDir(cwd));
    return norm(real).startsWith(norm(dir.endsWith(path.sep) ? dir : dir + path.sep));
  } catch {
    return false;
  }
}

function log(line) {
  try {
    fs.appendFileSync(paths.logPath(), `[resume-context] ${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging is best-effort
  }
}

function main() {
  const input = readStdin();
  if (!input || !input.cwd) {
    return;
  }

  const pendingFile = paths.pendingPath(input.cwd);
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    return;
  }

  if (!pending || pending.consumed !== false || !pending.checkpointFile) {
    return;
  }
  let checkpoint = null;
  if (allowedCheckpoint(pending.checkpointFile, input.cwd)) {
    try {
      checkpoint = fs.readFileSync(pending.checkpointFile, 'utf8');
    } catch {
      checkpoint = null;
    }
  }

  // Refused or unreadable: still consume the pending -- nothing else ever
  // consumes a checkpointed one, so leaving it would keep this project
  // hard-blocked for good. Point at the file instead of injecting it; reading
  // it then goes through the normal tools and their permission checks.
  if (checkpoint === null) {
    pending.consumed = true;
    pending.consumedAt = new Date().toISOString();
    pending.consumedReason = 'checkpoint-not-auto-loaded';
    atomicWriteFileSync(pendingFile, JSON.stringify(pending, null, 2));
    // Quoted and capped: the path comes from a plain local file.
    const shown = JSON.stringify(String(pending.checkpointFile).slice(0, 300));
    log(`checkpoint not auto-loaded (outside continuity dir, linked or unreadable): ${shown}`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Claude Quota Guardian: la sesión anterior registró un checkpoint en ${shown}, pero no se cargó automáticamente (está fuera de la carpeta de continuidad de este proyecto, es un enlace, o ya no existe). No lo leas por tu cuenta: mencionale esta ruta al usuario y leelo solo si él lo confirma.`,
      },
    }));
    return;
  }

  let header = '';
  const ageMs = Date.now() - new Date(pending.triggeredAt).getTime();
  if (ageMs > 7 * MS_PER_DAY) {
    const days = Math.floor(ageMs / MS_PER_DAY);
    header += `**ADVERTENCIA:** este checkpoint tiene ${days} días. Verificá si algo cambió antes de continuar.\n\n`;
  }

  const directive = '\n\n---\n\n**MODO RETOMAR:** ya tenés el contexto completo arriba. No preguntes de nuevo ni releas archivos para entender qué se estaba haciendo — anunciá brevemente el "Próximo paso" y continuá directo. Las confirmaciones normales de seguridad para acciones irreversibles (push, borrar, etc.) siguen aplicando igual.';

  pending.consumed = true;
  pending.consumedAt = new Date().toISOString();
  atomicWriteFileSync(pendingFile, JSON.stringify(pending, null, 2));

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: header + checkpoint + directive,
    },
  }));
}

try {
  main();
} catch (err) {
  log(`ERROR ${err.stack}`);
}
