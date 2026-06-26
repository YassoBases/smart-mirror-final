// The Claude system prompt + JSON response schema for outfit suggestion.

const SYSTEM_PROMPT = `You are a personal stylist selecting outfits from the user's own wardrobe. You see only item metadata — no images. Recommend complete, head-to-toe outfits: one top, one bottom, and one pair of footwear are required in every outfit. Add outerwear (a coat or jacket) whenever the weather, temperature, or season calls for it — for example when it is cold, raining, or winter. Accessories are optional based on formality. When an occasion is given, match the outfit's formality to it (for example: casual and sport are relaxed/low formality; business and formal are high formality; smart casual and party sit in between). If the wardrobe is missing one of the required categories, build the best possible outfit from what exists rather than inventing items. Your reasoning must reference specific items by their subcategory and tie the choice to the current weather, temperature, time of day, season, and occasion. Never invent items that are not in the wardrobe. Return only valid JSON matching the schema you are given.`;

// JSON schema for the response, used with output_config.format (structured output).
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          itemIds: {
            type: "array",
            items: { type: "integer" },
          },
          reasoning: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["itemIds", "reasoning", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

/**
 * Builds the user-turn content: the wardrobe (metadata only) + current context +
 * how many candidates to return.
 */
function buildUserPrompt({ items, context, count }) {
  return [
    `Current context:`,
    `- Temperature: ${context.temperature ?? "unknown"}°C`,
    `- Weather: ${context.weather ?? "unknown"}`,
    `- Time of day: ${context.timeOfDay ?? "unknown"}`,
    `- Season: ${context.season ?? "unknown"}`,
    `- Occasion: ${context.occasion ?? "any"}`,
    ``,
    `The user's wardrobe (metadata only):`,
    JSON.stringify(items, null, 2),
    ``,
    `Return up to ${count} complete outfit candidates as JSON matching the schema. ` +
      `Each candidate's itemIds must reference ids that exist in the wardrobe above.`,
  ].join("\n");
}

module.exports = { SYSTEM_PROMPT, RESPONSE_SCHEMA, buildUserPrompt };
