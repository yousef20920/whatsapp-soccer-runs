import type { Match, Registration } from "./db.js";
import { money } from "./pricing.js";
import { torontoLabel } from "./time.js";

/** The public Match Lobby message: embed plus Claim & Pay / Leave Match buttons. */
export function lobbyMessage(match: Match, registrations: Registration[]) {
  const confirmed = registrations.filter((r) => r.status === "CONFIRMED");
  const waitlist = registrations.filter((r) => r.status === "WAITLIST");
  const kickoff = Math.floor(new Date(match.kickoff_time).getTime() / 1000);
  const price = money(match.checkout_price_cents);
  const open = match.status === "OPEN";

  const roster = confirmed.length
    ? confirmed.map((r, i) => `${i + 1}. <@${r.discord_user_id}>`).join("\n")
    : "No one yet. Be the first!";

  const fields = [
    { name: "When", value: `${torontoLabel(new Date(match.kickoff_time))}\n<t:${kickoff}:R>`, inline: true },
    { name: "Length", value: `${match.duration_minutes} min`, inline: true },
    { name: "Price", value: price, inline: true },
    { name: `Roster: ${confirmed.length}/${match.max_players} confirmed`, value: roster },
  ];
  if (waitlist.length) {
    fields.push({ name: `Waitlist (${waitlist.length})`, value: waitlist.map((r, i) => `${i + 1}. <@${r.discord_user_id}>`).join("\n") });
  }

  return {
    embeds: [
      {
        title: `⚽ ${match.facility_name} · ${match.court_name}`,
        color: open ? 0x2ecc71 : 0x95a5a6,
        fields,
        footer: { text: `Match #${match.match_id} · First come, first served · Your spot is confirmed once you pay` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: `Claim & Pay (${price})`, custom_id: `claim:${match.match_id}`, disabled: !open },
          { type: 2, style: 4, label: "Leave Match", custom_id: `leave:${match.match_id}`, disabled: !open },
        ],
      },
    ],
    allowed_mentions: { parse: [] }, // show names without pinging everyone on the roster
  };
}
