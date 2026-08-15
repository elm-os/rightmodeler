from langgraph.graph import StateGraph

from .agents import researcher

workflow = StateGraph(dict)


def build_graph():
    workflow.add_node("researcher", researcher)
    workflow.set_entry_point("researcher")
    return workflow.compile()
