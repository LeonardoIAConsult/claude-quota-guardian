# claude-quota-guardian — Design Spec

**Fecha:** 2026-06-11
**Estado:** Aprobado por usuario, listo para plan de implementación
**Idioma de este doc:** Español (artefacto interno de planificación). El README y la documentación del repo público se escriben en inglés para alcance internacional.

---

## 1. Resumen

Herramienta para Claude Code (CLI y Desktop app) que:

1. Monitorea dos métricas de uso en tiempo real: **% de ventana de contexto** de la conversación actual y **% de cuota del plan** (ventana rolling de 5h / semanal de Pro/Max).
2. Cuando cualquiera de las dos cruza **99.5%**, dispara automáticamente un **checkpoint rico** (qué se construyó, qué funcionó, qué no, próximo paso exacto, archivos tocados, decisiones, bloqueos) y notifica al usuario por OS notification.
3. Cuando el usuario reabre Claude Code en el mismo proyecto, **inyecta automáticamente** ese checkpoint como contexto inicial (`SessionStart` hook) para que el trabajo continúe sin que el usuario tenga que re-explicar nada ni Claude tenga que releer/re-derivar nada.
4. Un **watcher en background** (sobrevive reinicio de PC vía Task Scheduler / launchd / systemd) detecta cuándo la cuota del plan vuelve a ~0% y notifica al usuario que puede continuar.

**Explícitamente fuera de alcance v1:** auto-relanzamiento de la sesión de Claude (decisión del usuario — todo queda en "checkpoint + notificación", el usuario decide cuándo reabrir).

---

## 2. Restricciones técnicas conocidas

- Claude Code no expone una API oficial de "% de cuota usada". Se calcula localmente:
  - **% contexto**: leyendo el campo `usage` (tokens) del último mensaje assistant en el transcript JSONL activo (`~/.claude/projects/**/*.jsonl`), comparado contra el límite de contexto del modelo detectado (default 200K; override si se detecta variante de contexto extendido).
  - **% cuota plan**: delegado a `ccusage` (paquete npm comunitario, solo lee logs locales, sin red) si está instalado. Si no está, esta métrica queda `unavailable` y solo se monitorea % contexto.
- Los hooks de Claude Code (`PostToolUse`, `SessionStart`) se asumen disponibles tanto en CLI como en la Desktop app de Claude Code (misma engine, mismo `~/.claude/settings.json`). El instalador valida esto y degrada con gracia si no aplica (Desktop solo recibiría notificaciones del watcher).
- "Opus 4.7" mencionado por el usuario no existe como modelo real; el sistema no fuerza ningún modelo — es agnóstico al modelo activo.

---

## 3. Arquitectura

```
claude-quota-guardian/
├── lib/
│   ├── usage-monitor.js       # cálculo % contexto + % cuota plan
│   ├── plan-limits.json       # constantes de límites por tipo de plan (Pro/Max5x/Max20x)
│   └── paths.js                # helpers: project-hash, rutas ~/.claude/session-continuity/*
├── hooks/
│   ├── check-usage.js          # PostToolUse → detecta 99.5%, dispara checkpoint
│   └── resume-context.js       # SessionStart → auto-carga checkpoint pendiente
├── commands/
│   └── continuity-checkpoint.md  # slash command propio, formato "save-session" rico
├── watcher/
│   └── quota-watcher.js        # proceso standalone, notifica cuando cuota vuelve a 0%
├── bin/
│   ├── install.js              # instalador interactivo
│   └── uninstall.js            # revierte instalación
├── tests/
│   ├── fixtures/                # transcripts JSONL simulados a distintos %
│   ├── lib/usage-monitor.test.js
│   ├── hooks/check-usage.test.js
│   ├── hooks/resume-context.test.js
│   ├── watcher/quota-watcher.test.js
│   └── e2e/full-cycle.test.js
├── scripts/
│   └── simulate-threshold.js   # herramienta dev: genera transcript fake a X% pa probar el ciclo
├── docs/
│   ├── architecture.md
│   ├── configuration.md
│   └── troubleshooting.md
├── .github/workflows/test.yml
├── README.md
├── LICENSE (MIT)
└── package.json
```

**Stack:** Node.js ≥18, CommonJS. Única dependencia externa: `node-notifier` (notificaciones cross-platform: toast en Windows, Notification Center en macOS, `notify-send` en Linux). `ccusage` es dependencia *opcional* (detectada en runtime, no bundleada).

---

## 4. Almacenamiento y formatos de datos

Todo vive bajo `~/.claude/session-continuity/`:

```
~/.claude/session-continuity/
├── config.json                 # config global (un solo usuario/máquina)
├── watcher.log
└── <project-hash>/
    ├── pending.json
    └── checkpoint-<timestamp>.md
```

`<project-hash>` = `sha1(absolute cwd path).slice(0, 12)` — determinístico, usado tanto por los hooks como por el watcher.

### `config.json`

```json
{
  "plan": "pro | max5x | max20x | none",
  "thresholds": { "context": 0.995, "plan": 0.995 },
  "planCheckIntervalToolCalls": 5,
  "watcherIntervalMinutes": 15,
  "notifications": { "enabled": true }
}
```

Generado por `bin/install.js` (pregunta el plan al usuario). `plan: "none"` desactiva el chequeo de % cuota (solo % contexto).

### `pending.json`

```json
{
  "projectPath": "C:\\Users\\USER\\my-project",
  "projectName": "my-project",
  "sessionId": "abc123...",
  "triggeredBy": "plan | context | both",
  "pctAtTrigger": { "context": 99.6, "plan": 87.2 },
  "triggeredAt": "2026-06-11T14:32:00Z",
  "checkpointFile": "...\\checkpoint-2026-06-11T143200.md",
  "consumed": false,
  "consumedAt": null,
  "planResetAtSeen": "2026-06-11T18:00:00Z"
}
```

### `checkpoint-<timestamp>.md`

Mismo formato que el `/save-session` de referencia: `What We Are Building`, `What WORKED`, `What Did NOT Work`, `What Has NOT Been Tried Yet`, `Current State of Files`, `Decisions Made`, `Blockers & Open Questions`, `Exact Next Step`. Generado por `/continuity-checkpoint`.

---

## 5. Componentes

### 5.1 `lib/usage-monitor.js`

- `getContextUsage(transcriptPath)` → lee el último mensaje assistant del JSONL, suma `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, detecta modelo (`claude-*`), busca límite en `plan-limits.json` (default 200000) → `{ pct, used, limit }`.
- `getPlanUsage(planType)` → si `planType !== "none"` y `ccusage` resuelve (binario global o `npx ccusage@latest blocks --json --active`), parsea bloque activo + `resetAt` → `{ available: true, pct, resetAt }`. Si no: `{ available: false, hint: "npm i -g ccusage" }`.
- `getStatus(transcriptPath, config)` → combina ambos, aplica `config.thresholds` → `{ contextPct, planPct, planResetAt, anyAtThreshold, triggeredBy }`.

### 5.2 `hooks/check-usage.js` (hook `PostToolUse`, matcher `*`)

1. Lee stdin JSON (`transcript_path`, `cwd`, `session_id`).
2. % contexto: cada invocación (barato, solo I/O local). % plan: cada `planCheckIntervalToolCalls` invocaciones (cacheado en `pending.json`/contador local) — evita llamar `ccusage` (subprocess ~1-2s) en cada tool-call.
3. Si `anyAtThreshold` y no existe ya `pending.json` con `consumed:false` para esta sesión:
   - Escribe `pending.json` (write atómico: tmp + rename).
   - Notificación OS inmediata: "⚠️ Sesión cerca del límite (contexto/cuota) — guardando progreso...".
   - stdout: hook JSON con `decision: "block"`, `reason`: instrucción a Claude — *"Usage at {pct}%. Stop current task, run /continuity-checkpoint now, do not start new work."*
4. Si ya existe `pending.json` activo: no-op (idempotente, exit 0).
5. Cualquier excepción → log a `~/.claude/session-continuity/watcher.log`, `exit 0` (nunca bloquea a Claude).

### 5.3 `commands/continuity-checkpoint.md`

Slash command autocontenido (no depende de plugins externos). Instruye a Claude a:
1. Recolectar contexto de la sesión (igual que `/save-session`).
2. Escribir `~/.claude/session-continuity/<hash>/checkpoint-<timestamp>.md` con el formato de la sección 4.
3. Actualizar `pending.json`: setear `checkpointFile`.
4. Confirmar al usuario en una línea: "Checkpoint guardado. Podés cerrar Claude — al reabrir, retoma solo."

### 5.4 `hooks/resume-context.js` (hook `SessionStart`, matcher `*`)

1. Lee stdin JSON (`cwd`, `source`).
2. Calcula `<hash>` de `cwd`. Busca `pending.json` con `consumed:false`.
3. Si existe:
   - Lee `checkpointFile`.
   - Si `triggeredAt` tiene más de 7 días → antepone advertencia ("checkpoint de hace N días, revisar si cambió algo").
   - stdout: `{ "hookSpecificOutput": { "additionalContext": "<checkpoint completo> + directiva MODO RETOMAR" } }`.
   - Directiva: *"MODO RETOMAR: ya tenés contexto completo arriba. No preguntes de nuevo ni releas nada — anunciá brevemente el 'Próximo paso' y segui directo. Las confirmaciones normales de seguridad para acciones irreversibles (push, borrar, etc.) siguen aplicando igual."*
   - Marca `consumed: true`, `consumedAt: <now>` (write atómico).
4. Si no hay pendiente: no-op, exit 0.

### 5.5 `watcher/quota-watcher.js` (proceso standalone)

- Disparado por Task Scheduler (Windows, `@logon` + repetir cada `watcherIntervalMinutes`) / launchd (macOS) / systemd user timer o cron (Linux).
- Escanea `~/.claude/session-continuity/*/pending.json` con `consumed:false` y `triggeredBy` incluyendo `"plan"`.
- Si hay al menos uno: llama `getPlanUsage()`. Si `planPct` cayó cerca de 0% respecto al `planResetAtSeen` registrado (reset detectado):
  - Notificación OS: "✅ Cuota reseteada — N proyecto(s) esperando: [nombres]. Abrí Claude y decí 'continuar'."
  - Anti-spam: solo una notificación por ciclo de reset distinto (compara `planResetAtSeen`).
- Logea actividad a `watcher.log`.

---

## 6. Flujo end-to-end

```
[Trabajo normal] → PostToolUse: check-usage.js
       │
       ├─ <99.5% → no-op
       │
       └─ ≥99.5% → pending.json + notif OS + hook "block" instruye checkpoint
                    │
                    ▼
            Claude corre /continuity-checkpoint
            → escribe checkpoint-<ts>.md, actualiza pending.json
            → cierra el turno limpio (no arranca tarea nueva)
                    │
            (tiempo pasa, cuota real llega a 100%, nada se pierde)
                    │
            quota-watcher detecta cuota plan → ~0%
            → notif "podés continuar"
                    │
            Usuario reabre Claude en el mismo proyecto
                    │
            SessionStart: resume-context.js
            → inyecta checkpoint completo + "MODO RETOMAR"
            → marca pending.json consumed:true
                    │
            Claude anuncia próximo paso y continúa — sin preguntas
```

---

## 7. Manejo de errores

| Caso | Comportamiento |
|---|---|
| `ccusage` no instalado | Solo % contexto activo. % plan = `unavailable`. Warning una sola vez (no repetido cada hook). |
| Excepción en cualquier hook | catch-all → log a `watcher.log`, `exit 0` siempre. |
| `transcript_path` inexistente/corrupto | no-op silencioso. |
| `pending.json` corrupto/parcial | tratado como inexistente, se sobrescribe. |
| Apagón a mitad de escritura | writes atómicos (tmp + rename) → nunca queda archivo truncado. |
| Checkpoint de 7+ días | `resume-context` antepone advertencia de antigüedad. |
| Notificación OS falla | log, el watcher/hook continúa sin crashear. |
| Desktop app sin soporte de hooks | degrada a "solo notificaciones del watcher" (documentado en instalador). |

---

## 8. Testing

- `node --test` (built-in, sin dependencias de test extra).
- `tests/fixtures/`: transcripts JSONL simulados a 50%, 99%, 99.6%, con distintos modelos (límites de contexto distintos).
- `usage-monitor.test.js`: cálculo % contexto contra fixtures; mock de subprocess `ccusage` para % plan.
- `check-usage.test.js`: stdin simulado → verifica creación de `pending.json`, `decision:block`, idempotencia (2da llamada no duplica ni renotifica).
- `resume-context.test.js`: pending+checkpoint pre-armados → verifica `additionalContext` correcto y `consumed:true`; caso sin pending → no-op exacto.
- `watcher.test.js`: mock `node-notifier`, verifica detección de reset y anti-spam.
- `tests/e2e/full-cycle.test.js`: ciclo completo simulado (99.6% → checkpoint → reset → resume) de punta a punta sobre fixtures.
- `scripts/simulate-threshold.js`: CLI dev (`node scripts/simulate-threshold.js --pct 99.6`) para que el usuario corra el ciclo real manualmente sin esperar 5h reales — sirve como prueba de aceptación.
- CI: `.github/workflows/test.yml` corre `node --test` en push/PR (Node 18 y 20).

---

## 9. Empaquetado e instalación

- `bin/install.js` (interactivo, `npx claude-quota-guardian install` o `node bin/install.js`):
  1. Detecta SO.
  2. Pregunta plan (Pro/Max5x/Max20x/ninguno) → escribe `config.json`.
  3. Mergea hooks `PostToolUse` y `SessionStart` en `~/.claude/settings.json` **sin pisar hooks existentes** (append a arrays existentes).
  4. Copia `continuity-checkpoint.md` a `~/.claude/commands/`.
  5. Crea `~/.claude/session-continuity/`.
  6. Registra tarea programada para `quota-watcher.js`:
     - Windows: `schtasks /create` (`@logon` + repetición).
     - macOS: plist en `~/Library/LaunchAgents/`.
     - Linux: systemd user timer (con fallback a `crontab @reboot` + `*/N * * * *`).
  7. Verifica `ccusage`; si falta, sugiere `npm i -g ccusage` (no bloqueante).
- `bin/uninstall.js`: revierte 3-6 (remueve hooks agregados, borra tarea programada, deja `session-continuity/` intacto por si el usuario quiere conservar checkpoints).
- `README.md`: qué es, instalación en 1 comando, diagrama ASCII del flujo (sección 6), configuración, troubleshooting, desinstalación. **En inglés.**

---

## 10. Notas / decisiones registradas

- **No auto-relanzamiento** (decisión explícita del usuario): el sistema nunca reinicia Claude Code por su cuenta. Solo checkpoint automático + notificaciones. Esto evita toda la complejidad/fragilidad de invocar `claude` headless y es seguro para Desktop app.
- **Autocontenido**: no depende del plugin ECC ni de `/save-session` existente — trae su propio `/continuity-checkpoint` con formato equivalente, para que cualquiera lo instale standalone. En el setup del usuario convive sin conflicto con `/save-session`.
- **Repo**: `claude-quota-guardian`, MIT, preparado localmente en `D:\Users\USER\Documents\claude-quota-guardian\` (carpeta hermana de "SuperPoderes Claude", repo git propio — no anidado) hasta que el usuario confirme push a GitHub.
- **Cross-platform desde v1** para `lib/`, `hooks/`, `commands/` (Node puro). El *watcher* tiene rama de instalación por SO; Windows es la plataforma probada por el autor, macOS/Linux quedan documentadas y testeadas vía CI pero sin hardware real de validación.

---

## 11. Próximos pasos

1. Spec self-review (placeholders, contradicciones, ambigüedad, scope).
2. Usuario revisa este spec.
3. `writing-plans` → plan de implementación detallado (orden de construcción, milestones, criterios de "done" por componente).
