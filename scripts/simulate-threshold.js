#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
  const out = { pct: 99.6, model: 'claude-sonnet-4-6', limit: 200000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pct') out.pct = parseFloat(argv[++i]);
    else if (argv[i] === '--model') out.model = argv[++i];
    else if (argv[i] === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

function main() {
  const { pct, model, limit } = parseArgs(process.argv.slice(2));
  const used = Math.round((pct / 100) * limit);

  const entry = {
    type: 'assistant',
    entrypoint: 'cli',
    message: {
      id: 'msg_simulated',
      role: 'assistant',
      model,
      usage: {
        input_tokens: used,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 100,
      },
    },
  };

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-sim-'));
  const outFile = path.join(outDir, 'transcript.jsonl');
  fs.writeFileSync(outFile, JSON.stringify(entry) + '\n');

  console.log(`Simulated transcript written to: ${outFile}`);
  console.log(`Target: ${pct}% (${used}/${limit} tokens, model=${model})`);
  console.log('');
  console.log('Test the hook with:');
  console.log(`  echo '{"transcript_path":${JSON.stringify(outFile)},"cwd":${JSON.stringify(process.cwd())},"session_id":"sim"}' | node hooks/check-usage.js`);
}

main();
