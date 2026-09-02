from autogen_agentchat.agents import AssistantAgent
from autogen_ext.models.openai import OpenAIChatCompletionClient

model_client = OpenAIChatCompletionClient(model="acme/chat-large")
assistant = AssistantAgent("assistant", model_client=model_client)


async def answer(task):
    return await assistant.run(task=task)
