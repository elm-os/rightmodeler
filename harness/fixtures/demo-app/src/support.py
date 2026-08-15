from openai import OpenAI

client = OpenAI()


def draft_support_reply(message: str):
    return client.chat.completions.create(
        model="acme/large-1",
        messages=[{"role": "user", "content": message}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "lookup_order",
                    "description": "Look up the current state of an order.",
                    "parameters": {
                        "type": "object",
                        "properties": {"order_id": {"type": "string"}},
                        "required": ["order_id"],
                    },
                },
            }
        ],
    )
