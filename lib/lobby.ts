import type { Match, Registration } from "./db.js";
import { LEAVE_CUTOFF_HOURS, money } from "./pricing.js";
import { torontoLabel } from "./time.js";

const PER_FIELD = 20; // names per embed field, to stay under Discord's 1024-character field limit

/** The public Match Lobby message: embed plus Claim & Pay (or Join waitlist) and Leave Match buttons. */
export function lobbyMessage(match: Match, registrations: Registration[]) {
  const confirmed = registrations.filter((r) => r.status === "CONFIRMED");
  const holding = registrations.filter((r) => r.status === "PENDING");
  const waitlist = registrations.filter((r) => r.status === "WAITLIST");
  const kickoff = Math.floor(new Date(match.kickoff_time).getTime() / 1000);
  const price = money(match.checkout_price_cents);
  const open = match.status === "OPEN";
  const full = confirmed.length + holding.length >= match.max_players;

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "When", value: `${torontoLabel(new Date(match.kickoff_time))}\n<t:${kickoff}:R>`, inline: true },
    { name: "Length", value: `${match.duration_minutes} min`, inline: true },
    { name: "Price", value: price, inline: true },
  ];
  const names = (rows: Registration[]) => rows.map((r, i) => `${i + 1}. <@${r.discord_user_id}>`);
  addList(fields, `Roster: ${confirmed.length}/${match.max_players} paid`, names(confirmed), "No one yet. Be the first!");
  if (holding.length) fields.push({ name: "On hold", value: `⏳ ${holding.length} spot${holding.length === 1 ? "" : "s"} being paid for right now` });
  if (waitlist.length) addList(fields, `Waitlist (${waitlist.length})`, names(waitlist));

  const status = open ? (full ? "Full: join the waitlist and you'll get a DM if a spot opens" : "First come, first served") : "Roster closed";
  return {
    embeds: [
      {
        title: `⚽ ${match.facility_name} · ${match.court_name}`,
        color: open ? (full ? 0xe67e22 : 0x2ecc71) : 0x95a5a6,
        fields,
        footer: { text: `Match #${match.match_id} · ${status} · Leave up to ${LEAVE_CUTOFF_HOURS} hours before kickoff for a refund (minus card fee)` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: full ? 1 : 3, label: full ? "Join waitlist" : `Claim & Pay (${price})`, custom_id: `claim:${match.match_id}`, disabled: !open },
          { type: 2, style: 4, label: "Leave Match", custom_id: `leave:${match.match_id}`, disabled: !open },
        ],
      },
    ],
    allowed_mentions: { parse: [] }, // show names without pinging everyone on the roster
  };
}

/** Adds a numbered list as one or more embed fields (Discord caps a field at 1024 characters). */
export function addList(fields: { name: string; value: string }[], name: string, lines: string[], empty = "-") {
  if (!lines.length) return void fields.push({ name, value: empty });
  for (let i = 0; i < lines.length; i += PER_FIELD) {
    fields.push({ name: i === 0 ? name : "​", value: lines.slice(i, i + PER_FIELD).join("\n") });
  }
}
