# Quota Guardian — Monitor (extensión de navegador)

Extensión de navegador (Chrome/Edge/Brave, Manifest V3) para **ver en vivo tu consumo de Claude** sin abrir Ajustes: sesión (5h), límite semanal y límites por modelo (p. ej. Fable).

## Qué muestra

- **Insignia (badge)** en el icono de la barra: el porcentaje de la ventana más apretada (sesión o semanal), con color verde / naranja / rojo según cercanía al tope. Se actualiza en segundo plano cada ~2 min.
- **Popup** al hacer clic:
  - **Sesión** (5h) y **Semanal** — las ventanas que gatean todo (barras principales).
  - **Por modelo** (Fable, etc.) — solo informativo (esos límites afectan a un modelo, no a todo).
  - Tiempo de reinicio de cada ventana y botón de actualizar.

## Privacidad / seguridad

- **No maneja tokens ni contraseñas.** Usa la MISMA llamada que la pantalla "Uso" de la propia app de Claude (`/api/organizations/<org>/usage`), autenticada con **las cookies de tu sesión de claude.ai** que ya tienes en el navegador (`credentials: 'include'`).
- Único permiso de host: `https://claude.ai/*`. No envía tus datos a ningún tercero: la respuesta se muestra localmente y se cachea en `chrome.storage.local`.
- Requiere estar con sesión iniciada en claude.ai en ese navegador.

## Instalar (carga sin empaquetar)

1. Abre `chrome://extensions` (o `edge://extensions`).
2. Activa **Modo desarrollador** (arriba a la derecha).
3. **Cargar descomprimida** → selecciona esta carpeta `extension/`.
4. Fija el icono en la barra. Abre/recarga una pestaña de claude.ai con tu sesión iniciada.

## Notas

- El modelo de ventanas (qué bloquea vs. qué solo avisa) es el mismo criterio que el motor CLI de Guardian: **account-wide = principal; con scope de modelo/superficie = informativo** (`extension/lib/usage.js` refleja `lib/usage-api.js`).
- La app de escritorio de Claude (Electron) no admite extensiones de navegador estándar; esta extensión es para el navegador. El consumo mostrado es el de tu cuenta, así que refleja también lo que gastas desde el escritorio o Claude Code.
