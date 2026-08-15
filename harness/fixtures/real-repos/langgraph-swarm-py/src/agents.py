from langchain_openai import ChatOpenAI

model = ChatOpenAI(model="acme/chat-large")


def researcher(state):
    question = state["question"]
    answer = model.invoke(question)
    return {"answer": answer}


research_agents = [researcher]
