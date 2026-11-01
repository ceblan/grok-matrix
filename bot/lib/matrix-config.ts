/**
 * Matrix bridge configuration from environment variables.
 * Secrets stay in env / deployment secrets — never hardcode them.
 */

export type MatrixConfig = {
  homeserverUrl: string;
  accessToken: string;
  userId: string | null;
  /** Rooms that may wake the agent. Empty = any joined room. */
  roomAllowlist: string[];
  /**
   * Wake modes:
   * - mention: m.mentions includes the bot, or body contains its localpart
   * - dm: 1:1 rooms always wake
   * - prefix: body starts with MATRIX_COMMAND_PREFIX (default "!cursor ")
   */
  wakeOnMention: boolean;
  wakeOnDm: boolean;
  wakeOnPrefix: boolean;
  commandPrefix: string;
  syncTimeoutMs: number;
  /** Optional shared secret for POST /v1/channels/matrix/inbound */
  webhookSecretEnv: string;
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function loadMatrixConfig(
  env: NodeJS.ProcessEnv = process.env,
): MatrixConfig | null {
  const homeserverUrl = env.MATRIX_HOMESERVER_URL?.trim().replace(/\/$/, "");
  const accessToken = env.MATRIX_ACCESS_TOKEN?.trim();
  if (!homeserverUrl || !accessToken) return null;

  return {
    homeserverUrl,
    accessToken,
    userId: env.MATRIX_USER_ID?.trim() || null,
    roomAllowlist: parseList(env.MATRIX_ROOM_ALLOWLIST),
    wakeOnMention: parseBool(env.MATRIX_WAKE_ON_MENTION, true),
    wakeOnDm: parseBool(env.MATRIX_WAKE_ON_DM, true),
    wakeOnPrefix: parseBool(env.MATRIX_WAKE_ON_PREFIX, true),
    commandPrefix: (env.MATRIX_COMMAND_PREFIX ?? "!cursor").trim() || "!cursor",
    syncTimeoutMs: Math.min(
      Math.max(Number(env.MATRIX_SYNC_TIMEOUT_MS ?? 30000) || 30000, 5000),
      60000,
    ),
    webhookSecretEnv: "MATRIX_WEBHOOK_SECRET",
  };
}

export function isMatrixConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return loadMatrixConfig(env) !== null;
}
