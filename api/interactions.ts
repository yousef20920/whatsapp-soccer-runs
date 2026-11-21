import { waitUntil } from "@vercel/functions";
import { available, cancelPrompt, confirmMatch, dateAutocomplete, newGame, roster } from "../lib/commands.js";
import { cancelGame, claim, leave, leaveConfirmed, pay, type Result } from "../lib/roster.js";
import { startPoll, vote } from "../lib/polls.js";
import { parseReserveButton, parseReserveCommand, reserve } from "../lib/reserve.js";
import { botLog, editReply, EPHEMERAL, followUpPrivately, InteractionType, isOrganizer, isValidSignature, json, playerOf, ResponseType, sendDirectMessage, type Interaction } from "../lib/discord.js";

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
        case "cancel":
          return json({ type: ResponseType.MESSAGE, data: { ...(await cancelPrompt(interaction)), allowed_mentions: { parse: [] } } });
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
  if (action === "cancel-yes" || action === "cancel-no") {
    if (action === "cancel-no") return json({ type: ResponseType.UPDATE_MESSAGE, data: { content: "👍 Kept the game. Nothing changed.", components: [] } });
    if (!isOrganizer(interaction)) return message({ content: "Only organizers can cancel games.", flags: EPHEMERAL });
    const reason = (interaction.data?.custom_id ?? "").split(":").slice(2).join(":") || null;
    waitUntil(
      cancelGame(Number(id), reason, playerOf(interaction).id)
        .then((content) => editReply(interaction, { content, components: [], allowed_mentions: { parse: [] } }))
        .catch((err) => failLater(interaction, err)),
    );
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
  // Buttons on the public game card answer by DM, so #games only ever shows the game itself.
  // Acknowledging with a silent update leaves the card as it is (SORY redraws it separately).
  const runInDm = (work: () => Promise<Result>) => {
    waitUntil(
      work()
        .then(async (r) => {
          if (!(await sendDirectMessage(player.id, { content: r.content, components: r.components }))) {
            const note = "\n-# I couldn't DM you. To get SORY's messages privately, allow DMs from server members (server name ▸ Privacy Settings).";
            await followUpPrivately(interaction, r.content + note, r.components);
          }
        })
        .catch(async (err) => {
          console.error(err);
          await botLog(`⚠️ button ${action} failed for <@${player.id}>: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
          await followUpPrivately(interaction, "⚠️ Something went wrong. Please try again in a minute.").catch(console.error);
        }),
    );
    return json({ type: ResponseType.DEFERRED_UPDATE });
  };
  const onGameCard = !!interaction.guild_id; // the same buttons also appear in DMs (e.g. poll invites, receipts)
  switch (action) {
    case "claim":
      return onGameCard ? runInDm(() => claim(matchId, player)) : run(() => claim(matchId, player), false);
    case "leave":
      return onGameCard ? runInDm(() => leave(matchId, player)) : run(() => leave(matchId, player), false);
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
  const what = interaction.data?.name ? `/${interaction.data.name}` : `button ${interaction.data?.custom_id ?? ""}`;
  await botLog(`⚠️ ${what} failed for <@${playerOf(interaction).id}>: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
  await editReply(interaction, { content: "⚠️ Something went wrong. Please try again in a minute." }).catch(console.error);
}
