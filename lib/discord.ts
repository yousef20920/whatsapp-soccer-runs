import { createPublicKey, verify } from "node:crypto";

const API = "https://discord.com/api/v10";

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4 } as const;
export const ResponseType = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, AUTOCOMPLETE_RESULT: 8 } as const;
export const EPHEMERAL = 1 << 6;

const PERMISSION = { ADMINISTRATOR: 1n << 3n, MANAGE_MESSAGES: 1n << 13n };

export interface Interaction {
  type: number;
  id: string;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string; username: string; global_name?: string | null }; permissions: string; nick?: string | null };
  data?: {
    name?: string;
    custom_id?: string;
    options?: { name: string; type: number; value: string | number | boolean; focused?: boolean }[];
  };
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
  const m = interaction.member;
  return m?.nick ?? m?.user.global_name ?? m?.user.username ?? "unknown";
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

/** Removes the private "SORY is thinking…" reply once the real answer is posted elsewhere. */
export function deleteReply(interaction: Interaction) {
  return discord("DELETE", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, undefined, false);
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
