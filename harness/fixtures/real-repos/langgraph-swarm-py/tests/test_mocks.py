from unittest.mock import MagicMock

client = MagicMock()


def test_agent_contract():
    """client.responses.create(model="not-a-call", input="ignored")"""
    # dspy.Predict("question -> answer")
    client.responses.create.return_value.output_text = "fixture"
    assert client.responses.create.return_value.output_text == "fixture"
