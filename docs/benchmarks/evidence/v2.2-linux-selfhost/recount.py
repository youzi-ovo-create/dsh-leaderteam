"""Recompute the delivery-window totals from the archived LT v2.2 run."""
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

run_dir = Path(sys.argv[1])
raw = run_dir / "raw-redacted"
team = raw / "leaderteam-team"


def rows(path):
    with path.open(encoding="utf-8") as file:
        return [json.loads(line) for line in file if line.strip()]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


sessions = read_json(raw / "sessions-summary.json")
members = [row for row in rows(team / "members.jsonl") if row["type"] == "member"]
messages = [message for session in sessions for message in session["assistantMessages"]]
requests = rows(raw / "request-window-calls.jsonl")
auxiliary = rows(team / "usage.jsonl")
summary = read_json(run_dir / "v23-structured-metrics.json")

message_models = Counter(message["model"] for message in messages)
assert message_models == Counter(row["route"] for row in requests)
models = message_models + Counter(row["route"] for row in auxiliary)
tokens = Counter()
fields = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens"]
for row in messages + auxiliary:
    tokens.update({key: row["usage"].get(key, 0) for key in fields})
counts = {"calls": len(messages) + len(auxiliary), **tokens}
assert counts == summary["grandTotals"]
assert models == {route: usage["calls"] for route, usage in summary["models"].items()}
assert sum(tokens[key] for key in fields[:-1]) == tokens["totalTokens"]

turns = read_json(raw / "deep-session-forensics.json")["leaderTurns"]
window = [t for t in turns if 7 <= t["turn"] <= 13]
assert len(window) == 7
for turn in window:
    assert {m["sourceKind"] for m in turn["triggerMessages"]} == {"leaderteam-scheduler"}
    assert {"team_dispatch", "team_direct_exec"}.isdisjoint(turn["toolCalls"])
human_triggers = [
    {"turn": turn["turn"], "sequence": message["seq"]}
    for turn in turns for message in turn["triggerMessages"] if message["sourceKind"] == "user"
]
gates = rows(team / "gate.jsonl")
reviews = [r for r in rows(team / "governance.jsonl") if r["type"] == "supervision-completed"]
start = datetime.fromisoformat(summary["promptSubmittedAt"].replace("Z", "+00:00"))
finish = datetime.fromisoformat(summary["settledAt"].replace("Z", "+00:00"))
result = {
    "promptSubmittedAt": start.isoformat(),
    "settledAt": finish.isoformat(),
    "wallClockSeconds": (finish - start).total_seconds(),
    "archivedLeaderHumanTriggers": human_triggers,
    "sessions": len(sessions),
    "childrenByRole": Counter(m.get("actorRole", "member") for m in members),
    "sessionRequestsByRole": Counter(row["role"] for row in requests),
    "auxiliaryRequestsByRole": Counter(row["role"] for row in auxiliary),
    "totals": counts,
    "inputCacheReadFraction": tokens["cacheReadTokens"] / (tokens["inputTokens"] + tokens["cacheReadTokens"]),
    "recordedModelRoutes": models,
    "schedulerTurns7Through13": {
        "steps": sum(t["steps"] for t in window),
        "newDispatches": 0,
        "toolCalls": Counter(name for t in window for name in t["toolCalls"]),
        "totalTokens": sum(t["totalTokens"] for t in window),
        "cacheReadTokens": sum(t["cacheReadTokens"] for t in window),
    },
    "gateDecisions": Counter(g["decision"] for g in gates),
    "gateDenialsBySource": Counter(g["by"] for g in gates if g["decision"] == "deny"),
    "supervisionsCompleted": len(reviews),
    "advisorySupervisions": sum(r["advisoryOnly"] for r in reviews),
}
print(json.dumps(result, ensure_ascii=False, indent=2))
