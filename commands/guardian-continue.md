---
description: Push past the Guardian checkpoint block for a grace window ("continue at my own risk") instead of stopping to checkpoint.
---

# /guardian-continue

The user chose to keep working past the usage threshold instead of checkpointing now. Write a time-boxed override so `enforce-checkpoint` stops hard-blocking this project for a grace window. Default 30 minutes unless the user gave a number of minutes.

## Step 1 — Write the override

Run in Bash (set `MINUTES` to the user's number, else 30):

```bash
MINUTES=30 node -e "const c=require('crypto'),p=require('path'),fs=require('fs'),os=require('os');const cwd=process.cwd();const hash=c.createHash('sha1').update(p.resolve(cwd)).digest('hex').slice(0,12);const dir=p.join(os.homedir(),'.claude','session-continuity',hash);fs.mkdirSync(dir,{recursive:true});const m=Math.max(1,parseInt(process.env.MINUTES||'30',10));const until=new Date(Date.now()+m*60000).toISOString();fs.writeFileSync(p.join(dir,'override.json'),JSON.stringify({until,createdAt:new Date().toISOString(),reason:'user /guardian-continue'},null,2));console.log('Guardian override activo hasta '+until)"
```

## Step 2 — Confirm and warn

Reply on one line:

> Guardian no bloqueará hasta `<until>`. Aviso: seguís bajo tu propio riesgo — el trabajo NO está checkpointeado; si se corta la sesión antes de `/continuity-checkpoint`, se pierde lo no guardado.

Then continue the task. Do NOT run `/continuity-checkpoint` unless the user asks.
