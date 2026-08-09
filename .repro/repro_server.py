"""用附件 Input 精确复现平台 execute_plan 全链路。"""
import json
import sys

sys.path.insert(0, r"D:\project\milp\realtime_scheduler")
sys.path.insert(0, r"D:\project\milp")

ATTACH = r"D:\project\milp\.reasonix\attachments\clipboard-20260809-222233.387310-000001.json"
records = json.load(open(ATTACH, encoding="utf-8-sig"))
by_describe = {r["Describe"]: r for r in records}
raw_plan = by_describe["Input"]["Info"][0]

from realtime_scheduler import server

print("strategy:", raw_plan.get("strategy"))
try:
    result = server.execute_plan(raw_plan)
    print("=== execute_plan OK ===")
    print("ok:", result.get("ok"), "strategy:", result.get("strategy"))
    print("moveCount:", result.get("moveCount"), "makespan:", result.get("makespan"))
    print("logs:")
    for line in result.get("logs") or []:
        print("  ", line)
    out = result.get("output") or {}
    print("output MoveList:", len(out.get("MoveList") or []),
          "Feedback:", json.dumps(out.get("Feedback"), ensure_ascii=False))
except Exception as exc:
    print("=== execute_plan EXCEPTION ===")
    print(type(exc).__name__, str(exc))
    import traceback
    traceback.print_exc()
