#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
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

  let checkpoint;
  try {
    checkpoint = fs.readFileSync(pending.checkpointFile, 'utf8');
  } catch {
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
  try {
    fs.appendFileSync(paths.logPath(), `[resume-context] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}
