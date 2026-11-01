/**
 * Self-test for Matrix wake rules (no homeserver required).
 */
import assert from "node:assert/strict";

function localpart(userId) {
  return /^@([^:]+):/.exec(userId)?.[1] ?? userId;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldWakeOnEvent({ event, botUserId, config, joinedMemberCount, roomId }) {
  if (event.type !== "m.room.message") return { wake: false, reason: "not_message" };
  if (event.sender === botUserId) return { wake: false, reason: "self" };
  const msgtype = event.content?.msgtype;
  if (msgtype === "m.notice") return { wake: false, reason: "notice" };
  if (
    config.roomAllowlist.length > 0 &&
    !config.roomAllowlist.includes(roomId)
  ) {
    return { wake: false, reason: "room_not_allowlisted" };
  }
  const body = typeof event.content?.body === "string" ? event.content.body : "";
  if (!body.trim()) return { wake: false, reason: "empty_body" };

  if (config.wakeOnDm && joinedMemberCount === 2) {
    return { wake: true, reason: "dm", prompt: body.trim() };
  }

  const mentions = event.content?.["m.mentions"]?.user_ids ?? [];
  const bodyMentionsBot =
    body.includes(botUserId) ||
    new RegExp(`(^|\\s)@?${escapeRegExp(localpart(botUserId))}([:\\s]|$)`, "i").test(body);
  if (config.wakeOnMention && (mentions.includes(botUserId) || bodyMentionsBot)) {
    return { wake: true, reason: "mention", prompt: body.trim() };
  }

  if (config.wakeOnPrefix) {
    const prefix = config.commandPrefix;
    if (body.trimStart().toLowerCase().startsWith(prefix.toLowerCase())) {
      const prompt = body.trimStart().slice(prefix.length).trim();
      if (prompt) return { wake: true, reason: "prefix", prompt };
    }
  }
  return { wake: false, reason: "no_trigger" };
}

const bot = "@cursorbot:localhost";
const base = {
  wakeOnMention: true,
  wakeOnDm: true,
  wakeOnPrefix: true,
  commandPrefix: "!cursor",
  roomAllowlist: [],
};

assert.equal(
  shouldWakeOnEvent({
    event: {
      type: "m.room.message",
      sender: "@alice:localhost",
      content: { msgtype: "m.text", body: "@cursorbot resume el deploy" },
    },
    botUserId: bot,
    config: base,
    roomId: "!r:localhost",
  }).reason,
  "mention",
);

assert.equal(
  shouldWakeOnEvent({
    event: {
      type: "m.room.message",
      sender: "@alice:localhost",
      content: { msgtype: "m.text", body: "!cursor qué hora es" },
    },
    botUserId: bot,
    config: base,
    roomId: "!r:localhost",
  }).prompt,
  "qué hora es",
);

assert.equal(
  shouldWakeOnEvent({
    event: {
      type: "m.room.message",
      sender: bot,
      content: { msgtype: "m.notice", body: "hola" },
    },
    botUserId: bot,
    config: base,
    roomId: "!r:localhost",
  }).wake,
  false,
);

assert.equal(
  shouldWakeOnEvent({
    event: {
      type: "m.room.message",
      sender: "@alice:localhost",
      content: { msgtype: "m.text", body: "ping" },
    },
    botUserId: bot,
    config: base,
    joinedMemberCount: 2,
    roomId: "!dm:localhost",
  }).reason,
  "dm",
);

console.log("wake-selftest: ok");
