# PocketClaude

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md)

Una PWA autoalojada para **controlar y monitorizar a distancia las sesiones de Claude Code que corren en tu ordenador**, desde el móvil o cualquier navegador. Usa tu CLI `claude` local ya autenticado (funciona con tu suscripción Max/Pro — **sin coste de API adicional**), accesible desde cualquier lugar mediante un túnel de Cloudflare.

- Mira todas las conversaciones de Claude Code actualizarse en vivo
- Envía prompts para continuar cualquier sesión reciente — o iniciar una nueva
- **Aprobación por herramienta**: antes de que Claude ejecute cualquier herramienta, recibe una notificación push y toca permitir/denegar
- **Streaming token a token + seguimientos a mitad de tarea**: las respuestas aparecen mientras Claude escribe; enviar a una sesión activa la alimenta al proceso en vivo (se ejecuta en el siguiente turno, sin arranque en frío); las sesiones corren en paralelo
- Inicio de sesión con clave (generada automáticamente en el primer arranque)
- Renderizado Markdown limpio (sanitizado con DOMPurify), resaltado de sintaxis, **pega/adjunta imágenes para que Claude las vea** (visión)
- Ver imágenes / audio / vídeo / PDFs generados por Claude; previsualizar un dev server en el móvil; **los prototipos HTML estáticos se renderizan directamente en el móvil** (en sandbox, sin necesidad de levantar tu propio servidor) — las vistas previas se abren dentro de la app con un botón de Atrás, así no cubren la PWA sin salida
- **Panel de herramientas**: estadísticas de uso/coste · galería de medios generados · cambio entre varios servidores con un toque
- Las sesiones se pueden **fijar / archivar** — fáciles de encontrar aunque la lista sea larga
- Explorador de archivos integrado + lector de Markdown
- **8 idiomas de interfaz**, temas claro/oscuro, esfuerzo de razonamiento ajustable, entrada por voz
- Instalable como app, notificaciones push al terminar tareas — localizadas por dispositivo
- Funciona sin conexión / tras un firewall (todos los recursos autoalojados)

> ⚠️ **Controla la máquina donde se ejecuta.** Si corre en el ordenador A, solo controla el Claude de A. Lee el `~/.claude` local e invoca el CLI `claude` local.

---

## Requisitos

- **Node.js 18+**
- **Claude Code / Claude Desktop instalado y con sesión iniciada** (suscripción Max o Pro) — si `claude` funciona en tu terminal, listo
- (para acceso remoto) **cloudflared** — sin instalación previa, se ejecuta con `npx`

Funciona en **Windows / macOS / Linux** (la ruta del CLI y los directorios de datos se detectan automáticamente).

## Instalación

```bash
git clone https://github.com/SakuraNeco/PocketClaude.git
cd PocketClaude
npm install
```

## Ejecutar

```bash
npm start
```

Verás:

```
PocketClaude server → http://localhost:3000
login key:   xxxxxxxxxxxxxxxxxxxxxxxx
claude CLI:  /path/to/claude
```

Abre <http://localhost:3000> e introduce la **login key** del registro de arranque (una vez por dispositivo).

> La clave se guarda en `.auth-token` (en gitignore) — bórrala y reinicia para una nueva, o define `CC_AUTH_TOKEN`. Si la línea `claude CLI` es incorrecta, copia `.env.example` a `.env` y apunta `CLAUDE_PATH` a tu `claude`.

## Acceso desde el móvil (túnel de Cloudflare)

```bash
npm run tunnel
```

Imprime una URL `https://xxxx.trycloudflare.com` — ábrela en el móvil e introduce la clave. Para una URL estable, usa un [túnel con nombre](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) de Cloudflare apuntando a `http://localhost:3000`.

> ⚠️ **¿Usas tu propio dominio (túnel con nombre)?** Las reglas WAF gestionadas de Cloudflare devuelven 403 en rutas como `/node_modules/…`, rompiendo las vistas previas `/proxy` de dev servers de Vite. Añade una regla personalizada en el panel de Cloudflare: Hostname igual a tu subdominio → acción **Skip** (marca todas las reglas gestionadas + todas las reglas personalizadas restantes). PocketClaude tiene su propia autenticación por clave y no depende del WAF.

## Instalar como app + push

1. Abre la URL https en el navegador del móvil
2. Añadir a pantalla de inicio
3. Ábrela desde el icono y toca **Activar notificaciones** (el push web de iOS solo funciona tras añadir a pantalla de inicio)

---

## Uso

- Elige la conversación en el selector **Enviar a**, escribe y envía.
- **Modos de permiso**:
  | Modo | Comportamiento |
  |------|-----------|
  | Aprobar cada uno `interactive` | Cada llamada a herramienta llega al móvil; permites/deniegas (auto-denegación a los 120 s) |
  | Auto-editar `acceptEdits` (predeterminado) | Ediciones de archivos aprobadas automáticamente |
  | Auto total `bypassPermissions` | Todo permitido — lo más capaz, lo menos protegido |
  | Modo plan `plan` | Solo planifica, sin cambios |
- **Modelo**: Predet. / Fable 5 / Opus / Sonnet / Haiku · **Esfuerzo**: Predet. / Bajo / Medio / Alto / Muy alto / Máximo
- Arriba a la derecha: **idioma** (8) y **tema**. Junto al campo de texto: **entrada por voz**.
- El botón **Archivos** de la barra lateral explora la carpeta de la sesión; los `.md` se abren en el lector integrado, y `.html` **se renderiza como página web** en el móvil (en sandbox).
- Arriba a la derecha **⊞ Herramientas**: **Uso** (cuánto ha costado cada proyecto — solo cuenta los turnos enviados por PocketClaude), **Galería** (un muro con todas las imágenes/audio/vídeo generados en las sesiones), **Servidores** (guarda varias máquinas PocketClaude y cambia con un toque, llevando la clave).
- Las filas de sesión se pueden **fijar** (arriba) o **archivar** (al fondo + atenuadas); estos ajustes se guardan localmente en el navegador.

### Notas / limitaciones conocidas

- **Sesiones de streaming persistentes**: las respuestas se renderizan token a token; un envío a una sesión ocupada se transmite al proceso en vivo (se ejecuta tras el turno actual, sin arranque en frío), así puedes añadir instrucciones o preguntar sin reiniciar. Las sesiones corren en paralelo; cada proceso termina tras 5 min inactivo.
- **No puedes controlar la propia sesión de PocketClaude** desde la web (reiniciaría y mataría el servidor) — bloqueado automáticamente.
- Los mensajes a una sesión **abierta en Desktop** se escriben en el archivo pero no aparecen en esa ventana hasta reabrirla.
- **Sin reinicio automático**: cerrar la terminal / reiniciar / un crash lo detiene. Usa `pm2`, `launchd` (mac) o el Programador de tareas (win) para mantenerlo vivo.

## Seguridad

- Todo excepto el shell de la PWA requiere la clave (comparación timing-safe; cookie HttpOnly).
- `/media` y `/files` están confinados a tu directorio personal (con comprobación de límites de ruta).
- La aprobación interactiva es **fail-closed**: si el puente no alcanza el servidor, deniega.
- Todo el Markdown se sanitiza con DOMPurify; `/media` sirve los archivos de texto (incl. HTML) como `text/plain`. Para previsualizar un `.html` como página real, `/html` lo renderiza bajo una **CSP `sandbox`** (origen opaco): su propio JS se ejecuta, pero no puede tocar la cookie de autenticación ni alcanzar APIs del mismo origen.
- `/proxy` solo alcanza puertos referenciados por alguna sesión (amplía con `CC_PROXY_ALLOW`).
- `/auth` limita la fuerza bruta; las sesiones bajo el directorio temporal del SO se ocultan.
- `.audit.log` registra intentos de acceso, envíos, paradas y decisiones de permisos.

## Variables de entorno (todas opcionales — ver `.env.example`)

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto del servidor (3000 por defecto) |
| `CLAUDE_PATH` | Ruta del CLI `claude` (autodetectada si no se define) |
| `CC_AUTH_TOKEN` | Clave de acceso (autogenerada en `.auth-token` si no se define) |
| `CC_PROXY_ALLOW` | Puertos extra permitidos para `/proxy` (separados por comas) |
| `VAPID_SUBJECT` | Contacto Web Push `mailto:` |

Las claves VAPID, la clave de acceso, las suscripciones push y las subidas se generan **por instalación** y están en gitignore.

## Desarrollo

```bash
npm test        # node --test — tests unitarios de las funciones puras
node --check server.js
```

La CI ejecuta comprobación de sintaxis + tests en Node 18/20/22.

## Licencia

MIT
