import OpenAI from "openai";

const client = new OpenAI();

export async function summarizeBrief(text) {
  return client.chat.completions.create({
    model: "__MODEL_A__",
    messages: [{ role: "user", content: `Summarize in one sentence: ${text}` }],
    max_tokens: 64,
  });
}

export async function summarizeDetailed(text) {
  return client.chat.completions.create({
    model: "__MODEL_B__",
    messages: [{ role: "user", content: `Summarize in one sentence: ${text}` }],
    max_tokens: 64,
  });
}
