import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { MatrixClient } from "../lib/matrix-client.js";
import { loadMatrixConfig } from "../lib/matrix-config.js";

export default defineTool({
  description:
    "Check Matrix bridge connectivity: whoami, joined room count, and homeserver URL.",
  effect: "read",
  inputSchema: z.object({}),
  async execute() {
    const config = loadMatrixConfig();
    if (!config) {
      return {
        ok: false,
        error:
          "Matrix is not configured. Set MATRIX_HOMESERVER_URL and MATRIX_ACCESS_TOKEN.",
      };
    }

    const client = new MatrixClient({
      homeserverUrl: config.homeserverUrl,
      accessToken: config.accessToken,
      userId: config.userId,
    });

    try {
      const me = await client.whoami();
      const rooms = await client.joinedRooms();
      return {
        ok: true,
        homeserverUrl: config.homeserverUrl,
        userId: me.user_id,
        deviceId: me.device_id ?? null,
        joinedRoomCount: rooms.length,
        wakeOnMention: config.wakeOnMention,
        wakeOnDm: config.wakeOnDm,
        wakeOnPrefix: config.wakeOnPrefix,
        commandPrefix: config.commandPrefix,
        roomAllowlist: config.roomAllowlist,
      };
    } catch (error) {
      return {
        ok: false,
        homeserverUrl: config.homeserverUrl,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
