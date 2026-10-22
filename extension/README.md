# Quota Guardian — Monitor (extensión de navegador)

Extensión de navegador (Chrome/Edge/Brave, Manifest V3) para **ver en vivo tu consumo de Claude** sin abrir Ajustes: sesión (5h), límite semanal y límites por modelo (p. ej. Fable).

## Qué muestra

- **Insignia (badge)** en el icono de la barra: el porcentaje de la ventana más apretada (`72%`), con color verde / naranja / rojo según cercanía al tope. Al pasar el ratón dice qué ventana es ese número y muestra todas, con la hora del dato. Se actualiza en segundo plano cada ~2 min; si una lectura falla, queda el último dato en gris.
- **Popup** al hacer clic:
  - **Sesión** (5h) y **Semanal** — las ventanas que gatean todo (barras principales).
  - **Por modelo** (Fable, etc.) — solo informativo (esos límites afectan a un modelo, no a todo).
  - **Créditos en dólares** (por ejemplo, el crédito para sesiones en la nube): usado, restante y vencimiento. Se reconocen por la forma de la respuesta, no por su nombre interno, así que siguen apareciendo aunque Anthropic renombre el campo. No cuentan para la insignia.
  - Tiempo de reinicio de cada ventana y botón de actualizar.
  - **Caché de Claude Code**: una fila por cada sesión de Claude Code de las últimas 24 h, con los minutos que le quedan al caché (verde; naranja con 5 min o menos; rojo cuando venció). Se actualiza cada 30 s con el popup abierto. Cuando vence, el siguiente mensaje de esa sesión vuelve a pagar todo el contexto.

## El caché se lee en tu equipo

El navegador no puede leer archivos de tu disco. Por eso `node bin/install.js` (en la raíz del repo) registra un programa local, `native-host/guardian-host.js`, como *native messaging host* de Chrome, Edge, Brave y Chromium:

- Solo esta extensión puede abrirlo: su ID queda fijo por la `key` de `manifest.json` y el host solo acepta ese origen.
- Lee los `state.json` que Guardian ya escribe y responde nombres de proyecto y minutos. Nunca rutas, nunca el contenido de tus conversaciones, sin red.
- Si no está instalado, el popup te lo dice y lo demás sigue funcionando igual.
- `node bin/uninstall.js` lo quita.

## Privacidad / seguridad

- **No maneja tokens ni contraseñas.** Usa la MISMA llamada que la pantalla "Uso" de la propia app de Claude (`/api/organizations/<org>/usage`), autenticada con **las cookies de tu sesión de claude.ai** que ya tienes en el navegador (`credentials: 'include'`).
- Único permiso de host: `https://claude.ai/*`. No envía tus datos a ningún tercero: la respuesta se muestra localmente y se cachea en `chrome.storage.local`.
- Requiere estar con sesión iniciada en claude.ai en ese navegador.

## Instalar (carga sin empaquetar)

1. Abre `chrome://extensions` (o `edge://extensions`).
2. Activa **Modo desarrollador** (arriba a la derecha).
3. **Cargar descomprimida** → selecciona esta carpeta `extension/`.
4. Fija el icono en la barra. Abre/recarga una pestaña de claude.ai con tu sesión iniciada.
5. Para el caché de Claude Code: corre `node bin/install.js` y reinicia el navegador.

**Si venías de la versión 1.0:** quítala en `chrome://extensions` y vuelve a cargar la carpeta. La 1.1 tiene un ID fijo nuevo (lo necesita el puente local), así que Chrome la trata como otra extensión.

## Notas

- El modelo de ventanas (qué bloquea vs. qué solo avisa) es el mismo criterio que el motor CLI de Guardian: **account-wide = principal; con scope de modelo/superficie = informativo** (`extension/lib/usage.js` refleja `lib/usage-api.js`).
- La app de escritorio de Claude (Electron) no admite extensiones de navegador estándar; esta extensión es para el navegador. El consumo mostrado es el de tu cuenta, así que refleja también lo que gastas desde el escritorio o Claude Code.
