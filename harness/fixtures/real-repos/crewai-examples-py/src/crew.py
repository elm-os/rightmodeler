from crewai import Agent, Crew, LLM, Task

researcher = Agent(
    role="Researcher",
    goal="Find the answer",
    backstory="Reads everything",
    llm=LLM(model="acme/chat-large"),
)
task = Task(description="Answer {question}", expected_output="An answer", agent=researcher)
crew = Crew(agents=[researcher], tasks=[task])
