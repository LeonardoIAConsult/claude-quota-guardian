'use strict';

const fs = require('node:fs');
const paths = require('./paths');
const override = require('./override');

// Tools the documented /continuity-checkpoint flow actually needs: Bash to
// compute paths and atomically update pending.json, Write for the checkpoint
// file itself. Everything else is "new work" -- exactly what must stop once a
// checkpoint is pending and unconsumed.
const ALLOWED_WHILE_PENDING = new Set(['Bash', 'Write']);

// Pure decision for the PreToolUse hard stop. Returns a { decision, reason }
// object to block, or null to allow. Time-injected (`now`) for deterministic
// tests. The hook is a thin wrapper that just prints whatever this returns.
function enforceDecision(input, { now = Date.now() } = {}) {
  if (!input || !input.cwd || !input.tool_name) return null;
  if (ALLOWED_WHILE_PENDING.has(input.tool_name)) return null;

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(paths.pendingPath(input.cwd), 'utf8'));
  } catch {
    return null;
  }
  if (!pending || pending.consumed !== false) return null;

  // User explicitly chose to push through ("continuar bajo mi riesgo"): honor
  // the unexpired grace override and let the tool run instead of hard-blocking.
  if (override.isActive(input.cwd, now)) return null;

  return {
    decision: 'block',
    reason: `Claude Quota Guardian: usage threshold hit and not yet checkpointed. Tool "${input.tool_name}" is blocked. Run /continuity-checkpoint now (it only needs Bash/Write, both still allowed), or /guardian-continue to push through for a grace window, then end the turn.`,
  };
}

module.exports = { enforceDecision, ALLOWED_WHILE_PENDING };
