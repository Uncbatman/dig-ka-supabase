import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function orchestrate(message) {
  const prompt = `
You are an orchestration engine for a WhatsApp retail system.

Classify the user message and output STRICT JSON.

Agents available:
- order
- clarification
- memory
- admin

Rules:
- If message contains items → order agent
- If unclear → clarification agent
- If refers to past → memory agent
- If admin-related → admin agent

Message:
"${message}"

Output JSON only:
{
  "agent": "...",
  "action": "...",
  "data": {}
}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    return {
      agent: "clarification",
      action: "ask",
      data: { question: "Can you clarify your order?" },
    };
  }
}
