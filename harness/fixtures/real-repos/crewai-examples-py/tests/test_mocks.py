from unittest.mock import MagicMock

client = MagicMock()


def test_agent_contract():
    """LLM(model="not-a-call")"""
    # LLM(model="commented-out")
    assert client is not None
