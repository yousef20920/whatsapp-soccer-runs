import { sql, type Match, type Registration } from "./db.js";
import { discord, displayName, editReply, EPHEMERAL, env, isOrganizer, option, type Interaction } from "./discord.js";
import { lobbyMessage } from "./lobby.js";
import { money, priceFor } from "./pricing.js";
import { addDays, dateChoices, dayLabel, parseDate, parseTime, resolveDate, shortTime, torontoLabel, torontoToDate, torontoToday } from "./time.js";
import { findSlots, loadAvailability, type Size } from "./availability.js";
import { bookingLink, dimensions, type Format, FORMATS } from "./venues.js";
import { reserveButtonId } from "./reserve.js";

type Reply = { content: string; flags?: number };

const DEFAULT_MAX_PLAYERS = 18;
const DEFAULT_DURATION_MINUTES = 60;

/** /newgame: creates a DRAFT match. Players can't see or pay for it until /confirm. */
export async function newGame(interaction: Interaction): Promise<Reply> {
  if (!isOrganizer(interaction)) return privateReply("Only organizers can create games.");

  const facility = option<string>(interaction, "facility")!.trim();
  const court = option<string>(interaction, "court")!.trim();
  const date = parseDate(option<string>(interaction, "date")!);
  const time = parseTime(option<string>(interaction, "time")!);
  const fieldCost = option<number>(interaction, "field_cost")!;
  const maxPlayers = option<number>(interaction, "max_players") ?? DEFAULT_MAX_PLAYERS;
  const duration = option<number>(interaction, "duration") ?? DEFAULT_DURATION_MINUTES;

  if (!date) return privateReply("I couldn't read that date. Use YYYY-MM-DD, like 2026-11-21.");
  if (!time) return privateReply("I couldn't read that time. Use something like 20:00 or 8pm.");
  const kickoff = torontoToDate(date, time);
  if (kickoff.getTime() <= Date.now()) return privateReply("That kickoff time has already passed.");

  const fieldCostCents = Math.round(fieldCost * 100);
  const { baseCents, checkoutCents } = priceFor(fieldCostCents, maxPlayers);

  const [match] = await sql<Match[]>`
    INSERT INTO matches (facility_name, court_name, kickoff_time, duration_minutes, max_players,
                         field_cost_cents, base_price_cents, checkout_price_cents, created_by)
    VALUES (${facility}, ${court}, ${kickoff}, ${duration}, ${maxPlayers},
            ${fieldCostCents}, ${baseCents}, ${checkoutCents}, ${interaction.member!.user.id})
    RETURNING *`;

  return privateReply(
    [
      `📝 **Draft Match #${match.match_id}** created (players can't see it yet).`,
      `**${facility} · ${court}**, ${torontoLabel(kickoff)}, ${duration} min, ${maxPlayers} players`,
      `Field ${money(fieldCostCents)} → ${money(baseCents)} each + card fee = **${money(checkoutCents)} per player**`,
      `Once the field is booked, run \`/confirm match:${match.match_id}\` to post it in #games.`,
    ].join("\n"),
  );
}

/** /confirm: DRAFT -> OPEN and posts the Match Lobby in #games. Runs after a deferred reply. */
export async function confirmMatch(interaction: Interaction): Promise<void> {
  const reply = (content: string) => editReply(interaction, { content });
  if (!isOrganizer(interaction)) return void (await reply("Only organizers can confirm games."));

  const matchId = option<number>(interaction, "match")!;
  const [match] = await sql<Match[]>`SELECT * FROM matches WHERE match_id = ${matchId}`;
  if (!match) return void (await reply(`There's no Match #${matchId}.`));
  if (match.status !== "DRAFT") return void (await reply(`Match #${matchId} is already ${match.status.toLowerCase()}.`));
  if (new Date(match.kickoff_time).getTime() <= Date.now()) return void (await reply(`Match #${matchId} has already started.`));

  const opened: Match = { ...match, status: "OPEN" };
  const registrations = await sql<Registration[]>`
    SELECT discord_user_id, discord_username, status FROM registrations
    WHERE match_id = ${matchId} ORDER BY created_at`;
  const channelId = env("GAMES_CHANNEL_ID");
  const message = await discord<{ id: string }>("POST", `/channels/${channelId}/messages`, lobbyMessage(opened, registrations));

  await sql`
    UPDATE matches SET status = 'OPEN', channel_id = ${channelId}, message_id = ${message.id}
    WHERE match_id = ${matchId}`;
  await reply(`✅ Match #${matchId} is open and posted in <#${channelId}>.`);
}

const DEFAULT_DAYS = 7;
const MAX_SLOTS_SHOWN = 10; // ~350 characters per card; Discord allows 6000 per message

/** /available: open Mississauga turf slots with total cost and per-player price. Runs after a deferred reply. */
export async function available(interaction: Interaction): Promise<void> {
  const reply = (body: object) => editReply(interaction, { allowed_mentions: { parse: [] }, ...body });
  if (!isOrganizer(interaction)) return void (await reply({ content: "Only organizers can search for fields." }));

  const format = (option<string>(interaction, "format") ?? "9v9") as Format;
  const { size, perSide } = FORMATS[format] ?? FORMATS["9v9"];
  const length = option<number>(interaction, "length") ?? DEFAULT_DURATION_MINUTES;
  const players = option<number>(interaction, "players") ?? perSide * 2;
  const afterText = option<string>(interaction, "after") ?? "5pm";
  const fromText = option<string>(interaction, "from");
  const toText = option<string>(interaction, "to");

  const after = parseTime(afterText);
  if (!after) return void (await reply({ content: "I couldn't read that time. Use something like 5pm or 17:00." }));
  const afterMinute = after[0] * 60 + after[1];

  // Dates: from (default tomorrow) to (default a week later), inside the online booking window.
  const { first, last } = bookingWindow();
  const from = fromText ? resolveDate(fromText, first, last) : first;
  if (!from) return void (await reply({ content: `I couldn't read the from date "${fromText}". Pick one from the list.` }));
  const to = toText ? resolveDate(toText, first, last) : minDate(addDays(from, DEFAULT_DAYS - 1), last);
  if (!to) return void (await reply({ content: `I couldn't read the to date "${toText}". Pick one from the list.` }));
  if (from < first || to > last) {
    return void (await reply({ content: `Online booking only covers ${dayLabel(first)} to ${dayLabel(last)} (at least 24 hours and at most 30 days ahead).` }));
  }
  if (to < from) return void (await reply({ content: `The to date (${dayLabel(to)}) is before the from date (${dayLabel(from)}).` }));
  const dates: string[] = [];
  for (let ymd = from; ymd <= to; ymd = addDays(ymd, 1)) dates.push(ymd);

  const snapshot = await loadAvailability();
  const found = dates.flatMap((ymd) => findSlots(snapshot, ymd, size, length, afterMinute).map((slot) => ({ ymd, slot })));
  const sizeLabel = { quarter: "Quarter field", half: "Half field", full: "Full field" }[size];

  // One short card per opening: when/where, price, then format and links.
  const shown = found.slice(0, MAX_SLOTS_SHOWN);
  const fields = shown.map(({ ymd, slot: s }, i) => {
    const end = s.bestStart + length;
    const perPlayer = priceFor(s.cost.totalCents, players).checkoutCents;
    const links = [`[Book](${bookingLink(s.resourceIds[0])})`, ...s.venue.links.map((l) => `[${l.label}](${l.url})`)].join(" · ");
    const widerWindow = s.open.start < s.bestStart || s.open.end > end ? ` · 🟢 open ${shortTime(s.open.start)}–${shortTime(s.open.end)}` : "";
    const dims = `${dimensions(s.venue, size)}${s.venue.pitch.estimated ? " (est.)" : ""}`;
    return {
      name: `${i + 1}. 📅 ${dayLabel(ymd).replace(",", "")} · 🕐 ${shortTime(s.bestStart)}–${shortTime(end)} · 📍 ${s.venue.name} ${s.label}`,
      value: [
        `💵 **${money(perPlayer)}/player** · ${money(s.cost.totalCents)} total · ${s.cost.rate}`,
        `⚽ ${format} · 📏 ${dims}${widerWindow}`,
        `🔗 ${links}`,
      ].join("\n"),
    };
  });

  const range = dates.length === 1 ? dayLabel(dates[0]) : `${dayLabel(dates[0])} – ${dayLabel(dates[dates.length - 1])}`;
  const more = found.length > MAX_SLOTS_SHOWN ? `\nShowing ${MAX_SLOTS_SHOWN} of ${found.length} · narrow \`from:\` and \`to:\`` : "";
  const checked = Math.floor(snapshot.oldestFetch.getTime() / 1000);
  await reply({
    embeds: [
      {
        title: `🔎 ${found.length} open · ${range}`,
        description: found.length
          ? `${format} · ${sizeLabel.toLowerCase()} · ${length} min · after ${shortTime(afterMinute)} EST · ${players} players\n-# Price per player includes the card fee. Totals include HST. Resident rates.${more}`
          : `No openings for ${format} after ${shortTime(afterMinute)}. Try another day, an earlier time, or a smaller format.`,
        color: 0x3498db,
        fields,
        footer: { text: `Source: Active Mississauga${snapshot.stale ? " · ⚠️ some data may be out of date" : ""} · checked` },
        timestamp: new Date(checked * 1000).toISOString(),
      },
    ],
    // "📝 Reserve 1" … under the cards: saves that slot as a draft game with booking steps.
    components: chunk(
      shown.map(({ ymd, slot: s }, i) => ({
        type: 2,
        style: 1,
        label: `📝 Reserve ${i + 1}`,
        custom_id: reserveButtonId({ resourceIds: s.resourceIds, ymd, startMinute: s.bestStart, lengthMinutes: length, format, players }),
      })),
      5,
    ).map((buttons) => ({ type: 1, components: buttons })),
  });
}

/** Online booking on Active Mississauga: at least 24 hours and at most 30 days ahead. */
function bookingWindow() {
  const today = torontoToday();
  return { first: addDays(today, 1), last: addDays(today, 30) };
}

const minDate = (a: string, b: string) => (a < b ? a : b);

/** Date pickers on /available (from, to) and /reserve (date): bookable days that match what's typed. */
export function dateAutocomplete(interaction: Interaction): { name: string; value: string }[] {
  const focused = interaction.data?.options?.find((o) => o.focused);
  if (!focused) return [];
  let { first, last } = bookingWindow();
  if (focused.name === "to") {
    // Start the "to" list at the chosen "from" day.
    const fromText = option<string>(interaction, "from");
    const from = fromText ? resolveDate(fromText, first, last) : null;
    if (from && from >= first && from <= last) first = from;
  }
  return dateChoices(String(focused.value ?? ""), first, last);
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
}

/** Claim & Pay / Leave Match buttons. Payments arrive in the next build step. */
export function lobbyButton(interaction: Interaction): Reply {
  const [action] = (interaction.data?.custom_id ?? "").split(":");
  const name = displayName(interaction);
  if (action === "claim") return privateReply(`Thanks ${name}! Payments aren't switched on yet. They're coming in the next update.`);
  if (action === "leave") return privateReply("You're not on this game's roster.");
  return privateReply("That button isn't recognized.");
}

function privateReply(content: string): Reply {
  return { content, flags: EPHEMERAL };
}
