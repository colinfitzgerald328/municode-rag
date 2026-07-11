// LLM generation via Cerebras (OpenAI-compatible chat completions API).
const KEY = process.env.CEREBRAS_API_KEY as string;
const MODEL = process.env.CEREBRAS_MODEL || "gemma-4-31b";
const ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

export async function generate(system: string, user: string): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_completion_tokens: 1400,
    }),
  });
  if (!res.ok) {
    throw new Error(`Cerebras ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
