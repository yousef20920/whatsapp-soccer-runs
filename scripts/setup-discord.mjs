// Discord server setup for the soccer runs community.
//
// Usage (token is read from .env, never passed on the command line):
//   npm run discord:invite-bot            -> prints the link to add the bot to your server
//   npm run discord:setup                 -> creates roles, channels and a 7-day invite link
//   npm run discord:organizer -- <name>   -> gives the Organizer role to a member
//
// Safe to run more than once: anything that already exists (matched by name) is reused.

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN. Copy .env.example to .env and paste the bot token there.");
  process.exit(1);
}

// Permission bits (https://discord.com/developers/docs/topics/permissions)
const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_ROLES: 1n << 28n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
};
const bits = (...names) => names.reduce((acc, n) => acc | P[n], 0n).toString();

// Everything the bot needs, and nothing more (no Administrator).
const BOT_PERMISSIONS = bits(
  "CREATE_INSTANT_INVITE", "MANAGE_CHANNELS", "VIEW_CHANNEL", "SEND_MESSAGES",
  "MANAGE_MESSAGES", "EMBED_LINKS", "READ_MESSAGE_HISTORY", "MANAGE_ROLES",
);

const CHANNEL = { TEXT: 0, CATEGORY: 4 };
const ORGANIZER_ROLE = "Organizer";

// Server layout. access: "open" (everyone talks), "readonly" (only Organizers + bot post), "private" (Organizers only),
// "buttons" (no one types or runs commands; only the bot's game card and its buttons),
// "commands" (slash commands only, no chat).
const LAYOUT = [
  {
    category: "INFO",
    channels: [
      { name: "welcome", access: "readonly", topic: "Start here. How the weekly runs work." },
      { name: "rules", access: "readonly", topic: "Community rules, payments and cancellation policy." },
      { name: "announcements", access: "readonly", topic: "News from the organizers." },
    ],
  },
  {
    category: "GAMES",
    channels: [
      { name: "games", access: "buttons", topic: "The current game. Tap Claim & Pay or Leave Match. Plan runs in #plan-a-run." },
      { name: "plan-a-run", access: "commands", topic: "Plan the next run: /available for open fields, /poll to ask who's in, and vote on polls here. Commands only, no chat." },
      { name: "find-a-sub", access: "open", topic: "Can't make it after the cutoff? Find someone to take your spot." },
    ],
  },
  {
    category: "COMMUNITY",
    channels: [{ name: "general", access: "open", topic: "General chat." }],
  },
  {
    category: "ORGANIZERS",
    access: "private",
    channels: [
      { name: "organizers", access: "private", topic: "Organizer planning. Private." },
      { name: "bot-logs", access: "private", topic: "Payments, refunds and bot activity." },
    ],
  },
];

async function api(method, path, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (soccer-runs-setup, 1.0)",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const { retry_after = 1 } = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil(retry_after * 1000)));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`${method} ${path} kept getting rate limited`);
}

async function getGuildId() {
  if (process.env.DISCORD_GUILD_ID) return process.env.DISCORD_GUILD_ID;
  const guilds = await api("GET", "/users/@me/guilds");
  if (guilds.length === 0) throw new Error("The bot isn't in any server yet. Run `npm run discord:invite-bot` first.");
  if (guilds.length > 1) {
    const list = guilds.map((g) => `  ${g.id}  ${g.name}`).join("\n");
    throw new Error(`The bot is in several servers. Set DISCORD_GUILD_ID in .env to one of:\n${list}`);
  }
  return guilds[0].id;
}

function overwritesFor(access, guildId, organizerRoleId, botUserId) {
  const everyone = { id: guildId, type: 0 };
  const organizer = { id: organizerRoleId, type: 0 };
  const bot = { id: botUserId, type: 1 };
  const botAllow = bits("VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS", "READ_MESSAGE_HISTORY", "MANAGE_MESSAGES");
  if (access === "readonly") {
    return [
      { ...everyone, allow: "0", deny: bits("SEND_MESSAGES") },
      { ...organizer, allow: bits("SEND_MESSAGES"), deny: "0" },
      { ...bot, allow: botAllow, deny: "0" },
    ];
  }
  const noTalk = bits("SEND_MESSAGES", "SEND_MESSAGES_IN_THREADS", "CREATE_PUBLIC_THREADS", "CREATE_PRIVATE_THREADS");
  if (access === "buttons") {
    const deny = (BigInt(noTalk) | P.USE_APPLICATION_COMMANDS).toString();
    return [
      { ...everyone, allow: "0", deny },
      { ...organizer, allow: "0", deny },
      { ...bot, allow: botAllow, deny: "0" },
    ];
  }
  if (access === "commands") {
    const allow = bits("USE_APPLICATION_COMMANDS");
    return [
      { ...everyone, allow, deny: noTalk },
      { ...organizer, allow, deny: noTalk },
      { ...bot, allow: botAllow, deny: "0" },
    ];
  }
  if (access === "private") {
    return [
      { ...everyone, allow: "0", deny: bits("VIEW_CHANNEL") },
      { ...organizer, allow: bits("VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"), deny: "0" },
      { ...bot, allow: botAllow, deny: "0" },
    ];
  }
  return [];
}

async function ensureOrganizerRole(guildId) {
  const roles = await api("GET", `/guilds/${guildId}/roles`);
  const existing = roles.find((r) => r.name === ORGANIZER_ROLE);
  if (existing) return { role: existing, created: false };
  const role = await api("POST", `/guilds/${guildId}/roles`, {
    name: ORGANIZER_ROLE,
    color: 0x2ecc71,
    hoist: true, // shows organizers separately in the member list
    mentionable: true,
    permissions: bits("CREATE_INSTANT_INVITE", "MANAGE_MESSAGES"),
  });
  return { role, created: true };
}

async function setup() {
  const guildId = await getGuildId();
  const guild = await api("GET", `/guilds/${guildId}`);
  const me = await api("GET", "/users/@me");
  console.log(`Setting up "${guild.name}"\n`);

  const { role: organizer, created: roleCreated } = await ensureOrganizerRole(guildId);
  console.log(`${roleCreated ? "Created" : "Found"} role: ${ORGANIZER_ROLE}`);

  let channels = await api("GET", `/guilds/${guildId}/channels`);
  const find = (name, type, parentId) =>
    channels.find((c) => c.name === name && c.type === type && (parentId === undefined || c.parent_id === parentId));

  let welcomeId;
  for (const group of LAYOUT) {
    let category = find(group.category, CHANNEL.CATEGORY);
    if (!category) {
      category = await api("POST", `/guilds/${guildId}/channels`, {
        name: group.category,
        type: CHANNEL.CATEGORY,
        permission_overwrites: overwritesFor(group.access ?? "open", guildId, organizer.id, me.id),
      });
      channels.push(category);
      console.log(`Created category: ${group.category}`);
    }

    for (const ch of group.channels) {
      const overwrites = overwritesFor(ch.access, guildId, organizer.id, me.id);
      // Reuse a channel with this name anywhere in the server (e.g. the default #general) and move it here.
      const existing = find(ch.name, CHANNEL.TEXT);
      let channel;
      if (existing) {
        channel = await api("PATCH", `/channels/${existing.id}`, {
          parent_id: category.id,
          topic: ch.topic,
          permission_overwrites: overwrites,
        });
        console.log(`  Updated #${ch.name}`);
      } else {
        channel = await api("POST", `/guilds/${guildId}/channels`, {
          name: ch.name,
          type: CHANNEL.TEXT,
          parent_id: category.id,
          topic: ch.topic,
          permission_overwrites: overwrites,
        });
        channels.push(channel);
        console.log(`  Created #${ch.name}`);
      }
      if (ch.name === "welcome") welcomeId = channel.id;
    }
  }

  const invite = await api("POST", `/channels/${welcomeId}/invites`, {
    max_age: 7 * 24 * 60 * 60, // 7 days
    max_uses: 0,
    unique: true,
  });
  console.log(`\nInvite link (expires in 7 days): https://discord.gg/${invite.code}`);
  console.log(`After your PM joins, run: npm run discord:organizer -- <their username>`);
}

async function inviteBot() {
  const app = await api("GET", "/oauth2/applications/@me");
  const url =
    `https://discord.com/oauth2/authorize?client_id=${app.id}` +
    `&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`;
  console.log(`Open this link, pick your server and click Authorize:\n\n${url}\n`);
}

async function makeOrganizer(name) {
  if (!name) throw new Error("Usage: npm run discord:organizer -- <username>");
  const guildId = await getGuildId();
  const { role } = await ensureOrganizerRole(guildId);
  const matches = await api("GET", `/guilds/${guildId}/members/search?query=${encodeURIComponent(name)}&limit=10`);
  const exact = matches.filter(
    (m) => m.user.username.toLowerCase() === name.toLowerCase() || (m.nick ?? m.user.global_name ?? "").toLowerCase() === name.toLowerCase(),
  );
  const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
  if (!pick) {
    const list = matches.map((m) => `  ${m.user.username} (${m.user.global_name ?? "no display name"})`).join("\n");
    throw new Error(matches.length ? `Several members match "${name}":\n${list}` : `No member matches "${name}". Have they joined yet?`);
  }
  await api("PUT", `/guilds/${guildId}/members/${pick.user.id}/roles/${role.id}`);
  console.log(`${pick.user.username} is now an ${ORGANIZER_ROLE}.`);
}

const [command, arg] = process.argv.slice(2);
const commands = { setup, "invite-bot": inviteBot, organizer: () => makeOrganizer(arg) };

if (!commands[command]) {
  console.error(`Unknown command "${command ?? ""}". Use one of: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
commands[command]().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
