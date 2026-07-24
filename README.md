<p align="center"><img src="assets/banner.png" alt="Claude Quota Guardian" width="100%"></p>

# 🛡️ Claude Quota Guardian

> 🇬🇧 [English version](README.en.md)

**Tu red de seguridad para sesiones largas de IA.** Guardian vigila en segundo plano cuánto contexto y cuota consume tu sesión de Claude Code y, justo antes del corte, obliga a guardar un checkpoint estructurado que la próxima sesión retoma sola — sin perder el hilo, sin re-explicar nada.

## El problema

Cualquiera que trabaje sesiones largas con un agente de IA conoce el momento: llevás horas construyendo algo, el contexto se llena o la cuota del plan se agota, y la sesión muere a mitad de una tarea. Lo que sigue es peor que el corte: reabrir, re-explicar todo desde cero, y ver al agente re-intentar caminos que ya habían fallado.

## Qué hace Guardian

Cuando una **sesión de Claude Code en terminal** se acerca a su límite (contexto de la conversación o cuota 5h/7d del plan), Guardian:

1. **Detecta el umbral** (99.6% por defecto) tras cada tool call y cada turno — incluye la cuota real de tu cuenta Pro/Max vía `rate_limits`, no solo estimaciones locales.
2. **Frena el trabajo nuevo** con un bloqueo real de herramientas (hook `PreToolUse`): el agente no puede seguir quemando tokens sin guardar primero.
3. **Fuerza un checkpoint estructurado** (`/continuity-checkpoint`): qué se estaba construyendo, qué funcionó (con evidencia), qué NO funcionó y por qué, estado de cada archivo, decisiones tomadas, y el próximo paso exacto.
4. **Avisa cuando la cuota se reinicia** (watcher en segundo plano con notificaciones del sistema, cadencia adaptativa 15→3→1 min según qué tan llena está la sesión).
5. **Retoma solo**: al reabrir Claude Code en ese proyecto, un hook `SessionStart` inyecta el checkpoint completo como contexto. El agente anuncia el próximo paso y sigue — cero re-explicación.

```
[Trabajo normal] -> PostToolUse: check-usage.js
       |
       |-- bajo el umbral -> no-op
       |
       `-- >= 99.6% -> pending.json + notificación OS + bloqueo
                        |
                        v
                Claude ejecuta /continuity-checkpoint
                -> escribe checkpoint-<ts>.md
                -> cierra el turno limpio
                        |
              (cerrás Claude; la cuota se reinicia después)
                        |
              quota-watcher (fondo) detecta el reset
              -> notificación: "listo para continuar"
                        |
              Reabrís Claude en el mismo proyecto
                        |
                SessionStart: resume-context.js
                -> inyecta el checkpoint completo
                        |
                Claude anuncia el próximo paso y sigue
```

Sin relanzamiento automático: vos decidís cuándo reabrir. Guardian solo se encarga del guardado y la retoma.

## Beneficios (comprobables)

- **Cero contexto perdido**: el checkpoint captura lo que un resumen automático pierde — los caminos que fallaron y por qué, para que no se re-intenten.
- **Cero tokens quemados a ciegas**: el bloqueo duro impide que el agente siga trabajando sobre una sesión condenada.
- **Señal real, no estimada**: usa el `rate_limits` account-wide (5h/7d) que Claude Code expone — el mismo número que ve tu cuenta.
- **Instalación de 1 comando, desinstalación limpia**: mergea sus hooks en `settings.json` sin tocar los tuyos; el uninstaller solo quita lo suyo.
- **Multi-OS**: Windows (Task Scheduler), macOS (launchd), Linux (systemd/cron).
- **130/130 tests** en Node 18 y 20 (`npm test`, CI incluido).
- **Extensible a otros proveedores de IA**: arquitectura de adaptadores; hoy incluye monitoreo notify-only de **OpenAI Codex CLI** (lee sus logs de sesión locales y te avisa antes del corte).

## ¿Para quién es?

- **Usuarios de Claude Code con plan Pro/Max** que chocan contra la ventana de 5h en sesiones intensas.
- **Devs que corren agentes autónomos** en tareas largas (refactors, auditorías, features multi-archivo) donde un corte a mitad de camino cuesta horas.
- **Freelancers y equipos chicos** que facturan por resultado y no pueden pagar el costo de re-explicar contexto en cada sesión.
- **Usuarios multi-CLI** que alternan Claude Code y Codex y quieren una sola red de seguridad.

## Alcance honesto

- El loop completo (detectar → bloquear → checkpoint → retoma automática) aplica a **Claude Code en terminal** (`entrypoint === "cli"`), la única superficie con hooks y un "cerrá el turno" real. Desktop/IDE solo aportan heartbeat al watcher; nunca se bloquean.
- Otros proveedores (Codex hoy) son **notify-only**: sin sistema de hooks no hay bloqueo ni retoma automática posible — Guardian te avisa a tiempo para pedirle un resumen antes del corte.
- El % de contexto local es una estimación conservadora (ver [docs/configuration.md](docs/configuration.md)); la señal de cuota `rate_limits` es real.

## Requisitos

- Node.js >= 18
- Claude Code (CLI) con soporte de hooks

## Instalación rápida

```bash
git clone <repo-url> ~/.claude/claude-quota-guardian
cd ~/.claude/claude-quota-guardian
npm install
node bin/install.js
```

Ese único comando: escribe la config por defecto, mergea los hooks en `~/.claude/settings.json` (sin pisar los existentes), reclama el `statusLine` para tracking real de cuota (solo si está libre), instala el comando `/continuity-checkpoint` y registra el watcher en el programador de tareas de tu OS.

### Desinstalar

```bash
node bin/uninstall.js          # quita hooks, comando y watcher
node bin/uninstall.js --purge  # además borra los checkpoints guardados
```

### Probar la instalación

```bash
node scripts/simulate-threshold.js --pct 99.7
```

Imprime un comando listo para simular una sesión al límite y confirmar que el hook dispara, sin esperar a que una sesión real se llene.

## Configuración

Todo opcional, con defaults sensatos: umbrales, plan, cadencia del watcher, proveedores externos. Ver [docs/configuration.md](docs/configuration.md).

## Qué incluye

- **Loop principal** — `hooks/check-usage.js` (detección), `hooks/enforce-checkpoint.js` (bloqueo real), `hooks/resume-context.js` (retoma automática). Solo superficie terminal.
- **Watcher en segundo plano** — `watcher/quota-watcher.js`: aviso de reset de cuota + cadencia adaptativa.
- **Adaptadores de proveedor** — `lib/adapters/codex.js`: monitoreo notify-only de sesiones de OpenAI Codex CLI.
- **Instalador / desinstalador** — `bin/install.js` / `bin/uninstall.js`.

## Licencia

MIT
