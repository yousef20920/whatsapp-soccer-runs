// Registers SORY's slash commands in the server (server commands update instantly).
// Usage: npm run discord:commands

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ORGANIZER = String(1n << 13n); // Manage Messages: Organizer role and admins see these commands

const STRING = 3, INTEGER = 4, NUMBER = 10;

// Mirrors lib/venues.ts: Active Mississauga resource ids for each quarter field.
const VENUES = [
  { name: "Churchill Meadows Dome", quarters: [[147, "F1"], [119, "F2"], [130, "F3"], [132, "F4"]] },
  { name: "Paramount Dome", quarters: [[1192, "F1"], [1197, "F2"], [1196, "F3"], [1181, "F4"]] },
  { name: "Paramount Sportsplex", quarters: [[1300, "A"], [1311, "B"], [1314, "C"], [1320, "D"]] },
];
const FIELD_CHOICES = VENUES.flatMap(({ name, quarters: q }) => [
  { name: `${name} · ${q[0][1]}+${q[1][1]} (half)`, value: `${q[0][0]}.${q[1][0]}` },
  { name: `${name} · ${q[2][1]}+${q[3][1]} (half)`, value: `${q[2][0]}.${q[3][0]}` },
  { name: `${name} · full field`, value: q.map(([id]) => id).join(".") },
  ...q.map(([id, label]) => ({ name: `${name} · ${label} (quarter)`, value: String(id) })),
]);
const FORMAT_CHOICES = ["11v11", "9v9", "8v8", "7v7", "6v6", "5v5"].map((f) => ({ name: f, value: f }));
const LENGTH_CHOICES = [60, 90, 120].map((m) => ({ name: `${m} min`, value: m }));
// 6 AM … 11 PM, so "7" can't be misread as 7 AM.
const AFTER_CHOICES = Array.from({ length: 18 }, (_, i) => {
  const h = i + 6;
  return { name: `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`, value: `${h}:00` };
});

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
    description: "Find open Mississauga turf (anyone; only organizers can reserve)",
    dm_permission: false,
    options: [
      { type: STRING, name: "from", description: "First day (default tomorrow)", autocomplete: true },
      { type: STRING, name: "to", description: "Last day (default a week after from)", autocomplete: true },
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
      { type: STRING, name: "after", description: "Earliest start, EST (default 5 PM)", choices: AFTER_CHOICES },
      { type: INTEGER, name: "players", description: "Players to split the cost (default: full teams, e.g. 14 for 7v7)", min_value: 2, max_value: 60 },
    ],
  },
  {
    name: "reserve",
    description: "Save a field slot as a draft game and get the booking links (organizers)",
    default_member_permissions: ORGANIZER,
    dm_permission: false,
    options: [
      { type: STRING, name: "field", description: "Which field", required: true, choices: FIELD_CHOICES },
      { type: STRING, name: "date", description: "Game day", required: true, autocomplete: true },
      { type: STRING, name: "time", description: "Start, EST, e.g. 8pm or 20:00", required: true },
      { type: STRING, name: "format", description: "Game size (default fits the field)", choices: FORMAT_CHOICES },
      { type: INTEGER, name: "length", description: "Minutes (default 60)", choices: LENGTH_CHOICES },
      { type: INTEGER, name: "players", description: "Players to split the cost (default: full teams)", min_value: 2, max_value: 60 },
    ],
  },
  {
    name: "confirm",
    description: "Open a booked game and post it in #games (organizers)",
    default_member_permissions: ORGANIZER,
    dm_permission: false,
    options: [{ type: INTEGER, name: "match", description: "Match number from /newgame", required: true, min_value: 1 }],
  },
  {
    name: "poll",
    description: "Ask who wants to play on a day. Organizers book once 12 are in.",
    dm_permission: false,
    options: [{ type: STRING, name: "day", description: "Game day", required: true, autocomplete: true }],
  },
  {
    name: "cancel",
    description: "Cancel a game: refunds everyone who paid and tells every player (organizers)",
    default_member_permissions: ORGANIZER,
    dm_permission: false,
    options: [
      { type: INTEGER, name: "match", description: "Match number", required: true, min_value: 1 },
      { type: STRING, name: "reason", description: "Told to players, e.g. Field closed for snow", max_length: 80 },
    ],
  },
  {
    name: "roster",
    description: "See who's paid, on hold, waitlisted or left, with money in and out (organizers)",
    default_member_permissions: ORGANIZER,
    dm_permission: false,
    options: [{ type: INTEGER, name: "match", description: "Match number", required: true, min_value: 1 }],
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
