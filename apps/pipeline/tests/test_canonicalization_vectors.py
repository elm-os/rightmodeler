"""Cross-language RFC 8785 vectors for the legacy corpus digest boundary."""

import hashlib
import json
from pathlib import Path

import pytest

from pipeline.corpus import canonical_json


VECTORS_PATH = (
    Path(__file__).resolve().parents[3]
    / "harness"
    / "fixtures"
    / "canonicalization"
    / "rfc8785-vectors.json"
)
VECTORS = json.loads(VECTORS_PATH.read_text())
PYTHON_DIVERGENCES = {
    "exponent-switch": "Python uses exponent notation at 1e20 instead of the RFC 8785 fixed form",
    "negative-zero": "Python preserves the negative-zero sign",
    "small-number-switch": "Python uses exponent notation at the RFC 8785 fixed-form boundary",
    "utf8-strings": "Python escapes non-ASCII characters instead of emitting RFC 8785 UTF-8",
    "control-characters": "Python escapes DEL instead of emitting the RFC 8785 byte",
    "utf16-key-ordering": "Python sorts astral keys by code point instead of UTF-16 code units",
}


PARAMETERS = [
    pytest.param(
        vector,
        marks=pytest.mark.xfail(
            strict=True,
            reason=PYTHON_DIVERGENCES[vector["name"]],
        ),
    )
    if vector["name"] in PYTHON_DIVERGENCES
    else vector
    for vector in VECTORS
]


@pytest.mark.parametrize("vector", PARAMETERS, ids=lambda vector: vector["name"])
def test_corpus_canonicalization_matches_rfc8785_vectors(vector):
    expected = vector["canonical"].encode("utf-8")
    actual = canonical_json(vector["value"]).encode("utf-8")
    actual_digest = hashlib.sha256(actual).hexdigest()

    assert actual == expected
    assert actual_digest == vector["sha256"]
