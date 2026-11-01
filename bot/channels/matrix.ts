/**
 * Matrix channel for Cursor Agent SDK.
 *
 * Two ingress paths:
 * 1. Long-poll /sync in onStart (best when this process can reach your homeserver)
 * 2. POST /inbound webhook (appservice / relay when the agent is hosted elsewhere)
 *
 * Replies are delivered as m.notice via message.completed.
 */

import {
  defineChannel,
  POST,
  localDevStrict,
  sharedSecretAuth,
} from "@grok/agent-sdk/channels";
import * as z from "zod/v4";
import {
  MatrixClient,
  plainTextToMatrixHtml,
  type MatrixRoomEvent,
} from "../lib/matrix-client.js";
import { loadMatrixConfig, type MatrixConfig } from "../lib/matrix-config.js";
import {
  continuationTokenForRoom,
  shouldWakeOnEvent,
} from "../lib/matrix-wake.js";

type MatrixSessionState = {
  roomId: string;
  eventId: string;
  sender: string;
  wakeReason: string;
};

type InboundBody = {
  roomId: string;
  eventId: string;
  sender: string;
  body: string;
  wakeReason?: string;
  memberCount?: number;
};

const SYNC_TOKEN_KEY = "matrix:sync_token";
const BOOTSTRAPPED_KEY = "matrix:sync_bootstrapped";

let runtimeClient: MatrixClient | null = null;
let runtimeConfig: MatrixConfig | null = null;
let stopSync = false;
const memberCountByRoom = new Map<string, number>();

function getClient(): MatrixClient | null {
  if (runtimeClient) return runtimeClient;
  const config = loadMatrixConfig();
  if (!config) return null;
  runtimeConfig = config;
  runtimeClient = new MatrixClient({
    homeserverUrl: config.homeserverUrl,
    accessToken: config.accessToken,
    userId: config.userId,
  });
  return runtimeClient;
}

async function deliverReply(
  state: MatrixSessionState,
  text: string,
): Promise<void> {
  const client = getClient();
  if (!client || !state.roomId || !text.trim()) return;
  await client.sendNotice(state.roomId, text, {
    replyToEventId: state.eventId || undefined,
    html: plainTextToMatrixHtml(text),
  });
}

async function handleRoomEvent(
  roomId: string,
  event: MatrixRoomEvent,
  send: (message: string, options?: Record<string, unknown>) => Promise<unknown>,
  logger: (line: string) => void,
  skipHistorical: boolean,
): Promise<void> {
  const client = getClient();
  const config = runtimeConfig ?? loadMatrixConfig();
  if (!client || !config) return;

  if (event.type === "m.room.member") {
    // Keep a coarse member count when state lands in the timeline.
    return;
  }

  if (skipHistorical) {
    return;
  }

  const botUserId = await client.getUserId();
  const decision = shouldWakeOnEvent({
    event,
    botUserId,
    config,
    joinedMemberCount: memberCountByRoom.get(roomId),
    roomId,
  });

  if (!decision.wake) {
    if (decision.reason !== "no_trigger" && decision.reason !== "notice") {
      logger(`[matrix] skip ${roomId} ${event.event_id}: ${decision.reason}`);
    }
    return;
  }

  const token = continuationTokenForRoom(roomId);
  logger(
    `[matrix] wake reason=${decision.reason} room=${roomId} event=${event.event_id}`,
  );

  try {
    await client.setTyping(roomId, true);
  } catch {
    // Typing is best-effort.
  }

  await send(
    [
      `Mensaje de Matrix (${decision.reason}) en la sala ${roomId}.`,
      `Remitente: ${event.sender}`,
      "",
      decision.prompt,
    ].join("\n"),
    {
      continuationToken: token,
      admission: "coalesce",
      title: `Matrix ${roomId}`,
      state: {
        roomId,
        eventId: event.event_id,
        sender: event.sender,
        wakeReason: decision.reason,
      } satisfies MatrixSessionState,
    },
  );
}

async function processSyncPayload(
  payload: Awaited<ReturnType<MatrixClient["sync"]>>,
  send: (message: string, options?: Record<string, unknown>) => Promise<unknown>,
  logger: (line: string) => void,
  skipHistorical: boolean,
): Promise<void> {
  const joined = payload.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(joined)) {
    const summaryCount = room.summary?.["m.joined_member_count"];
    if (typeof summaryCount === "number") {
      memberCountByRoom.set(roomId, summaryCount);
    }

    for (const event of room.timeline?.events ?? []) {
      await handleRoomEvent(roomId, event, send, logger, skipHistorical);
    }
  }

  const invites = Object.keys(payload.rooms?.invite ?? {});
  const client = getClient();
  if (client && invites.length > 0) {
    for (const roomId of invites) {
      try {
        await client.joinRoom(roomId);
        logger(`[matrix] auto-joined ${roomId}`);
      } catch (error) {
        logger(
          `[matrix] failed to join ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

async function runSyncLoop(
  send: (message: string, options?: Record<string, unknown>) => Promise<unknown>,
  host: { kv: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } },
  logger: (line: string) => void,
): Promise<void> {
  const client = getClient();
  const config = runtimeConfig ?? loadMatrixConfig();
  if (!client || !config) {
    logger(
      "[matrix] MATRIX_HOMESERVER_URL / MATRIX_ACCESS_TOKEN not set — sync idle; webhook /inbound still works once credentials exist for replies.",
    );
    return;
  }

  const me = await client.whoami();
  logger(`[matrix] sync connected as ${me.user_id} @ ${config.homeserverUrl}`);

  let since =
    (typeof (await host.kv.get(SYNC_TOKEN_KEY)) === "string"
      ? ((await host.kv.get(SYNC_TOKEN_KEY)) as string)
      : null) ?? null;
  let bootstrapped = (await host.kv.get(BOOTSTRAPPED_KEY)) === true;

  // First ever sync: consume history without answering old messages.
  if (!bootstrapped) {
    logger("[matrix] initial sync — skipping historical wake-ups");
    const initial = await client.sync({
      since: null,
      timeoutMs: 0,
      fullState: false,
    });
    await processSyncPayload(initial, send, logger, true);
    since = initial.next_batch;
    await host.kv.put(SYNC_TOKEN_KEY, since);
    await host.kv.put(BOOTSTRAPPED_KEY, true);
    bootstrapped = true;
  }

  while (!stopSync) {
    try {
      const payload = await client.sync({
        since,
        timeoutMs: config.syncTimeoutMs,
      });
      await processSyncPayload(payload, send, logger, false);
      since = payload.next_batch;
      await host.kv.put(SYNC_TOKEN_KEY, since);
    } catch (error) {
      logger(
        `[matrix] sync error: ${error instanceof Error ? error.message : String(error)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

const inboundSchema = z.object({
  roomId: z.string().min(1),
  eventId: z.string().min(1),
  sender: z.string().min(1),
  body: z.string().min(1),
  wakeReason: z.string().optional(),
  memberCount: z.number().int().positive().optional(),
});

export default defineChannel<MatrixSessionState>({
  meta: { kind: "matrix" },
  state: { roomId: "", eventId: "", sender: "", wakeReason: "" },
  auth: [
    localDevStrict(),
    sharedSecretAuth({
      header: "x-matrix-webhook-secret",
      secret: "MATRIX_WEBHOOK_SECRET",
    }),
  ],
  routes: [
    POST("/inbound", {
      description:
        "Forward a Matrix room message into an agent turn (appservice / relay).",
      bodySchema: inboundSchema,
      handler: async (_request, { send, waitUntil, body }) => {
        const payload = body as InboundBody;
        const token = continuationTokenForRoom(payload.roomId);
        waitUntil(
          send(
            [
              `Mensaje de Matrix (${payload.wakeReason ?? "webhook"}) en la sala ${payload.roomId}.`,
              `Remitente: ${payload.sender}`,
              "",
              payload.body,
            ].join("\n"),
            {
              continuationToken: token,
              admission: "coalesce",
              title: `Matrix ${payload.roomId}`,
              state: {
                roomId: payload.roomId,
                eventId: payload.eventId,
                sender: payload.sender,
                wakeReason: payload.wakeReason ?? "webhook",
              } satisfies MatrixSessionState,
            },
          ),
        );
        return new Response(null, { status: 202 });
      },
    }),
    POST("/health", {
      description: "Report whether Matrix credentials are loaded.",
      bodySchema: z.object({}),
      handler: async () => {
        const config = loadMatrixConfig();
        return Response.json({
          configured: Boolean(config),
          homeserverUrl: config?.homeserverUrl ?? null,
          syncRunning: Boolean(runtimeClient) && !stopSync,
        });
      },
    }),
  ],
  events: {
    async "message.completed"(event, channel) {
      if (event.data.finishReason === "tool_call" || event.data.text === "") {
        return;
      }
      await deliverReply(channel.state, event.data.text);
      const client = getClient();
      if (client && channel.state.roomId) {
        try {
          await client.setTyping(channel.state.roomId, false);
        } catch {
          // ignore
        }
      }
    },
  },
  async onStart({ send, host, logger, waitUntil }) {
    stopSync = false;
    runtimeClient = null;
    runtimeConfig = loadMatrixConfig();
    if (!runtimeConfig) {
      logger(
        "[matrix] channel mounted without MATRIX_* credentials (webhook-only until configured)",
      );
      return;
    }
    runtimeClient = new MatrixClient({
      homeserverUrl: runtimeConfig.homeserverUrl,
      accessToken: runtimeConfig.accessToken,
      userId: runtimeConfig.userId,
    });
    waitUntil(
      runSyncLoop(
        send as (message: string, options?: Record<string, unknown>) => Promise<unknown>,
        host,
        logger,
      ),
    );
  },
  async onStop() {
    stopSync = true;
    runtimeClient = null;
  },
});
