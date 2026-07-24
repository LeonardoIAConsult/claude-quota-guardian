# Identidad de marca — Claude Quota Guardian

## Esencia

Guardián silencioso: protege el trabajo sin estorbar. La marca comunica **protección** (escudo), **terminal** (chevron de prompt) y **cuota vigilada** (arco celeste llenándose). Tono: técnico, directo, confiable — nunca alarmista.

## Logo

- `logo.svg` — fuente vectorial canónica (256×256). Editar SIEMPRE el SVG; los PNG se regeneran.
- `logo.png` — raster 512×512, fondo transparente. Para avatares, org profile, favicons.
- Área de respeto: 1/8 del ancho del escudo a cada lado. No rotar, no cambiar colores, no agregar sombras.

## Paleta

| Rol | Color | Hex |
|---|---|---|
| Fondo primario (slate profundo) | azul noche | `#0f172a` |
| Fondo secundario | slate | `#1e293b` |
| Acento principal (guardián) | ámbar | `#f59e0b` |
| Acento claro | ámbar claro | `#fbbf24` |
| Señal de cuota / info | celeste | `#38bdf8` |
| Texto sobre oscuro | casi blanco | `#f8fafc` |
| Texto secundario | gris azulado | `#94a3b8` |

## Tipografía

Sistema: `Segoe UI, Helvetica, Arial, sans-serif`. Wordmark en bold 700; taglines en regular. Sin serifas, sin fuentes decorativas.

## Banner

- `banner.svg` — fuente editable 1280×640 (wordmark + tagline ES + mini-flujo detecta→guarda→retoma).
- `banner.png` — raster para el **social preview de GitHub**: Settings → General → Social preview → Upload image.

## Regenerar PNGs (sin dependencias, Chromium headless)

```bash
chrome-headless-shell --headless --window-size=1280,640 --screenshot=assets/banner.png file:///.../assets/banner.svg
chrome-headless-shell --headless --window-size=256,256 --force-device-scale-factor=2 --default-background-color=00000000 --screenshot=assets/logo.png file:///.../assets/logo.svg
```

## Tagline

- ES: **Tu red de seguridad para sesiones largas de IA.**
- EN: **Your safety net for long AI sessions.**
