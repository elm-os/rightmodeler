SUMMARY_LLM = "acme/large-1"


def summarize_with_constant(prompt: str):
    return client.chat.completions.create(model=SUMMARY_LLM, messages=[prompt])
