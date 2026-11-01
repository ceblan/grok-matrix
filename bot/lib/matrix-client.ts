/**
 * Minimal Matrix Client-Server API client (no E2EE).
 * Suitable for bots in unencrypted rooms on a self-hosted homeserver.
 */

export type MatrixMessageContent = {
  msgtype: "m.text" | "m.notice" | "m.emote";
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
  "m.mentions"?: { user_ids?: string[]; room?: boolean };
  "m.relates_to"?: {
    "m.in_reply_to"?: { event_id: string };
  };
};

export type MatrixRoomEvent = {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
};

export type MatrixSyncResult = {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: { events?: MatrixRoomEvent[] };
        state?: { events?: MatrixRoomEvent[] };
        unread_notifications?: { notification_count?: number };
        summary?: {
          "m.heroes"?: string[];
          "m.joined_member_count"?: number;
          "m.invited_member_count"?: number;
        };
      }
    >;
    invite?: Record<string, unknown>;
  };
};

export class MatrixApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "MatrixApiError";
  }
}

export type MatrixClientOptions = {
  homeserverUrl: string;
  accessToken: string;
  userId?: string | null;
  fetchImpl?: typeof fetch;
};

export class MatrixClient {
  readonly homeserverUrl: string;
  readonly accessToken: string;
  private cachedUserId: string | null;
  private readonly fetchImpl: typeof fetch;
  private txnCounter = 0;

  constructor(options: MatrixClientOptions) {
    this.homeserverUrl = options.homeserverUrl.replace(/\/$/, "");
    this.accessToken = options.accessToken;
    this.cachedUserId = options.userId ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      auth?: boolean;
    } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.homeserverUrl}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (options.auth !== false) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(url, { method, headers, body });
    const text = await response.text();
    if (!response.ok) {
      throw new MatrixApiError(
        `Matrix ${method} ${path} failed (${response.status})`,
        response.status,
        text,
      );
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }

  async whoami(): Promise<{ user_id: string; device_id?: string }> {
    const result = (await this.request(
      "GET",
      "/_matrix/client/v3/account/whoami",
    )) as { user_id: string; device_id?: string };
    this.cachedUserId = result.user_id;
    return result;
  }

  async getUserId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    const me = await this.whoami();
    return me.user_id;
  }

  async sync(options: {
    since?: string | null;
    timeoutMs?: number;
    fullState?: boolean;
  }): Promise<MatrixSyncResult> {
    return (await this.request("GET", "/_matrix/client/v3/sync", {
      query: {
        timeout: options.timeoutMs ?? 30000,
        since: options.since || undefined,
        full_state: options.fullState ? "true" : undefined,
      },
    })) as MatrixSyncResult;
  }

  async sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<{ event_id: string }> {
    this.txnCounter += 1;
    const txnId = `m${Date.now()}.${this.txnCounter}.${Math.random().toString(36).slice(2, 8)}`;
    const encodedRoom = encodeURIComponent(roomId);
    const encodedType = encodeURIComponent(eventType);
    return (await this.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodedRoom}/send/${encodedType}/${txnId}`,
      { body: content },
    )) as { event_id: string };
  }

  async sendNotice(
    roomId: string,
    body: string,
    options: { replyToEventId?: string; html?: string } = {},
  ): Promise<{ event_id: string }> {
    const content: MatrixMessageContent = {
      msgtype: "m.notice",
      body,
    };
    if (options.html) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = options.html;
    }
    if (options.replyToEventId) {
      content["m.relates_to"] = {
        "m.in_reply_to": { event_id: options.replyToEventId },
      };
    }
    return this.sendEvent(roomId, "m.room.message", content);
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs = 20000): Promise<void> {
    const userId = encodeURIComponent(await this.getUserId());
    const encodedRoom = encodeURIComponent(roomId);
    await this.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodedRoom}/typing/${userId}`,
      { body: { typing, timeout: timeoutMs } },
    );
  }

  async joinRoom(roomIdOrAlias: string): Promise<{ room_id: string }> {
    const encoded = encodeURIComponent(roomIdOrAlias);
    return (await this.request("POST", `/_matrix/client/v3/join/${encoded}`, {
      body: {},
    })) as { room_id: string };
  }

  async joinedRooms(): Promise<string[]> {
    const result = (await this.request(
      "GET",
      "/_matrix/client/v3/joined_rooms",
    )) as { joined_rooms?: string[] };
    return result.joined_rooms ?? [];
  }
}

/** Rough HTML for Matrix formatted_body from plain / markdown-ish text. */
export function plainTextToMatrixHtml(text: string): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return escaped.replaceAll("\n", "<br/>");
}
