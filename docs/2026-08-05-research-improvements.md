# Mejoras del research (2026-08-05)

Ideas portadas de repos OSS auditados (limpios, NADA instalado — solo técnicas). Estado tras esta sesión.

## Hecho e integrado
- **Umbral → 98.6%** (`lib/config.js`): `thresholds.context`/`plan` de 0.996/0.995 → 0.986; `desktopWarn` 0.99 → 0.96 (aviso Desktop antes del muro). El predictivo (slope) sigue por encima automáticamente.
- **Checkpoint denso (caveman)** (`commands/continuity-checkpoint.md`): directiva de escribir el contenido denso/sin relleno conservando las 10 secciones e identificadores/rutas/errores/código intactos → menos tokens al reabrir.
- **Reporte de actividad HTML** (`lib/report.js` + `scripts/report.js` + `tests/lib/report.test.js`): idea de `session-report`. Lee los checkpoints + `pending.json` reales y arma un dashboard con checkpoints creados / sesiones retomadas / proyectos protegidos. **Solo cuenta lo medible; no inventa "tokens ahorrados".** 4 tests. Alimenta la prueba social (dogfooding) de la landing.

## Diseñado — validar al reactivar Guardian (T0)
Estas tocan el path de hooks que hoy está **stubeado** (`process.exit(0)`; reales en `*.js.guardian-bak`). No se implementan a ciegas: solo se pueden probar en vivo con Guardian encendido. Al reactivar (T0), implementar + testear:

- **(3a) Checkpoint rolling por turno** (idea `ccjr-state-manager`): en `hooks/heartbeat-stop.js` (hook Stop), mantener un `summary.md` estructurado que se refresca cada turno, para que el resume sea aún más barato y siempre fresco. Complementa el checkpoint de umbral, no lo reemplaza. Enganche: el Stop hook ya existe; añadir escritura atómica de un resumen corto por proyecto (`projectDir/summary.md`).
- **(3b) Project lanes anti cross-contaminación** (idea `claude-continuity-skills`): el aislamiento ya existe vía `lib/paths.js::projectHash(cwd)` (pending/state/checkpoint por hash de proyecto). Falta **reforzar el filtrado** en `hooks/resume-context.js` y `lib/enforce.js` para garantizar que un pending de un proyecto/superficie NO se consuma ni bloquee desde otro (bug conocido de pendings cross-surface). Añadir aserción de que `pending.projectPath` === cwd resuelto antes de bloquear/consumir + test.

## Descartado
- **Proxy/gateway** (`ccNexus`, 9router y similares): hacen MITM de tokens OAuth de Claude → riesgo de seguridad y ToS. No portar nada de esa clase.
- **Estimador P90 de límite** (`Maciek Usage-Monitor`): ya cubierto por el `rate_limits` real por-modelo. YAGNI.
