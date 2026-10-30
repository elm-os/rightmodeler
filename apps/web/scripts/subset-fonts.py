# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "fonttools[woff]==4.67.0",
#   "brotli==1.2.0",
#   "opentype-sanitizer==9.2.0",
#   "uharfbuzz==0.56.3",
# ]
# ///
"""Builds the site's web fonts. Run by hand from the repository root, then commit the output:

    uv run apps/web/scripts/subset-fonts.py

The sources are the Google Fonts files next/font/google served before the fonts were self-hosted,
pinned by URL and sha256, so the output draws exactly what they drew. Each family is cut to the
weights, features and characters the site uses: a preloaded core file, plus Latin-1 and Latin
Extended-A files that load only for characters in their unicode-range. Writes public/fonts/,
src/app/fonts.css and src/lib/fonts.ts, and refuses to write anything that fails its checks.

Edit FONTS and rerun when the site starts setting these fonts differently: a character outside a
family's core, a weight outside its "weights", an OpenType feature it does not keep, DM Sans or
Space Grotesk without letter-spacing, hyphens: auto, or a font update. docs/design.md (Font files)
says what to change for each.
"""

import hashlib
import io
import json
import tempfile
import urllib.request
from itertools import product
from pathlib import Path

import ots
import uharfbuzz as hb
from fontTools import subset
from fontTools.misc.fixedTools import floatToFixedToFloat
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.TupleVariation import TupleVariation
from fontTools.varLib import instancer
from fontTools.varLib.models import piecewiseLinearMap

WEB = Path(__file__).resolve().parent.parent
FONTS_DIR = WEB / "public" / "fonts"
CSS_FILE = WEB / "src" / "app" / "fonts.css"
TS_FILE = WEB / "src" / "lib" / "fonts.ts"
GSTATIC = "https://fonts.gstatic.com/s"

ASCII = set(range(0x20, 0x7F))
LATIN_1 = set(range(0xA0, 0x100))
LATIN_EXT_A = set(range(0x100, 0x180))
# The Latin Extended-A characters Google served from its latin file; the rest came from latin-ext.
LATIN_EXT_A_IN_LATIN = {0x131, 0x152, 0x153}
# No-break space, soft hyphen, curly quotes, en and em dashes, ellipsis. The soft hyphen never draws
# its own glyph; it sits here so it cannot pull in an extended file.
CORE_PUNCTUATION = {0xA0, 0xAD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2026}
HINTING_TABLES = {"fpgm", "prep", "cvt ", "cvar", "hdmx", "VDMX", "LTSH"}

# In preload order. "weights" are the weights the site sets; "range" cuts the wght axis to their
# span, widened to the nearest master so no delta is recomputed, or pins it when the site uses one
# weight (pinning rounds outlines to whole font units). "features" are the OpenType features
# the site turns on: Chrome switches liga, clig and calt off for letter-spaced text, and every DM
# Sans and Space Grotesk element is letter-spaced. Fallback metrics are next/font/google's.
FONTS = [
    {
        "family": "Space Grotesk",
        "slug": "space-grotesk",
        "latin": ("spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4C_k3HqU.woff2", "a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557"),
        "latin_ext": ("spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPb94C_k3HqUtEw.woff2", "054c266fbb441ee059365dba0885d206f67ca05b375de869b88e02ebfccc9b9d"),
        "weights": (700,),
        "range": 700,
        "features": ["kern"],
        "letter_spaced": True,
        "core": set(),
        "fallback": ("89.71%", "26.62%", "0%", "109.69%"),
    },
    {
        "family": "DM Sans",
        "slug": "dm-sans",
        "latin": ("dmsans/v17/rP2Yp2ywxg089UriI5-g4vlH9VoD8Cmcqbu0-K6z9mXg.woff2", "468d56b6b25b05b70190b6c233d773f6f1770e8579827ce022a57f03fa8002fb"),
        "latin_ext": ("dmsans/v17/rP2Yp2ywxg089UriI5-g4vlH9VoD8Cmcqbu6-K6z9mXgjU0.woff2", "219b02c7d8884817d3d6ad4c8771f2c000ce4c5669a67ef4e2e5617ffa25c4cc"),
        "weights": (300, 400),
        "range": (300, 400),
        "features": ["kern"],
        "letter_spaced": True,
        "core": set(),
        "fallback": ("94.9%", "29.66%", "0%", "104.53%"),
    },
    {
        "family": "Geist Mono",
        "slug": "geist-mono",
        "latin": ("geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrcdmhHkjko.woff2", "5f3d6ad60f29d6cb708414ec6887163d63bf197377ef5417d2483ff31ace6c3b"),
        "latin_ext": ("geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrkdmhHkjkotbA.woff2", "745994b5cd950ec201b66526375f057d540847cccfc70f4f24f5f571d26d3923"),
        "weights": (400, 500),
        "range": (400, 900),
        "features": [],
        "letter_spaced": False,
        "core": {0xA9, 0xB7, 0xD7},
        "fallback": ("74.67%", "21.92%", "0%", "134.59%"),
    },
    {
        "family": "Inter",
        "slug": "inter",
        "latin": ("inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2", "c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4"),
        "latin_ext": ("inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7W0Q5n-wU.woff2", "a28eb6d3ccb534ae0c94ca999371df024aab60b08c3c8a5720ee9e32fa0faaa2"),
        "weights": (400, 500),
        "range": (400, 900),
        "features": ["calt", "kern", "tnum"],
        "letter_spaced": False,
        "core": {0xB7},
        "fallback": ("90.44%", "22.52%", "0%", "107.12%"),
    },
]


def fetch(path: str, sha256: str) -> bytes:
    with urllib.request.urlopen(f"{GSTATIC}/{path}") as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != sha256:
        raise SystemExit(f"{path}: sha256 mismatch, the pinned source changed")
    return data


def normalized(font: TTFont, value: float) -> float:
    axis = next(a for a in font["fvar"].axes if a.axisTag == "wght")
    if value == axis.defaultValue:
        return 0.0
    span = axis.defaultValue - axis.minValue if value < axis.defaultValue else axis.maxValue - axis.defaultValue
    n = floatToFixedToFloat((value - axis.defaultValue) / span, 14)
    if "avar" in font:
        n = floatToFixedToFloat(piecewiseLinearMap(n, font["avar"].segments["wght"]), 14)
    return n


def scalar(tent: tuple, n: float) -> float:
    start, peak, end = tent
    if n == peak:
        return 1.0
    if n <= start or n >= end:
        return 0.0
    return (n - start) / (peak - start) if n < peak else (end - n) / (end - peak)


def rebase(tent: tuple, low: float, high: float) -> tuple | None:
    start, peak, end = tent
    if not low <= peak <= high:
        if scalar(tent, low) or scalar(tent, high):
            raise SystemExit(f"region {tent} is cut by the weight range; widen the range to a master")
        return None
    if (start < low and peak != low) or (end > high and peak != high):
        raise SystemExit(f"region {tent} is cut by the weight range; widen the range to a master")

    def scale(n: float) -> float:
        return n / -low if n < 0 else n / high if n > 0 else 0.0

    return (scale(max(start, low)), scale(peak), scale(min(end, high)))


def cut(source: TTFont, weights: tuple | int) -> TTFont:
    """Narrows or pins the wght axis. The instancer rounds every delta set it touches, so after a
    narrowing the source's deltas are put back unchanged on the rebased regions."""
    if isinstance(weights, int):
        return instancer.instantiateVariableFont(source, {"wght": weights})
    font = instancer.instantiateVariableFont(TTFont(io.BytesIO(save(source))), {"wght": weights}, optimize=False)
    low, high = normalized(source, weights[0]), normalized(source, weights[1])
    for glyph, variations in source["gvar"].variations.items():
        font["gvar"].variations[glyph] = [
            TupleVariation({"wght": tent}, tv.coordinates)
            for tv in variations
            if any(c not in (None, (0, 0)) for c in tv.coordinates)
            and (tent := rebase(tv.axes["wght"], low, high)) is not None
        ]
    font["fvar"].instances = []
    return font


def save(font: TTFont, flavor: str | None = None) -> bytes:
    out = io.BytesIO()
    font.flavor = flavor
    font.recalcTimestamp = False
    font.save(out)
    return out.getvalue()


def bounds(font: TTFont) -> tuple:
    return tuple(getattr(font["head"], a) for a in ("xMin", "yMin", "xMax", "yMax"))


def build(font: TTFont, chars: set[int], features: list[str], bbox: tuple) -> bytes:
    options = subset.Options()
    options.layout_features = features
    options.layout_scripts = ["DFLT", "latn"]
    options.hinting = False
    # Without glyph names (post format 3) macOS draws text differently at 1x.
    options.glyph_names = True
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_languages = [0x409]
    options.drop_tables += ["STAT"]
    options.recalc_timestamp = False
    font = TTFont(io.BytesIO(save(font)), recalcTimestamp=False)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=chars)
    subsetter.subset(font)
    # macOS draws small text relative to the font's bounding box, so it keeps the source's.
    font["head"].xMin, font["head"].yMin, font["head"].xMax, font["head"].yMax = bbox
    font.recalcBBoxes = False
    return save(font, "woff2")


def harfbuzz(data: bytes) -> hb.Face:
    return hb.Face(hb.Blob(save(TTFont(io.BytesIO(data)))))


def shaped(face: hb.Face, text: str, weight: float, features: dict) -> list:
    font = hb.Font(face)
    font.scale = (face.upem * 64, face.upem * 64)
    if face.has_var_data:
        font.set_variations({"wght": weight})
    buffer = hb.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    buffer.language = "en"
    hb.shape(font, buffer, features)
    glyphs = []
    for info, pos in zip(buffer.glyph_infos, buffer.glyph_positions):
        pen = RecordingPen()
        font.draw_glyph_with_pen(info.codepoint, pen)
        points = [c for _, args in pen.value for point in args for c in point]
        glyphs.append(([op for op, _ in pen.value], points, (pos.x_advance, pos.x_offset, pos.y_offset)))
    return glyphs


def same(ours: list, theirs: list, tolerance: float) -> bool:
    return len(ours) == len(theirs) and all(
        a[0] == b[0] and a[2] == b[2] and len(a[1]) == len(b[1]) and all(abs(x - y) <= tolerance for x, y in zip(a[1], b[1]))
        for a, b in zip(ours, theirs)
    )


def check(data: bytes, source: bytes, chars: set[int], spec: dict, name: str) -> None:
    font = TTFont(io.BytesIO(data))
    problems = []
    if set(font.getBestCmap()) != chars:
        problems.append("cmap differs from the requested characters")
    if bounds(font) != bounds(TTFont(io.BytesIO(source))):
        problems.append("bounding box differs from the source's")
    if HINTING_TABLES & set(font.keys()):
        problems.append(f"hinting tables left: {sorted(HINTING_TABLES & set(font.keys()))}")
    kept = {r.FeatureTag for tag in ("GSUB", "GPOS") if tag in font and font[tag].table.FeatureList for r in font[tag].table.FeatureList.FeatureRecord}
    if not kept <= set(spec["features"]):
        problems.append(f"unexpected features: {sorted(kept - set(spec['features']))}")
    pinned = isinstance(spec["range"], int)
    axes = {(a.axisTag, a.minValue, a.maxValue) for a in font["fvar"].axes} if "fvar" in font else set()
    if axes != (set() if pinned else {("wght", *spec["range"])}):
        problems.append(f"axes are {axes}, expected {spec['range']}")
    # Every glyph, advance and pair must shape as it did from the source, with Chrome's features.
    # Pinning rounds outline points to whole font units, so a pinned font may be off by half a unit.
    tolerance = 32 if pinned else 0
    spaced = {"liga": False, "clig": False, "calt": False}
    states = [spaced] if spec["letter_spaced"] else [{}, spaced]
    if "tnum" in spec["features"]:
        states += [{**state, "tnum": True} for state in states]
    ours, theirs = harfbuzz(data), harfbuzz(source)
    texts = [chr(a) + chr(b) for a, b in product(sorted(chars), repeat=2)]
    for weight, state, text in product(spec["weights"], states, texts):
        if not same(shaped(ours, text, weight, state), shaped(theirs, text, weight, state), tolerance):
            problems.append(f"{text!r} at {weight} with {state} shapes differently from the source")
            break
    with tempfile.NamedTemporaryFile(suffix=".woff2") as tmp:
        tmp.write(data)
        tmp.flush()
        result = ots.sanitize(tmp.name, capture_output=True)
        if result.returncode != 0:
            problems.append(f"OTS rejects it: {result.stderr.decode().strip()}")
    if problems:
        raise SystemExit(f"{name}: " + "; ".join(problems))


def declaration(prop: str, value: str) -> str:
    """One CSS declaration, wrapped the way Prettier wraps it at 80 columns."""
    line = f"  {prop}: {value};"
    if len(line) <= 80:
        return line + "\n"
    lines, current = [], ""
    for item in value.split(", "):
        if current and len(current) + len(item) + 2 > 80:
            lines.append(current)
            current = ""
        current = f"{current} {item}," if current else f"    {item},"
    lines.append(current[:-1] + ";")
    return f"  {prop}:\n" + "\n".join(lines) + "\n"


def unicode_range(codepoints: set[int]) -> str:
    runs, ordered = [], sorted(codepoints)
    start = prev = ordered[0]
    for cp in ordered[1:] + [None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        runs.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
        if cp is not None:
            start = prev = cp
    return ", ".join(runs)


def main() -> None:
    files, faces, fallbacks, variables, preloads = {}, [], [], [], []
    for spec in FONTS:
        latin, latin_ext = fetch(*spec["latin"]), fetch(*spec["latin_ext"])
        latin_cut = cut(TTFont(io.BytesIO(latin)), spec["range"])
        latin_ext_cut = cut(TTFont(io.BytesIO(latin_ext)), spec["range"])
        in_latin, in_latin_ext = set(latin_cut.getBestCmap()), set(latin_ext_cut.getBestCmap())
        core = (ASCII | CORE_PUNCTUATION | spec["core"]) & in_latin
        latin_1 = (LATIN_1 | LATIN_EXT_A_IN_LATIN) & in_latin - core
        extended = LATIN_EXT_A & in_latin_ext - core - latin_1
        weight = spec["range"] if isinstance(spec["range"], int) else f"{spec['range'][0]} {spec['range'][1]}"
        # Chrome consults the last-declared face first, so the core goes last, as in Google's CSS.
        for part, font, source, chars in (
            ("latin-ext", latin_ext_cut, latin_ext, extended),
            ("latin-1", latin_cut, latin, latin_1),
            ("core", latin_cut, latin, core),
        ):
            data = build(font, chars, spec["features"], bounds(TTFont(io.BytesIO(source))))
            name = f"{spec['slug']}-{part}.{hashlib.sha256(data).hexdigest()[:10]}.woff2"
            check(data, source, chars, spec, name)
            files[name] = data
            faces.append(
                "@font-face {\n"
                f'  font-family: "{spec["family"]}";\n'
                "  font-style: normal;\n"
                f"  font-weight: {weight};\n"
                "  font-display: swap;\n"
                + declaration("src", f'url("/fonts/{name}") format("woff2")')
                + declaration("unicode-range", unicode_range(chars))
                + "}\n"
            )
            if part == "core":
                preloads.append(f"/fonts/{name}")
            print(f"{name:40} {len(data):6} bytes  {len(chars):3} characters")
        ascent, descent, line_gap, size = spec["fallback"]
        fallbacks.append(
            "@font-face {\n"
            f'  font-family: "{spec["family"]} Fallback";\n'
            '  src: local("Arial");\n'
            f"  ascent-override: {ascent};\n"
            f"  descent-override: {descent};\n"
            f"  line-gap-override: {line_gap};\n"
            f"  size-adjust: {size};\n"
            "}\n"
        )
        variables.append(f'  --font-{spec["slug"]}: "{spec["family"]}", "{spec["family"]} Fallback";\n')
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    for stale in FONTS_DIR.glob("*.woff2"):
        if stale.name not in files:
            stale.unlink()
    for name, data in files.items():
        (FONTS_DIR / name).write_bytes(data)
    CSS_FILE.write_text(
        "/* Generated by scripts/subset-fonts.py. Do not edit. */\n"
        + "\n".join(faces + fallbacks)
        + "\n:root {\n"
        + "".join(variables)
        + "}\n"
    )
    TS_FILE.write_text(
        "// Generated by scripts/subset-fonts.py. Do not edit.\n"
        "export const fontPreloads = [\n" + "".join(f"  {json.dumps(href)},\n" for href in preloads) + "];\n"
    )


if __name__ == "__main__":
    main()
