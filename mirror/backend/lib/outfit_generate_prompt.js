// System prompt + JSON schema for GENERATING brand-new outfit ideas that are NOT
// limited to the user's closet. Each item is a described garment (with attributes
// plus an image-generation prompt) so the backend can render a preview image and
// build a shopping search link from it.

const GENERATE_SYSTEM_PROMPT = `You are a personal stylist who invents brand-new outfit ideas for the user to shop for — these items are NOT from any existing wardrobe. Design complete, head-to-toe outfits: each must include one top, one bottom, and one pair of footwear; add outerwear (a coat or jacket) when the weather, temperature, or season calls for it; accessories are optional. Match the outfit's overall formality to the given occasion (casual and sport are relaxed; business and formal are dressy; smart casual and party sit in between) and suit the weather, temperature, time of day, and season. For each item provide concrete, realistic attributes and two short text fields: "description" is a natural shopping phrase a person could search for (e.g. "navy wool double-breasted overcoat"), and "imagePrompt" is a clean product-photo prompt of the single garment on a plain white background, no person. Vary colours and styles across candidates. Return only valid JSON matching the schema you are given.`;

// Per-item describes a garment to render + shop for. Mirrors the wardrobe item
// attribute vocabulary so the preference ranker can score generated outfits too.
const GENERATE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                category: {
                  type: "string",
                  enum: ["top", "bottom", "outerwear", "footwear", "accessory"],
                },
                subcategory: { type: "string" },
                primaryColor: { type: "string" },
                pattern: {
                  type: "string",
                  enum: ["solid", "stripe", "plaid", "print", "other"],
                },
                formality: { type: "integer" },
                warmth: { type: "integer" },
                seasons: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["winter", "spring", "summer", "autumn"],
                  },
                },
                description: { type: "string" },
                imagePrompt: { type: "string" },
              },
              required: ["category", "subcategory", "description", "imagePrompt"],
              additionalProperties: false,
            },
          },
          reasoning: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["items", "reasoning", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

function buildGenerateUserPrompt({ context, count }) {
  return [
    `Current context:`,
    `- Temperature: ${context.temperature ?? "unknown"}°C`,
    `- Weather: ${context.weather ?? "unknown"}`,
    `- Time of day: ${context.timeOfDay ?? "unknown"}`,
    `- Season: ${context.season ?? "unknown"}`,
    `- Occasion: ${context.occasion ?? "any"}`,
    ``,
    `Invent ${count} distinct, complete outfit ideas as JSON matching the schema. ` +
      `These are new items to shop for, not from any existing wardrobe.`,
  ].join("\n");
}

module.exports = {
  GENERATE_SYSTEM_PROMPT,
  GENERATE_RESPONSE_SCHEMA,
  buildGenerateUserPrompt,
};
