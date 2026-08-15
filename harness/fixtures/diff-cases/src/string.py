def summarize(prompt: str):
    return client.chat.completions.create(model="acme/large-1", messages=[prompt])
