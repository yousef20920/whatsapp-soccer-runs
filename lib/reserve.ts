import { isOpen, loadAvailability } from "./availability.js";
import { sql, type Match } from "./db.js";
import { botLog, editReply, isOrganizer, option, type Interaction } from "./discord.js";
import { money, priceFor } from "./pricing.js";
import { addDays, dayLabel, minuteLabel, parseTime, resolveDate, shortTime, torontoToDate, torontoToday } from "./time.js";
import { bookingLink, DEFAULT_FORMAT, dimensions, fieldCost, type Format, FORMATS, sizeFor, venueFor } from "./venues.js";

export interface ReserveRequest {
  resourceIds: number[];
  ymd: string;
  startMinute: number;
  lengthMinutes: number;
  format?: Format;
  players?: number;
}

const MIN_NOTICE_MS = 24 * 60 * 60 * 1000;
export const BOOKER_INSTALL_URL = "https://sory-five.vercel.app/booker/";

/**
 * Link that opens Active Mississauga and lets the SORY Booker extension fill in the whole booking
 * (every quarter field, date, times, attendees, event details) up to the waivers, signature and payment.
 */
export function autofillLink(r: { resourceIds: number[]; ymd: string; startMinute: number; lengthMinutes: number; players: number; matchId: number }) {
  const end = r.startMinute + r.lengthMinutes;
  const plan = {
    ids: r.resourceIds,
    ymd: r.ymd,
    start: minuteLabel(r.startMinute),
    end: end >= 24 * 60 ? "11:59 PM" : minuteLabel(end), // the City's form ends a day at 11:59 PM
    attendees: Math.min(Math.max(r.players, 5), 50),
    name: `NASORY Runs · Match #${r.matchId}`,
  };
  return `${bookingLink(r.resourceIds[0])}#sory=${Buffer.from(JSON.stringify(plan)).toString("base64url")}`;
}

/** Reserve button on an /available card: "rsv:1192.1197:2026-11-19:1020:60:9v9:18" */
export function reserveButtonId(r: Required<ReserveRequest>): string {
  return ["rsv", r.resourceIds.join("."), r.ymd, r.startMinute, r.lengthMinutes, r.format, r.players].join(":");
}

export function parseReserveButton(customId: string): ReserveRequest | null {
  const [tag, ids, ymd, start, length, format, players] = customId.split(":");
  if (tag !== "rsv") return null;
  return {
    resourceIds: ids.split(".").map(Number),
    ymd,
    startMinute: Number(start),
    lengthMinutes: Number(length),
    format: format as Format,
    players: Number(players),
  };
}

/** /reserve field date time [format] [length] [players] */
export function parseReserveCommand(interaction: Interaction): ReserveRequest | string {
  const today = torontoToday();
  const ymd = resolveDate(option<string>(interaction, "date")!, addDays(today, 1), addDays(today, 30));
  const time = parseTime(option<string>(interaction, "time")!);
  if (!ymd) return "I couldn't read that date. Pick one from the list.";
  if (!time) return "I couldn't read that time. Use something like 8pm or 20:00.";
  return {
    resourceIds: option<string>(interaction, "field")!.split(".").map(Number),
    ymd,
    startMinute: time[0] * 60 + time[1],
    lengthMinutes: option<number>(interaction, "length") ?? 60,
    format: option<string>(interaction, "format") as Format | undefined,
    players: option<number>(interaction, "players"),
  };
}

/**
 * Checks the slot is still open and bookable, saves it as a DRAFT game, and hands the
 * organizer the Active Mississauga links to book it. SORY never books or pays itself.
 * Runs after a deferred reply.
 */
export async function reserve(interaction: Interaction, request: ReserveRequest | string): Promise<void> {
  const reply = (content: string) => editReply(interaction, { content, allowed_mentions: { parse: [] } });
  if (!isOrganizer(interaction)) return void (await reply("Only organizers can reserve fields."));
  if (typeof request === "string") return void (await reply(request));

  const { resourceIds, ymd, startMinute, lengthMinutes } = request;
  const venue = venueFor(resourceIds);
  if (!venue) return void (await reply("I don't recognize that field."));
  const size = sizeFor(resourceIds.length, venue);
  const format = request.format && FORMATS[request.format] ? request.format : DEFAULT_FORMAT[size];
  const players = request.players ?? FORMATS[format].perSide * 2;
  const end = startMinute + lengthMinutes;
  if (end > 24 * 60) return void (await reply("Games have to finish by midnight."));

  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const kickoff = torontoToDate([y, m, d], [Math.floor(startMinute / 60), startMinute % 60]);
  const today = torontoToday();
  if (kickoff.getTime() < Date.now() + MIN_NOTICE_MS || ymd > addDays(today, 30)) {
    return void (await reply("Online booking only works 24 hours to 30 days ahead. For anything sooner, call 905-615-4100."));
  }

  const snapshot = await loadAvailability();
  if (!isOpen(snapshot, resourceIds, ymd, startMinute, lengthMinutes)) {
    return void (await reply(`❌ ${venue.name} is booked or closed ${dayLabel(ymd)} ${shortTime(startMinute)}–${shortTime(end)}. Run /available for open slots.`));
  }

  const cost = fieldCost(venue, ymd, startMinute, lengthMinutes, resourceIds.length);
  const { baseCents, checkoutCents } = priceFor(cost.totalCents, players);
  const labels = resourceIds.map((id) => venue.quarters.find((q) => q.id === id)!.label);
  const court = venue.outdoor ? `${labels.join("+")} (full outdoor field)` : `${size === "full" ? "Full field" : labels.join("+")} (${size})`;

  const [match] = await sql<Match[]>`
    INSERT INTO matches (facility_name, court_name, kickoff_time, duration_minutes, max_players, field_cost_cents,
                         base_price_cents, checkout_price_cents, created_by, resource_ids, game_format)
    VALUES (${venue.name}, ${court}, ${kickoff}, ${lengthMinutes}, ${players}, ${cost.totalCents},
            ${baseCents}, ${checkoutCents}, ${interaction.member!.user.id}, ${resourceIds}, ${format})
    RETURNING *`;

  const bookLinks = resourceIds.map((id, i) => `[${labels[i]}](${bookingLink(id)})`).join(" · ");
  const autofill = autofillLink({ resourceIds, ymd, startMinute, lengthMinutes, players, matchId: match.match_id });
  await reply(
    [
      `📝 **Draft Match #${match.match_id}** · not booked yet`,
      `📅 ${dayLabel(ymd)} · 🕐 ${shortTime(startMinute)}–${shortTime(end)} EST · 📍 ${venue.name} ${court}`,
      `💵 **${money(checkoutCents)}/player** · ${money(cost.totalCents)} total · ${cost.rate}`,
      `⚽ ${format} · ${players} players · 📏 ${dimensions(venue, size)}${venue.pitch.estimated ? " (est.)" : ""}`,
      ``,
      `**To book:**`,
      `1️⃣ **[🤖 Open the booking, filled in](${autofill})** on a computer`,
      `   Then answer the 2 "I acknowledge" questions, tick the waivers, sign, Add to cart and pay.`,
      `-# Needs the [SORY Booker extension](${BOOKER_INSTALL_URL}) (one-time install). Without it, book by hand: ${bookLinks}`,
      `2️⃣ Then run \`/confirm match:${match.match_id}\` to post it in #games`,
      `-# Anyone can still book this slot until you do, so book soon.`,
    ].join("\n"),
  );
  await botLog(`📝 <@${interaction.member!.user.id}> reserved Draft Match #${match.match_id}: ${venue.name} ${court}, ${dayLabel(ymd)} ${shortTime(startMinute)}, ${money(cost.totalCents)} total`);
}
