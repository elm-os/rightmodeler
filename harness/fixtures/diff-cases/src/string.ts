export async function summarize(prompt: string) {
  return generateText({ model: "acme/large-1", prompt });
}
