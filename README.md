# Bridge Cursor / Grok ↔ Matrix

Cursor puede enlazar agentes con **Slack de forma nativa**. **No hay integración
oficial con Matrix.** Este proyecto implementa el camino soportado:
un **canal custom del [Agent SDK](https://cursor.com/docs/bdk)** que habla la
Client-Server API de tu homeserver (Synapse u otro) autoalojado.

## Qué obtienes

- Bot de Matrix que despierta con **mención**, **DM** o prefijo `!cursor`
- Sesiones Agent SDK por sala (`continuationToken = matrix:<roomId>`)
- Respuestas publicadas como `m.notice` (evita bucles entre bots)
- Entrada alternativa por **webhook** para Application Services / relays
- Mock local + consola web para probar sin Synapse

## Arquitectura

```
Element / cliente Matrix
        │  Client-Server API (/sync, /send)
        ▼
┌───────────────────────────┐
│  bot/channels/matrix.ts   │  onStart → /sync  ó  POST /inbound
│  Agent SDK (Grok)         │  message.completed → m.notice
└───────────────────────────┘
```

| Opción | ¿Sirve? | Notas |
| --- | --- | --- |
| Botón «Connect Slack» de Cursor | No para Matrix | Solo Slack |
| Este bridge (Agent SDK + canal Matrix) | **Sí** | Recomendado |
| Puente Matrix↔Slack + Slack de Cursor | Frágil | Doble hop, pérdida de hilos/metadata |
| MCP Matrix en el IDE | Parcial | El agente *puede* leer/escribir Matrix; tu equipo no lo invoca como canal de chat |

**E2EE:** este cliente no descifra Megolm. Usa salas **sin cifrado** para el bot,
o amplía el bridge con un SDK con crypto (`matrix-bot-sdk` + vodozemac).

**Hosting:** si el agente corre en Cursor Hosting y tu Synapse es privado, el
`/sync` desde la nube no alcanzará el homeserver. Entonces:
1. ejecuta `agent-sdk serve` en una máquina con acceso a Matrix, **o**
2. monta un relay/appservice en tu red que haga `POST /v1/channels/matrix/inbound`.

## Requisitos

- Node.js **22.13+**
- Cuenta de bot en tu homeserver + access token
- Credencial Cursor (`agent-sdk login` o `CURSOR_API_KEY`) para turnos de modelo

## Arranque rápido (mock local)

```bash
cp .env.example .env.local
# En .env.local:
# MATRIX_HOMESERVER_URL=http://127.0.0.1:18765
# MATRIX_ACCESS_TOKEN=syt_mock_bot_token
# MATRIX_USER_ID=@cursorbot:localhost
# MATRIX_WEBHOOK_SECRET=dev-secret

npm install
npm run mock:matrix          # consola http://127.0.0.1:18765/
npm run dev -- --port 43123  # playground del agente
```

1. Abre la [consola mock](http://127.0.0.1:18765/).
2. Abre el [playground del agente](http://127.0.0.1:43123/playground).
3. En la consola escribe `@cursorbot hola` o `!cursor resume el estado`.
4. El canal hace sync, lanza un turno y responde con `m.notice`.

Sin API key de Cursor el serve arranca y el canal hace sync, pero el turno de
modelo falla hasta que inicies sesión (`npx @grok/agent-sdk login`).

## Conectar tu Synapse (producción)

1. Crea un usuario bot, p. ej. `@cursorbot:tudominio`.
2. Obtén un access token (Element → Settings → Help → Access Token, o
   `POST /_matrix/client/v3/login`).
3. Invita el bot a las salas de equipo (auto-join de invitaciones activado).
4. Configura variables:

```bash
MATRIX_HOMESERVER_URL=https://matrix.tudominio
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_USER_ID=@cursorbot:tudominio
MATRIX_WEBHOOK_SECRET=un-secreto-largo
MATRIX_ROOM_ALLOWLIST=!sala1:tudominio,!sala2:tudominio   # opcional
```

5. Arranca el agente cerca de Matrix:

```bash
npx @grok/agent-sdk serve --dir . --mode single --port 43123
```

6. (Opcional) Despliega en Cursor Hosting y usa un relay hacia
   `POST /v1/channels/matrix/inbound` con cabecera
   `x-matrix-webhook-secret: $MATRIX_WEBHOOK_SECRET` y
   `X-BDK-Session-Key: matrix:<roomId>` para mantener la misma sesión.

### Payload del webhook

```json
{
  "roomId": "!abc:example.com",
  "eventId": "$eventId",
  "sender": "@alice:example.com",
  "body": "texto ya limpio para el modelo",
  "wakeReason": "mention"
}
```

## Comandos útiles

```bash
npm run check                 # tsc
npm run test:wake             # reglas de wake
npx @grok/agent-sdk validate --dir .
npx @grok/agent-sdk info --dir . --json
npx @grok/agent-sdk tool call matrix_status --dir . --input '{}'
```

## Mapa del código

| Ruta | Rol |
| --- | --- |
| `bot/channels/matrix.ts` | Canal Agent SDK: sync, webhook, replies |
| `bot/lib/matrix-client.ts` | Cliente CS API mínimo |
| `bot/lib/matrix-config.ts` | Env / allowlist / prefijos |
| `bot/lib/matrix-wake.ts` | Reglas mention / DM / prefijo |
| `bot/tools/matrix_status.ts` | Diagnóstico desde el modelo |
| `scripts/mock-matrix-server.mjs` | Homeserver + UI de prueba |

## Limitaciones conocidas

- Sin E2EE / sin verificación de dispositivos
- Sin hilos Matrix ricos (usa una sesión por sala; ampliable con `threadRootEventId`)
- El botón Slack de «Getting Started» en Cursor IDE no se puede reutilizar para Matrix
