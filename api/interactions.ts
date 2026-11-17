import { waitUntil } from "@vercel/functions";
import { available, confirmMatch, dateAutocomplete, lobbyButton, newGame } from "../lib/commands.js";
import { parseReserveButton, parseReserveCommand, reserve } from "../lib/reserve.js";
import { editReply, EPHEMERAL, InteractionType, isValidSignature, json, ResponseType, type Interaction } from "../lib/discord.js";

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
      return message(lobbyButton(interaction));
    }
  } catch (err) {
    console.error(err);
    return message({ content: "⚠️ Something went wrong. Please try again in a minute.", flags: EPHEMERAL });
  }

  return message({ content: "I don't know that command yet.", flags: EPHEMERAL });
}

function message(data: { content: string; flags?: number }) {
  return json({ type: ResponseType.MESSAGE, data: { ...data, allowed_mentions: { parse: [] } } });
}

async function failLater(interaction: Interaction, err: unknown) {
  console.error(err);
  await editReply(interaction, { content: "⚠️ Something went wrong. Please try again in a minute." }).catch(console.error);
}
