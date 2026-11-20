import { waitUntil } from "@vercel/functions";
import { available, confirmMatch, dateAutocomplete, newGame, roster } from "../lib/commands.js";
import { claim, leave, leaveConfirmed, pay, type Result } from "../lib/roster.js";
import { startPoll, vote } from "../lib/polls.js";
import { parseReserveButton, parseReserveCommand, reserve } from "../lib/reserve.js";
import { editReply, EPHEMERAL, InteractionType, isValidSignature, json, playerOf, ResponseType, type Interaction } from "../lib/discord.js";

// Discord sends every slash command and button click here (the app's Interactions Endpoint URL).
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const valid = isValidSignature(body, request.headers.get("x-signature-ed25519"), request.headers.get("x-signature-timestamp"));
  if (!valid) return new Response("Bad signature", { status: 401 });

  const interaction = JSON.parse(body) as Interaction;

  if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG });

  try {
    // Typing in a date box: suggest bookable days.
    if (interaction.type === InteractionType.AUTOCOMPLETE) {
      return json({ type: ResponseType.AUTOCOMPLETE_RESULT, data: { choices: dateAutocomplete(interaction) } });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      switch (interaction.data?.name) {
        case "ping":
          return message({ content: "🏓 Pong! SORY is online.", flags: EPHEMERAL });
        case "newgame":
          return message(await newGame(interaction));
        case "confirm":
          // Posting the lobby can take longer than Discord's 3-second window, so answer
          // "thinking…" now and finish in the background.
          waitUntil(confirmMatch(interaction).catch((err) => failLater(interaction, err)));
          return json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
        case "available":
          waitUntil(available(interaction).catch((err) => failLater(interaction, err)));
          return json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
        case "poll":
          waitUntil(startPoll(interaction).catch((err) => failLater(interaction, err)));
          return json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
        case "roster":
          return message(await roster(interaction));
        case "reserve":
          waitUntil(reserve(interaction, parseReserveCommand(interaction)).catch((err) => failLater(interaction, err)));
          return json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
      }
    }

    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      const reserveRequest = parseReserveButton(interaction.data?.custom_id ?? "");
      if (reserveRequest) {
        waitUntil(reserve(interaction, reserveRequest).catch((err) => failLater(interaction, err)));
        return json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
      }
      return gameButton(interaction);
    }
  } catch (err) {
    console.error(err);
    return message({ content: "⚠️ Something went wrong. Please try again in a minute.", flags: EPHEMERAL });
  }

  return message({ content: "I don't know that command yet.", flags: EPHEMERAL });
}

/**
 * Buttons on a game. claim/leave are on the public lobby, so they answer privately; pay/drop/
 * leave-yes/stay are on SORY's private prompts or DMs, so they update that prompt in place.
 */
function gameButton(interaction: Interaction): Response {
  const [action, id] = (interaction.data?.custom_id ?? "").split(":");
  if (action === "poll-in" || action === "poll-out") {
    waitUntil(vote(interaction, Number(id), action === "poll-in" ? "IN" : "OUT").catch((err) => console.error("Vote failed", err)));
    return json({ type: ResponseType.DEFERRED_UPDATE });
  }
  const matchId = Number(id);
  const player = playerOf(interaction);
  const run = (work: () => Promise<Result>, update: boolean) => {
    waitUntil(
      work()
        .then((r) => editReply(interaction, { content: r.content, components: r.components ?? (update ? [] : undefined), allowed_mentions: { parse: [] } }))
        .catch((err) => failLater(interaction, err)),
    );
    return json(update ? { type: ResponseType.DEFERRED_UPDATE } : { type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
  };
  switch (action) {
    case "claim":
      return run(() => claim(matchId, player), false);
    case "leave":
      return run(() => leave(matchId, player), false);
    case "pay":
      return run(() => pay(matchId, player), true);
    case "drop":
      return run(() => leave(matchId, player), true);
    case "leave-yes":
      return run(() => leaveConfirmed(matchId, player), true);
    case "stay":
      return json({ type: ResponseType.UPDATE_MESSAGE, data: { content: "👍 You're still in.", components: [] } });
  }
  return message({ content: "That button isn't recognized.", flags: EPHEMERAL });
}

function message(data: { content: string; flags?: number }) {
  return json({ type: ResponseType.MESSAGE, data: { ...data, allowed_mentions: { parse: [] } } });
}

async function failLater(interaction: Interaction, err: unknown) {
  console.error(err);
  await editReply(interaction, { content: "⚠️ Something went wrong. Please try again in a minute." }).catch(console.error);
}
