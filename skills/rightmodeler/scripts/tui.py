"""Interactive per-step approval TUI for cheaper-model recommendations.

Textual app: a table of pipeline steps with the best cheaper candidate, cost delta,
quality score, evidence type, and a cascade-risk flag. Approve / reject / hold each
swap; the detail pane shows the candidate output and judge justification. On save,
writes decisions.json next to results.json.

Keys:
  a approve   r reject   h hold   e mark-needs-E2E   enter details   s save   q quit

CLI:
    python tui.py results.json
Fallback (no TTY / textual missing): prints a Rich table summary instead.
"""

from __future__ import annotations

import argparse
import os
import sys

from common import load_json, dump_json


DECISION_STYLE = {
    "approved": ("✔ approved", "bold green"),
    "rejected": ("✘ rejected", "bold red"),
    "hold": ("… hold", "yellow"),
    "needs_e2e": ("⚙ E2E", "cyan"),
    "proposed": ("· proposed", "dim"),
}


def _rows(results: dict) -> list[dict]:
    rows = []
    for s in results["steps"]:
        best = s.get("best")
        if s.get("abstain"):
            default = "rejected"
        elif s.get("needs_e2e"):
            default = "needs_e2e"
        elif best:
            default = "proposed"
        else:
            default = "rejected"
        rows.append(
            {
                "step_id": s["step_id"],
                "name": s.get("name") or s["step_id"],
                "family": s.get("family", ""),
                "current": s.get("current_model") or "—",
                "candidate": (best or {}).get("model")
                or (
                    (s.get("candidates") or [{}])[0].get("id")
                    or (s.get("candidates") or [{}])[0].get("model")
                    or "—"
                ),
                "savings": (best or {}).get("est_savings"),
                "score": (best or {}).get("score"),
                "verdict": (best or {}).get("verdict", ""),
                "evidence": s.get("evaluator", ""),
                "risk": s.get("risk", "normal"),
                "cascade": s.get("needs_e2e", False),
                "justification": (best or {}).get("justification")
                or s.get("note")
                or s.get("abstain_reason")
                or "",
                "candidate_output": (best or {}).get("candidate_output", ""),
                "decision": default,
            }
        )
    return rows


def _fmt_pct(v):
    return f"{v:.0%}" if isinstance(v, (int, float)) else "—"


def _fmt_score(v):
    return f"{v:.2f}" if isinstance(v, (int, float)) else "—"


def run_rich_fallback(results: dict, rows: list[dict]) -> int:
    from rich.console import Console
    from rich.table import Table

    c = Console()
    t = Table(title="rightmodeler - recommendations (read-only; no TTY for interactive TUI)")
    for col in ("Step", "Family", "Current", "→ Candidate", "Save", "Quality", "Evidence", "Flag"):
        t.add_column(col, overflow="fold")
    for r in rows:
        flag = "CASCADE-E2E" if r["cascade"] else ("HIGH-RISK" if r["risk"] == "high" else "")
        t.add_row(
            r["name"],
            r["family"],
            r["current"],
            r["candidate"],
            _fmt_pct(r["savings"]),
            _fmt_score(r["score"]),
            r["evidence"],
            flag,
        )
    c.print(t)
    swappable = sum(1 for r in rows if r["score"] and not r["cascade"])
    c.print(
        f"[bold]Swappable single-shot:[/] {swappable}   "
        f"[cyan]needs E2E:[/] {sum(1 for r in rows if r['cascade'])}   "
        f"[dim]run in a real terminal for the interactive approval TUI[/]"
    )
    return 0


def run_snapshot_fallback(snapshot: dict) -> int:
    from rich.console import Console
    from rich.table import Table

    console = Console()
    table = Table(title="rightmodeler benchmark gates (read-only)")
    for column in ("Gate", "Status", "Observed", "Threshold", "Evidence"):
        table.add_column(column, overflow="fold")
    for gate in snapshot["gates"]:
        table.add_row(
            gate["id"],
            gate["status"],
            str(gate["observed"] if gate["observed"] is not None else "n/a"),
            str(gate["threshold"] if gate["threshold"] is not None else "n/a"),
            ", ".join(gate["evidence_refs"]) or "none",
        )
    console.print(table)
    console.print(
        f"snapshot {snapshot['snapshot_id']}  "
        f"coverage {snapshot['summary']['coverage']:.0%}  "
        f"timing {snapshot['timing']['availability']}"
    )
    return 0


def run_textual(results: dict, rows: list[dict], out_path: str) -> int:
    from textual.app import App, ComposeResult
    from textual.containers import Horizontal
    from textual.coordinate import Coordinate
    from textual.widgets import DataTable, Footer, Header, Static
    from rich.text import Text

    class Detail(Static):
        pass

    class ApprovalApp(App):
        CSS = """
        Screen { layout: vertical; }
        #main { height: 1fr; }
        DataTable { width: 3fr; height: 1fr; }
        #detail { width: 2fr; height: 1fr; border-left: solid $accent; padding: 1 2; }
        #summary { height: auto; dock: bottom; background: $panel; padding: 0 1; }
        """
        BINDINGS = [
            ("a", "decide('approved')", "Approve"),
            ("r", "decide('rejected')", "Reject"),
            ("h", "decide('hold')", "Hold"),
            ("e", "decide('needs_e2e')", "Needs E2E"),
            ("s", "save", "Save"),
            ("q", "quit", "Quit"),
        ]

        def __init__(self):
            super().__init__()
            self.rows = rows

        def compose(self) -> ComposeResult:
            yield Header(show_clock=False)
            with Horizontal(id="main"):
                yield DataTable(id="table", cursor_type="row", zebra_stripes=True)
                yield Detail("Select a step…", id="detail")
            yield Static(id="summary")
            yield Footer()

        def on_mount(self):
            self.title = "rightmodeler · per-step approval"
            table = self.query_one(DataTable)
            table.add_columns(
                "", "Step", "Family", "Current → Candidate", "Save", "Quality", "Evidence", "Flag"
            )
            for i, r in enumerate(self.rows):
                table.add_row(*self._render_row(r), key=str(i))
            self._ncols = 8
            table.focus()
            self._refresh_summary()
            self._show_detail(0)

        def _render_row(self, r):
            label, style = DECISION_STYLE[r["decision"]]
            flag = ""
            if r["cascade"]:
                flag = Text("CASCADE", style="bold cyan")
            elif r["risk"] == "high":
                flag = Text("HIGH-RISK", style="bold red")
            swap = f"{r['current']} → {r['candidate']}"
            return (
                Text(label, style=style),
                r["name"],
                r["family"],
                swap,
                _fmt_pct(r["savings"]),
                _fmt_score(r["score"]),
                r["evidence"],
                flag,
            )

        def _current_index(self) -> int:
            table = self.query_one(DataTable)
            return table.cursor_row if table.cursor_row is not None else 0

        def _show_detail(self, idx: int):
            r = self.rows[idx]
            d = self.query_one("#detail", Static)
            body = Text()
            body.append(f"{r['name']}  ", style="bold")
            body.append(f"[{r['family']}]\n\n", style="dim")
            body.append(f"current:   {r['current']}\n")
            body.append(f"candidate: {r['candidate']}\n")
            body.append(
                f"savings:   {_fmt_pct(r['savings'])}    quality: {_fmt_score(r['score'])} "
                f"({r['verdict']})\n"
            )
            body.append(f"evidence:  {r['evidence']}    risk: {r['risk']}\n")
            if r["cascade"]:
                body.append(
                    "\n⚙ multi-step/tool/loop — confirm with run_pipeline.py "
                    "before swapping (cascade risk)\n",
                    style="cyan",
                )
            body.append("\njudge / note:\n", style="bold")
            body.append((r["justification"] or "—") + "\n")
            if r["candidate_output"]:
                body.append("\ncandidate output (truncated):\n", style="bold")
                body.append(r["candidate_output"][:1200] + "\n", style="dim")
            d.update(body)

        def on_data_table_row_highlighted(self, event):
            try:
                self._show_detail(int(event.row_key.value))
            except (TypeError, ValueError):
                pass

        def action_decide(self, decision: str):
            idx = self._current_index()
            self.rows[idx]["decision"] = decision
            table = self.query_one(DataTable)
            for col, cell in enumerate(self._render_row(self.rows[idx])):
                table.update_cell_at(Coordinate(idx, col), cell)
            self._refresh_summary()

        def _refresh_summary(self):
            approved = [r for r in self.rows if r["decision"] == "approved"]
            savings = [r["savings"] for r in approved if isinstance(r["savings"], (int, float))]
            avg = sum(savings) / len(savings) if savings else 0
            s = self.query_one("#summary", Static)
            s.update(
                Text.from_markup(
                    f"[green]approved {len(approved)}[/]  "
                    f"[yellow]hold {sum(1 for r in self.rows if r['decision'] == 'hold')}[/]  "
                    f"[red]rejected {sum(1 for r in self.rows if r['decision'] == 'rejected')}[/]  "
                    f"[cyan]E2E {sum(1 for r in self.rows if r['decision'] == 'needs_e2e')}[/]   "
                    f"avg savings on approved: [bold]{avg:.0%}[/]   "
                    f"[dim](a)pprove (r)eject (h)old (e)2e (s)ave (q)uit[/]"
                )
            )

        def action_save(self):
            decisions = {r["step_id"]: r["decision"] for r in self.rows}
            dump_json(decisions, out_path)
            self.notify(f"saved {out_path}", severity="information")

        def action_quit(self):
            self.action_save()
            self.exit()

    ApprovalApp().run()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results", nargs="?")
    ap.add_argument("--snapshot")
    ap.add_argument("--out")
    args = ap.parse_args()

    if args.snapshot:
        return run_snapshot_fallback(load_json(args.snapshot))
    if not args.results:
        ap.error("provide results or --snapshot")

    results = load_json(args.results)
    rows = _rows(results)
    out_path = args.out or os.path.join(os.path.dirname(args.results) or ".", "decisions.json")

    interactive = sys.stdout.isatty() and sys.stdin.isatty()
    if interactive:
        try:
            return run_textual(results, rows, out_path)
        except Exception as e:  # noqa: BLE001
            print(f"[tui] textual failed ({e}); falling back to summary", file=sys.stderr)
    return run_rich_fallback(results, rows)


if __name__ == "__main__":
    raise SystemExit(main())
