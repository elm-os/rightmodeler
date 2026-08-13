from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from openai import OpenAI


CLASSIFY_MODEL = "acme/large-1"
LOOKUP_MODEL = "acme/max-1"
ANSWER_MODEL = "acme/large-1"
TOOL_CASE_INPUT = "Where is order ORD-104?"


class Step(TypedDict):
    step: str
    model: str
    ok: bool


class AppState(TypedDict):
    case_id: str
    input: str
    route: Literal["lookup", "answer"]
    classification: str
    lookup_result: str
    final_output: str
    steps: list[Step]


def lookup_order(order_id: str) -> str:
    return json.dumps(
        {"orderId": order_id, "status": "in transit", "etaDays": 2},
        separators=(",", ":"),
    )


def client_from_env() -> OpenAI:
    return OpenAI(
        base_url=os.environ["OPENAI_BASE_URL"],
        api_key=os.environ["OPENAI_API_KEY"],
        default_headers={
            "x-rm-run": os.environ["RM_RUN_ID"],
            "x-rm-case": os.environ["RM_CASE_ID"],
            "x-rm-execution": os.environ["RM_EXECUTION_ID"],
        },
    )


def call_headers(step: str) -> dict[str, str]:
    # Documented correlation-forwarding pattern: execution headers on the client,
    # with step and fresh logical-call identity on each SDK invocation.
    return {"x-rm-step": step, "x-rm-call": str(uuid.uuid4())}


def classify(state: AppState) -> dict[str, object]:
    response = client_from_env().chat.completions.create(
        model=CLASSIFY_MODEL,
        messages=[
            {
                "role": "system",
                "content": "Classify whether the request needs a local order lookup.",
            },
            {"role": "user", "content": state["input"]},
        ],
        extra_headers=call_headers("classify"),
    )
    content = response.choices[0].message.content
    if content is None:
        raise ValueError("classify returned no content")
    digest = content.rsplit(" ", 1)[-1]
    route: Literal["lookup", "answer"] = (
        "lookup" if int(digest[-1], 16) % 2 else "answer"
    )
    return {
        "route": route,
        "classification": content,
        "steps": [*state["steps"], {"step": "classify", "model": CLASSIFY_MODEL, "ok": True}],
    }


def route_after_classify(state: AppState) -> Literal["lookup", "answer"]:
    return state["route"]


def lookup(state: AppState) -> dict[str, object]:
    response = client_from_env().chat.completions.create(
        model=LOOKUP_MODEL,
        messages=[
            {
                "role": "system",
                "content": "Select lookup_order for this request.",
            },
            {"role": "user", "content": state["input"]},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "lookup_order",
                    "description": "Look up a deterministic fixture order.",
                    "parameters": {
                        "type": "object",
                        "properties": {"order_id": {"type": "string"}},
                        "required": ["order_id"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
        tool_choice={"type": "function", "function": {"name": "lookup_order"}},
        extra_headers=call_headers("lookup"),
    )
    if response.choices[0].message.content is None:
        raise ValueError("lookup returned no content")
    order_id = re.search(r"ORD-\d{3}", state["input"])
    if order_id is None:
        raise ValueError("lookup route requires an ORD-NNN order id")
    result = lookup_order(order_id.group())
    return {
        "lookup_result": result,
        "steps": [*state["steps"], {"step": "lookup", "model": LOOKUP_MODEL, "ok": True}],
    }


def answer(state: AppState) -> dict[str, object]:
    context = state["lookup_result"] or "No lookup was needed."
    response = client_from_env().chat.completions.create(
        model=ANSWER_MODEL,
        messages=[
            {
                "role": "system",
                "content": "Compose the final answer from the request and lookup context.",
            },
            {
                "role": "user",
                "content": f"Request: {state['input']}\nLookup: {context}",
            },
        ],
        extra_headers=call_headers("answer"),
    )
    content = response.choices[0].message.content
    if content is None:
        raise ValueError("answer returned no content")
    return {
        "final_output": content,
        "steps": [*state["steps"], {"step": "answer", "model": ANSWER_MODEL, "ok": True}],
    }


def build_graph():
    builder = StateGraph(AppState)
    builder.add_node("classify", classify)
    builder.add_node("lookup", lookup)
    builder.add_node("answer", answer)
    builder.add_edge(START, "classify")
    builder.add_conditional_edges("classify", route_after_classify)
    builder.add_edge("lookup", "answer")
    builder.add_edge("answer", END)
    return builder.compile()


def run_case(case: dict[str, object]) -> dict[str, object]:
    case_id = case.get("caseId")
    case_input = case.get("input")
    if not isinstance(case_id, str) or not isinstance(case_input, str):
        raise ValueError("case JSON must contain string caseId and input fields")
    result = build_graph().invoke(
        {
            "case_id": case_id,
            "input": case_input,
            "route": "answer",
            "classification": "",
            "lookup_result": "",
            "final_output": "",
            "steps": [],
        }
    )
    return {
        "caseId": case_id,
        "finalOutput": result["final_output"],
        "steps": result["steps"],
    }


def start_stub() -> subprocess.Popen[str]:
    stub_path = Path(__file__).resolve().parents[1] / "stub-provider" / "server.mjs"
    program = f"""
import {{ startStubProvider }} from {json.dumps(stub_path.as_uri())};
const stub = await startStubProvider({{ port: 0 }});
console.log(stub.port);
process.on('SIGTERM', async () => {{ await stub.close(); process.exit(0); }});
await new Promise(() => {{}});
"""
    child_env = os.environ.copy()
    child_env.pop("FORCE_COLOR", None)
    process = subprocess.Popen(
        ["node", "--input-type=module", "-e", program],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=child_env,
    )
    assert process.stdout is not None
    port = process.stdout.readline().strip()
    if not port.isdigit():
        process.terminate()
        _, error = process.communicate(timeout=5)
        raise RuntimeError(f"stub did not report a port: {error.strip()}")
    os.environ.update(
        {
            "OPENAI_BASE_URL": f"http://127.0.0.1:{port}/v1",
            "OPENAI_API_KEY": "fixture-placeholder",
            "RM_RUN_ID": "selftest-run",
            "RM_CASE_ID": "langgraph-tool-01",
            "RM_EXECUTION_ID": "selftest-execution",
        }
    )
    return process


def selftest() -> None:
    stub = start_stub()
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".json") as case_file:
            json.dump({"caseId": "langgraph-tool-01", "input": TOOL_CASE_INPUT}, case_file)
            case_file.flush()
            case = json.loads(Path(case_file.name).read_text())
        envelope = run_case(case)
        assert envelope["caseId"] == "langgraph-tool-01"
        assert isinstance(envelope["finalOutput"], str) and envelope["finalOutput"]
        assert [step["step"] for step in envelope["steps"]] == [
            "classify",
            "lookup",
            "answer",
        ]
        assert all(step["ok"] is True for step in envelope["steps"])
        print("ok")
    finally:
        stub.terminate()
        stub.wait(timeout=5)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--case-json", type=Path)
    group.add_argument("--selftest", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.selftest:
        selftest()
        return
    case = json.loads(args.case_json.read_text())
    print(json.dumps(run_case(case), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
