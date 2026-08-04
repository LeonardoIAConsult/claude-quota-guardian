# Plan — Guardian 4 mejoras (2026-08-04)

## Objetivo
Subir Guardian de "corta la sesión en umbral fijo 99.6%" a un guardián predictivo, con checkpoint más rico, aviso proactivo (Telegram) y aviso de downgrade de modelo. Que sea un instrumento que un ingeniero aprecie: le salva el trabajo sin arriesgar cuenta ni datos, sin proxies de terceros.

## Decisiones (Leonardo, 2026-08-04)
- **Desarrollo sobre copias / rama; reactivar (restaurar los 4 `.bak`) solo al final, con 130 tests en verde.**
- **Mejora 3 = solo aviso de downgrade (honesto).** El switch de modelo automático en vivo NO es alcanzable por hooks de Claude Code. No se promete.
- Rechazado: integrar 9router / cualquier proxy (MITM de tokens, "free premium" = ToS/ban, distribución vía link con mcp_token). No aporta a la capa de continuidad.

## Estado real auditado (2026-08-04)
- Guardian APAGADO por stub desde 26-jul: los 4 hooks en settings = `process.exit(0)`; reales en `*.js.guardian-bak`.
- `settings.json` statusLine = sage (no el statusline.js de Guardian) → Guardian ciego al `rate_limits` real por esa vía; depende de su `usage-api`.
- Umbral FIJO reactivo: `thresholds { context: 0.996, plan: 0.995, desktopWarn: 0.99 }`. `adaptiveWatcher` solo cambia cadencia de polling, no adelanta checkpoint.
- Señales en `getStatus`: contextPct (transcript), planPct (OAuth API/ccusage/rate_limits), entrypoint. NO velocidad, NO modelo propagado.
- Deuda: pendings stale (trampa al reactivar), headroom re-inyecta hooks, enforce bloquea PowerShell/Read, ccusage sin pin, schtasks no a batería.

## Tareas

### T2 — Checkpoint más rico  ✅ HECHO (2026-08-04)
_Step 1b git auto-capture + tabla con columna git status en `commands/continuity-checkpoint.md`. Prompt-only, 0 JS._
- Archivos: `commands/continuity-checkpoint.md` (+ opcional `hooks/enforce-checkpoint.js`).
- Añadir auto-captura git (status + archivos tocados + último commit) a "Current State of Files"; garantizar "Exact Next Step" ejecutable. Guard si no hay repo.
- Hecho: checkpoint con tabla real de archivos + hash + next-step sin ambigüedad.

### T1 — Umbral predictivo  ✅ HECHO (2026-08-04)
_`projectContext` (least-squares slope) en `usage-monitor.js` + bloque `predictive` en `config.js` + ring buffer `predictSamples` persistido en `state.json` vía `threshold-check.js`. Dispara `triggeredBy: 'context-predicted'` ~90s antes del filo si el slope cruza. 8 tests nuevos verdes; suite 142 pass / 16 fail (los 16 = stubs de hooks apagados, se validan en T0). Detalle abajo._
- Archivos: `lib/usage-monitor.js` (getStatus), `lib/config.js` (bloque `predictive`), `state.json` (ring buffer de {pct, ts}).
- Slope tokens/min; `projectedPct = contextPct + slope × leadTime`; si cruza umbral dentro de leadTime (~90s / ~3 tool-calls) → hit ahora. 99.6% queda como piso duro. Suavizar con media de 3 muestras.
- Hecho: test slope alto dispara ~97%; slope plano no adelanta.

### T4 — Aviso proactivo Telegram + continuar/parar  ✅ HECHO (2026-08-04)
_Telegram best-effort en `notify.js` (fire-and-forget, no bloquea el hook; token solo en config local, nunca en git) + bloque `telegram` en `config.js`. Override "continuar bajo mi riesgo": `lib/override.js` (flag con ventana de gracia + expiry), honrado en `lib/enforce.js` (extraído del hook, ahora testeable) y en `performCheck`; comando de usuario `commands/guardian-continue.md` (default 30 min). +13 tests verdes. Detalle abajo._
- Archivos: `lib/notify.js`, `lib/config.js` (`notifications.telegram`).
- Canal Telegram (bot token + chat_id en config local, nunca en git). Override de gracia para "seguir bajo mi riesgo" sin matar sesión.
- Hecho: mensaje Telegram al cruzar umbral + forma explícita de continuar.

### T3 — Aviso de downgrade de modelo (sin switch)  ✅ HECHO (2026-08-04)
_`model` propagado a `getStatus`; `computeDowngradeWarn`/`isHighTierModel` en `threshold-check.js`: notifica "bajá a Sonnet" (OS + Telegram) solo si modelo premium (opus) + planPct en banda [warnPct 85, hard block); throttle 5min vía `lastDowngradeWarnAt` en state. Bloque `downgrade` en config. NOTIFY-ONLY, nunca fuerza switch. +8 tests verdes. Nota: el sugerir modelo menor en el resume quedó fuera (scope acordado = solo aviso)._
- Archivos: propagar `model` de usage-monitor → getStatus; `lib/notify.js` + `hooks/check-usage.js`.
- Umbral bajo (ej. plan 85%) → additionalContext + notify "bajá a Sonnet"; el resume registra y sugiere modelo menor. NO fuerza.
- Hecho: aviso con modelo actual + sugerencia. Documentar límite (switch forzado fuera de alcance).

### T0 — Prerrequisitos (antes de reactivar)
- Limpiar pendings stale. Correr 130 tests. Al final: restaurar los 4 `.bak` (headroom re-inyecta en settings).

## Orden
T2 → T1 → T4 → T3 → T0 (reactivación).

---

## Mejoras externas (research GitHub + /cyber-neo, 2026-08-04)

### T5 — Rate limits reales por modelo (de claude-pulse)  ✅ HECHO
_Audit /cyber-neo: claude-pulse LIMPIO (token OAuth domain-allowlisted, opener sin redirects, subprocess solo git, borra solo lo suyo; su instalador toca statusLine pero NO borra Guardian; no instalado, solo portamos técnica). Guardian ya leía 5h/7d de stdin; port añade caps semanales **por modelo** (`seven_day_opus/sonnet/...`, genérico) en `lib/rate-limits.js` (parser endurecido: try/except por-ventana, epoch|iso, bad resets_at conserva ventana). `statusline.js` cachea `rateLimitByModel` en state; `computeDowngradeWarn` (T3) ahora usa el cap real por-modelo sobre el plan% global. +8 tests. Suite 187 → 171 pass / 16 fail (stubs)._

### T6 — Predictor endurecido (de Maciek-roboblog/Claude-Code-Usage-Monitor)  ⏭️ AUDITADO LIMPIO, PORT DESCARTADO
_Audit /cyber-neo: LIMPIO (subprocess solo tz/WSL sin shell, urllib solo endpoint oficial, cero eval/exec, no toca settings — es pip standalone). Valor (P90 estima el cap de plan desde historial) YA cubierto por la señal real de T5 → portarlo = redundante (YAGNI). Slice opcional "predicción reset-aware del plan%" ofrecido y NO tomado por Leonardo. Decisión: saltar._
### T7 — Checkpoint con estado de tareas (de agent-session-resume)  ✅ HECHO
_Audit /cyber-neo: MUY LIMPIO (scripts read-only, cero red/subprocess/eval/escrituras; grep de patrones peligrosos = 0 matches; skill package, no toca settings). Port prompt-only: `continuity-checkpoint.md` gana sección "Task Status (evidence-based)" DONE/PARTIALLY DONE/NOT DONE/DEFERRED con evidencia obligatoria; `resume-context.js.guardian-bak` refuerza la directiva de retoma ("si un archivo actual contradice el checkpoint, confiá en el archivo; no reabras DEFERRED sin pedido"). Sin cambios de tests (prompt). Suite 187 / 171 pass / 16 fail._

## Repos auditados (clones en Documents/_repo-audit, borrables)
- claude-pulse (T5) · Claude-Code-Usage-Monitor (T6) · agent-session-resume (T7) — los 3 LIMPIOS. Nada instalado; solo técnicas portadas.
