import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function extractOrder(message) {
  const prompt = `
You extract shopping orders from WhatsApp messages.

Rules:
- If no quantity is provided, assume qty = 1
- Output ONLY valid JSON
- No explanations

Format:
{
  "items": [
    { "name": "item", "qty": number }
  ]
}

Message:
"${message}"
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    return { items: [] };
  }
}
