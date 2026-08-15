const SUMMARY_MODEL = "acme/large-1";

export async function summarizeWithConstant(prompt: string) {
  return generateText({ model: SUMMARY_MODEL, prompt });
}
