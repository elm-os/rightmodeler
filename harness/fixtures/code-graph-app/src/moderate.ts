import OpenAI from "openai";

const openai = new OpenAI();

export async function isFlagged(text: string): Promise<boolean> {
  const result = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: text,
  });
  return result.results[0]?.flagged ?? false;
}
