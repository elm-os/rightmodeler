from __future__ import annotations

import argparse
import json
import os
import re
import selectors
import subprocess
import uuid
from functools import cache
from pathlib import Path
from typing import Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from openai import OpenAI


CLASSIFY_MODEL = "acme/large-1"
LOOKUP_MODEL = "acme/max-1"
ANSWER_MODEL = "acme/large-1"
TOOL_CASE_INPUT = "Where is order ORD-104?"
CLASSIFY_SWAP_MARKER = "classify-swapped"
LOOKUP_SWAP_MARKER = "lookup-swapped"
INTERACTION_FAILURE = "The order lookup result could not be verified."


class Step(TypedDict):
    step: str
    model: str
    ok: bool


class AppState(TypedDict):
    case_id: str
    input: str
    headers: dict[str, str]
    route: Literal["lookup", "answer"]
    classification: str
    lookup_result: str
    final_output: str
    swap_markers: list[str]
    steps: list[Step]


def lookup_order(order_id: str) -> str:
    return json.dumps(
        {"orderId": order_id, "status": "in transit", "etaDays": 2},
        separators=(",", ":"),
    )


@cache
def create_client(base_url: str, api_key: str) -> OpenAI:
    return OpenAI(
        base_url=base_url,
        api_key=api_key,
    )


def client_from_env() -> OpenAI:
    return create_client(
        os.environ["OPENAI_BASE_URL"],
        os.environ["OPENAI_API_KEY"],
    )


def call_headers(
    step: str, case_id: str, injected: dict[str, str]
) -> dict[str, str]:
    # Documented correlation-forwarding pattern: execution headers on the client,
    # with step and fresh logical-call identity on each SDK invocation.
    forwarded = dict(injected)
    stall_ms = forwarded.pop("x-fault-stall", None)
    if stall_ms is not None:
        forwarded["x-stub-hold-before-response-ms"] = stall_ms
    return {
        **forwarded,
        "x-rm-run": os.environ["RM_RUN_ID"],
        "x-rm-case": case_id,
        "x-rm-execution": os.environ["RM_EXECUTION_ID"],
        "x-rm-step": step,
        "x-rm-call": str(uuid.uuid4()),
    }


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
        max_tokens=256,
        extra_headers=call_headers("classify", state["case_id"], state["headers"]),
    )
    content = response.choices[0].message.content
    if content is None:
        raise ValueError("classify returned no content")
    digest = re.search(r"([0-9a-f]{16})$", content)
    route: Literal["lookup", "answer"] = "answer"
    if digest is not None and int(digest.group(1)[-1], 16) % 2:
        route = "lookup"
    return {
        "route": route,
        "classification": content,
        "swap_markers": [
            *state["swap_markers"],
            *(
                [CLASSIFY_SWAP_MARKER]
                if response.model != CLASSIFY_MODEL
                else []
            ),
        ],
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
        max_tokens=256,
        extra_headers=call_headers("lookup", state["case_id"], state["headers"]),
    )
    message = response.choices[0].message
    input_order_id = re.search(r"ORD-\d{3}", state["input"])
    order_id = input_order_id.group() if input_order_id is not None else "ORD-000"
    if message.tool_calls:
        tool_call = message.tool_calls[0]
        if tool_call.type != "function" or tool_call.function.name != "lookup_order":
            raise ValueError("lookup did not select lookup_order")
        arguments = json.loads(tool_call.function.arguments)
        selected_order_id = arguments.get("order_id")
        if isinstance(selected_order_id, str):
            order_id = selected_order_id
    elif re.fullmatch(r"Deterministic reply [0-9a-f]{16}", message.content or "") is None:
        raise ValueError("lookup did not select lookup_order")
    result = lookup_order(order_id)
    return {
        "lookup_result": result,
        "swap_markers": [
            *state["swap_markers"],
            *(
                [LOOKUP_SWAP_MARKER]
                if response.model != LOOKUP_MODEL
                else []
            ),
        ],
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
        max_tokens=256,
        extra_headers=call_headers("answer", state["case_id"], state["headers"]),
    )
    content = response.choices[0].message.content
    if content is None:
        raise ValueError("answer returned no content")
    if {
        CLASSIFY_SWAP_MARKER,
        LOOKUP_SWAP_MARKER,
    }.issubset(state["swap_markers"]):
        content = INTERACTION_FAILURE
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
    case_headers = case.get("headers", {})
    if not isinstance(case_headers, dict) or not all(
        isinstance(name, str) and isinstance(value, str)
        for name, value in case_headers.items()
    ):
        raise ValueError("case JSON headers must map strings to strings")
    result = build_graph().invoke(
        {
            "case_id": case_id,
            "input": case_input,
            "headers": case_headers,
            "route": "answer",
            "classification": "",
            "lookup_result": "",
            "final_output": "",
            "swap_markers": [],
            "steps": [],
        }
    )
    return {
        "runId": os.environ["RM_RUN_ID"],
        "caseId": case_id,
        "executionId": os.environ["RM_EXECUTION_ID"],
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
    stdout = process.stdout
    selector = selectors.DefaultSelector()
    selector.register(stdout, selectors.EVENT_READ)
    ready = selector.select(timeout=5)
    selector.close()
    port = stdout.readline().strip() if ready else ""
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
        cases = [
            {"caseId": "langgraph-tool-01", "input": TOOL_CASE_INPUT},
            {
                "caseId": "langgraph-fallback-01",
                "input": "Summarize the refund policy.",
            },
            {
                "caseId": "langgraph-direct-01",
                "input": "Do you offer weekend support?",
            },
        ]
        first = [run_case(case) for case in cases]
        second = [run_case(case) for case in cases]
        if first != second:
            raise AssertionError("fixture envelopes changed between identical runs")
        expected = [
            ("langgraph-tool-01", "Deterministic reply 81d067ab44f20e70", 3),
            ("langgraph-fallback-01", "Deterministic reply 16d01727aac92f26", 3),
            ("langgraph-direct-01", "Deterministic reply 63e396df1afcd7db", 2),
        ]
        for envelope, (case_id, final_output, step_count) in zip(first, expected):
            if envelope["caseId"] != case_id:
                raise AssertionError(f"unexpected case id for {case_id}")
            if envelope["finalOutput"] != final_output:
                raise AssertionError(f"unexpected final output for {case_id}")
            if len(envelope["steps"]) != step_count:
                raise AssertionError(f"unexpected route length for {case_id}")
            if not all(step["ok"] is True for step in envelope["steps"]):
                raise AssertionError(f"failed step for {case_id}")
        print(json.dumps(first, separators=(",", ":"), sort_keys=True))
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
    main()
