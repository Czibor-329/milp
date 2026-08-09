"""复现：用平台附件（AlgInit/AlgSchedule）调用 HeteroGraph CT.infer.scheduler。"""
import json
import os
import sys

ATTACH = r"D:\project\milp\.reasonix\attachments\clipboard-20260809-222233.387310-000001.json"
HG_ROOT = r"D:\project\milp\alg\other_alg\HeteroGraph"

sys.path.insert(0, HG_ROOT)
sys.path.insert(0, os.path.join(HG_ROOT, "CT"))

records = json.load(open(ATTACH, encoding="utf-8-sig"))
by_describe = {}
for rec in records:
    by_describe[rec["Describe"]] = rec

init_info = by_describe["AlgInit"]["Info"]
sched_info = by_describe["AlgSchedule"]["Info"]

wrapped = {
    "Time": by_describe["AlgSchedule"]["Time"],
    "Describe": "AlgSchedule",
    "SimTime": by_describe["AlgSchedule"]["SimTime"],
    "Info": sched_info,
}

from CT.infer import scheduler as sched

sched.init(json.dumps(init_info, ensure_ascii=False))
print("init ok")
out = sched.update(json.dumps(wrapped, ensure_ascii=False))
print("=== update return (first 2000 chars) ===")
print(out[:2000])
out_obj = json.loads(out)
print("=== parsed ===")
print("MoveList:", len(out_obj.get("MoveList") or []))
print("JobList:", len(out_obj.get("JobList") or []))
print("Feedback:", json.dumps(out_obj.get("Feedback"), ensure_ascii=False))
