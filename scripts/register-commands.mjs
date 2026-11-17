// Registers SORY's slash commands in the server (server commands update instantly).
// Usage: npm run discord:commands

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ORGANIZER = String(1n << 13n); // Manage Messages: Organizer role and admins see these commands

const STRING = 3, INTEGER = 4, NUMBER = 10;

const commands = [
  { name: "ping", description: "Check that SORY is online" },
  {
    name: "newgame",
    description: "Create a draft game (organizers)",
    default_member_permissions: ORGANIZER,
    dm_permission: false,
    options: [
      { type: STRING, name: "facility", description: "e.g. Churchill Meadows Dome", required: true, max_length: 100 },
      { type: STRING, name: "court", description: "e.g. Half field A", required: true, max_length: 50 },
      { type: STRING, name: "date", description: "YYYY-MM-DD, e.g. 2026-11-21", required: true },
      { type: STRING, name: "time", description: "Kickoff in Eastern time (EST), e.g. 20:00 or 8pm", required: true },
      { type: NUMBER, name: "field_cost", description: "Total field cost in dollars, tax included", required: true, min_value: 1 },
      { type: INTEGER, name: "max_players", description: "Roster size (default 18)", min_value: 2, max_value: 60 },
      { type: INTEGER, name: "duration", description: "Minutes (default 60)", min_value: 15, max_value: 300 },
    ],
  },
  {
    name: "available",
    description: "Find open Mississauga turf to book (organizers)",
    default_member_permissions: ORGANIZER,
    dm_permission: false,
    options: [
      { type: STRING, name: "date", description: "One day, YYYY-MM-DD (default: the next 7 days)" },
      {
        type: STRING,
        name: "format",
        description: "Game size (default 9v9 on a half field)",
        choices: [
          { name: "11v11 · full field", value: "11v11" },
          { name: "9v9 · half field", value: "9v9" },
          { name: "8v8 · half field", value: "8v8" },
          { name: "7v7 · quarter field", value: "7v7" },
          { name: "6v6 · quarter field", value: "6v6" },
          { name: "5v5 · quarter field", value: "5v5" },
        ],
      },
      {
        type: INTEGER,
        name: "length",
        description: "Minutes (default 60)",
        choices: [
          { name: "60 min", value: 60 },
          { name: "90 min", value: 90 },
          { name: "120 min", value: 120 },
        ],
      },
      { type: STRING, name: "after", description: "Earliest start, EST (default 5pm)" },
      { type: INTEGER, name: "players", description: "Players to split the cost (default: full teams, e.g. 14 for 7v7)", min_value: 2, max_value: 60 },
    ],
  },
  {
    name: "confirm",
    description: "Open a booked game and post it in #games (organizers)",
    default_member_permissions: ORGANIZER,
    dm_permission: false,
    options: [{ type: INTEGER, name: "match", description: "Match number from /newgame", required: true, min_value: 1 }],
  },
];

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

const app = await api("GET", "/oauth2/applications/@me");
const [guild] = await api("GET", "/users/@me/guilds");
const saved = await api("PUT", `/applications/${app.id}/guilds/${guild.id}/commands`, commands);
console.log(`Registered in "${guild.name}": ${saved.map((c) => "/" + c.name).join(", ")}`);
