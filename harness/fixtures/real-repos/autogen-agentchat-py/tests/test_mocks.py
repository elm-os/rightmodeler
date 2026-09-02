from unittest.mock import MagicMock

client = MagicMock()


def test_agent_contract():
    """OpenAIChatCompletionClient(model="not-a-call")"""
    # OpenAIChatCompletionClient(model="commented-out")
    assert client is not None
