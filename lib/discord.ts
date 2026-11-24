import { createPublicKey, verify } from "node:crypto";

const API = "https://discord.com/api/v10";

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4 } as const;
export const ResponseType = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE_MESSAGE: 7, AUTOCOMPLETE_RESULT: 8 } as const;
export const EPHEMERAL = 1 << 6;

const PERMISSION = { ADMINISTRATOR: 1n << 3n, MANAGE_MESSAGES: 1n << 13n };

export interface Interaction {
  type: number;
  id: string;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser; permissions: string; nick?: string | null; roles?: string[] };
  user?: DiscordUser; // set instead of member in DMs
  data?: {
    name?: string;
    custom_id?: string;
    options?: { name: string; type: number; value: string | number | boolean; focused?: boolean }[];
  };
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

let publicKey: ReturnType<typeof createPublicKey> | undefined;

/** Checks Discord's Ed25519 signature on an incoming interaction request. */
export function isValidSignature(body: string, signature: string | null, timestamp: string | null): boolean {
  if (!signature || !timestamp) return false;
  publicKey ??= createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(env("DISCORD_PUBLIC_KEY"), "hex").toString("base64url") },
    format: "jwk",
  });
  try {
    return verify(null, Buffer.from(timestamp + body), publicKey, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/** Organizers (Organizer role) and admins can run organizer commands. */
export function isOrganizer(interaction: Interaction): boolean {
  const perms = BigInt(interaction.member?.permissions ?? "0");
  return (perms & PERMISSION.ADMINISTRATOR) !== 0n || (perms & PERMISSION.MANAGE_MESSAGES) !== 0n;
}

export function option<T extends string | number | boolean>(interaction: Interaction, name: string): T | undefined {
  return interaction.data?.options?.find((o) => o.name === name)?.value as T | undefined;
}

export function displayName(interaction: Interaction): string {
  const user = interaction.member?.user ?? interaction.user;
  return interaction.member?.nick ?? user?.global_name ?? user?.username ?? "unknown";
}

/** Who pressed the button, in a server or in a DM. */
export function playerOf(interaction: Interaction): { id: string; name: string } {
  return { id: (interaction.member?.user ?? interaction.user)!.id, name: displayName(interaction) };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Calls the Discord REST API as the bot. */
export async function discord<T = unknown>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bot ${env("DISCORD_BOT_TOKEN")}` } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord ${method} ${path} failed (${res.status}): ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/** Replaces the "SORY is thinking…" placeholder of a deferred reply. */
export function editReply(interaction: Interaction, body: unknown) {
  return discord("PATCH", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, body, false);
}

/** A private extra message after the first reply (e.g. after a button quietly updated a public card). */
export function followUpPrivately(interaction: Interaction, content: string, components?: unknown[]) {
  return discord(
    "POST",
    `/webhooks/${interaction.application_id}/${interaction.token}`,
    { content, components, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
    false,
  );
}

/** DMs a user. Returns false if they can't be DMed (DMs from server members turned off). */
export async function sendDirectMessage(userId: string, body: { content: string; components?: unknown[] }): Promise<boolean> {
  try {
    const dm = await discord<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
    await discord("POST", `/channels/${dm.id}/messages`, { ...body, allowed_mentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

/** Removes the private "SORY is thinking…" reply once the real answer is posted elsewhere. */
export function deleteReply(interaction: Interaction) {
  return discord("DELETE", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, undefined, false);
}

/** Where SORY's commands run and polls go. #games only holds the current game card. */
export const commandsChannelId = () => process.env.COMMANDS_CHANNEL_ID || env("GAMES_CHANNEL_ID");

/**
 * Keeps #plan-a-run commands-only. The channel already blocks typing, but Discord lets admins and the
 * server owner past any channel lock, so the once-a-minute sweep deletes anything not posted by SORY.
 * Returns how many messages were removed.
 */
export async function clearTypedMessages(): Promise<number> {
  const channelId = process.env.COMMANDS_CHANNEL_ID;
  if (!channelId) return 0; // without its own channel, commands share #games: leave it alone
  const recent = await discord<{ id: string; author: { bot?: boolean } }[]>("GET", `/channels/${channelId}/messages?limit=50`);
  let removed = 0;
  for (const message of recent.filter((m) => !m.author.bot)) {
    await discord("DELETE", `/channels/${channelId}/messages/${message.id}`)
      .then(() => removed++)
      .catch((err) => console.error(`Couldn't delete message ${message.id}`, err));
  }
  return removed;
}

/** Posts one line to #bot-logs. Never throws: logging must not break what it records. */
export async function botLog(text: string): Promise<void> {
  const channelId = process.env.BOT_LOGS_CHANNEL_ID;
  if (!channelId) return;
  await discord("POST", `/channels/${channelId}/messages`, { content: text.slice(0, 2000), allowed_mentions: { parse: [] } }).catch((err) =>
    console.error("Couldn't write to #bot-logs", err),
  );
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
