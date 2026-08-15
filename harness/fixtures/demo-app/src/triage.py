from anthropic import Anthropic

client = Anthropic()


def triage_ticket(message: str):
    return client.messages.create(
        model="acme/large-1",
        max_tokens=200,
        messages=[{"role": "user", "content": message}],
    )
