import type { MatrixRoomEvent } from "./matrix-client.js";
import type { MatrixConfig } from "./matrix-config.js";

export type WakeDecision =
  | { wake: false; reason: string }
  | {
      wake: true;
      reason: "mention" | "dm" | "prefix";
      prompt: string;
    };

function localpart(userId: string): string {
  const match = /^@([^:]+):/.exec(userId);
  return match?.[1] ?? userId;
}

function extractBody(event: MatrixRoomEvent): string {
  const content = event.content ?? {};
  if (typeof content.body === "string") return content.body;
  return "";
}

function mentionedUserIds(event: MatrixRoomEvent): string[] {
  const mentions = event.content?.["m.mentions"] as
    | { user_ids?: unknown }
    | undefined;
  if (!mentions || !Array.isArray(mentions.user_ids)) return [];
  return mentions.user_ids.filter((id): id is string => typeof id === "string");
}

function stripMentionPrefixes(body: string, botUserId: string): string {
  const lp = localpart(botUserId);
  return body
    .replace(new RegExp(`^\\s*${escapeRegExp(botUserId)}[:,]?\\s*`, "i"), "")
    .replace(new RegExp(`^\\s*@?${escapeRegExp(lp)}[:,]?\\s*`, "i"), "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isDirectMessageRoom(memberCount: number | undefined): boolean {
  // Matrix DMs are typically 2 joined members. Unknown → treat as non-DM.
  return memberCount === 2;
}

export function shouldWakeOnEvent(options: {
  event: MatrixRoomEvent;
  botUserId: string;
  config: MatrixConfig;
  joinedMemberCount?: number;
  roomId: string;
}): WakeDecision {
  const { event, botUserId, config, joinedMemberCount, roomId } = options;

  if (event.type !== "m.room.message") {
    return { wake: false, reason: "not_message" };
  }
  if (event.sender === botUserId) {
    return { wake: false, reason: "self" };
  }

  const msgtype = event.content?.msgtype;
  if (msgtype === "m.notice") {
    // Spec: notices must never be auto-answered (avoids bot loops).
    return { wake: false, reason: "notice" };
  }
  if (msgtype !== "m.text" && msgtype !== "m.emote" && msgtype !== undefined) {
    return { wake: false, reason: "unsupported_msgtype" };
  }

  if (
    config.roomAllowlist.length > 0 &&
    !config.roomAllowlist.includes(roomId)
  ) {
    return { wake: false, reason: "room_not_allowlisted" };
  }

  const body = extractBody(event);
  if (!body.trim()) {
    return { wake: false, reason: "empty_body" };
  }

  if (config.wakeOnDm && isDirectMessageRoom(joinedMemberCount)) {
    return { wake: true, reason: "dm", prompt: body.trim() };
  }

  const mentions = mentionedUserIds(event);
  const bodyMentionsBot =
    body.includes(botUserId) ||
    new RegExp(`(^|\\s)@?${escapeRegExp(localpart(botUserId))}([:\\s]|$)`, "i").test(
      body,
    );

  if (
    config.wakeOnMention &&
    (mentions.includes(botUserId) || bodyMentionsBot)
  ) {
    const prompt = stripMentionPrefixes(body, botUserId) || body.trim();
    return { wake: true, reason: "mention", prompt };
  }

  if (config.wakeOnPrefix) {
    const prefix = config.commandPrefix;
    if (body.trimStart().toLowerCase().startsWith(prefix.toLowerCase())) {
      const prompt = body.trimStart().slice(prefix.length).trim();
      if (prompt) {
        return { wake: true, reason: "prefix", prompt };
      }
    }
  }

  return { wake: false, reason: "no_trigger" };
}

export function continuationTokenForRoom(
  roomId: string,
  threadRootEventId?: string,
): string {
  if (threadRootEventId) {
    return `matrix:${roomId}:thread:${threadRootEventId}`;
  }
  return `matrix:${roomId}`;
}
