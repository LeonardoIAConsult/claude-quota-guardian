---
description: Save a rich, resumable checkpoint before usage limits are reached, so the next session can resume without re-explaining context.
---

# /continuity-checkpoint

You are at or near a usage limit (context window or plan quota). Your job: capture everything a future session needs to resume this exact task with zero re-explanation, then stop.

## Step 1 — Compute paths

Run this in Bash (works on Windows/macOS/Linux with Node ≥18):

```bash
node -e "const c=require('crypto'),p=require('path'),fs=require('fs'),os=require('os');const cwd=process.cwd();const hash=c.createHash('sha1').update(p.resolve(cwd)).digest('hex').slice(0,12);const root=p.join(os.homedir(),'.claude','session-continuity',hash);fs.mkdirSync(root,{recursive:true});const ts=new Date().toISOString().replace(/[:.]/g,'-');console.log(JSON.stringify({root,ts,checkpoint:p.join(root,'checkpoint-'+ts+'.md'),pending:p.join(root,'pending.json')}))"
```

This prints a JSON object with `root`, `ts`, `checkpoint`, and `pending` paths. Use these exact paths in the next steps.

## Step 2 — Write the checkpoint file

Write to the `checkpoint` path from Step 1, with this exact structure (fill in real content from this session — no placeholders):

```markdown
# Checkpoint — <ISO timestamp>

## What We Are Building
<1-3 sentences: the overall goal of this project/task>

## What WORKED
<bullet list of completed, verified work, with evidence (file paths, test results, commit hashes)>

## What Did NOT Work
<bullet list of approaches tried and abandoned, and WHY — so they aren't retried>

## What Has NOT Been Tried Yet
<bullet list of remaining approaches/ideas not yet attempted>

## Current State of Files
| File | State |
|---|---|
<one row per file touched this session, with current status>

## Decisions Made
<bullet list of decisions and their rationale>

## Blockers & Open Questions
<anything unresolved that needs user input — or "None">

## Exact Next Step
<the SINGLE concrete next action, specific enough to execute with zero ambiguity>
```

## Step 3 — Update pending.json

Read the `pending` path from Step 1.

If it exists (the check-usage hook created it): update its `checkpointFile` field to the `checkpoint` path from Step 1, keeping all other fields unchanged. Write it back atomically — write to `<pending>.tmp` in the same directory, then rename over `pending.json`.

If it does NOT exist (this command was run manually, not triggered by the hook): create it with this shape, then write it atomically the same way:

```json
{
  "projectPath": "<cwd>",
  "projectName": "<basename of cwd>",
  "sessionId": null,
  "triggeredBy": "manual",
  "pctAtTrigger": { "context": null, "plan": null },
  "triggeredAt": "<ISO timestamp>",
  "checkpointFile": "<checkpoint path>",
  "consumed": false,
  "consumedAt": null,
  "planResetAtSeen": null
}
```

## Step 4 — Confirm and stop

Reply with exactly one line:

> Checkpoint guardado en `<checkpoint path>`. Podés cerrar Claude — al reabrir en este proyecto, retoma solo.

Then end your turn. Do NOT start any new task.
