import OpenAI from "openai";

const openai = new OpenAI();

export async function complete(prompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0]?.message.content ?? "";
}

export class TicketModel {
  async classify(text: string): Promise<string> {
    return complete(`Classify this ticket: ${text}`);
  }
}
