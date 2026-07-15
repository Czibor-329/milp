"""生成两次实时重算示例并导出统一 MoveList。

第一次新增任务的加工候选腔为 PM1/PM2，第二次为 PM3/PM4。脚本用真实
``update_move_state`` 开始/结束通知推进状态，再调用启发式 + timing 重算。

用法：
    python scripts/reschedule.py
    python scripts/reschedule.py --output results/output/reschedule/two_recomputes.json
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.marathon_gen import JobSpec, build_update_params, job_process_recipes
from src.parse import load_alg_entries
from src.reschedule import RealtimeRescheduler
from src.validation import MoveStateReplay
from src.validation.move_fields import PROCESS_MOVE
from src.validation.state import DoorState


DEFAULT_INPUT = ROOT / "src" / "input_data" / "s1-1c2p-reschedule.json"
DEFAULT_OUTPUT = ROOT / "results" / "output" / "reschedule" / "two_recomputes.json"
TIME_TOLERANCE = 1e-6


def _job(index: int, process_modules: Sequence[str], process_time: int) -> JobSpec:
    """构造一片、无清洁且依次经过给定 PM 的确定性任务。"""
    job = JobSpec(
        index,
        random.Random(index),
        pm_pool=process_modules,
        stage_range=(1, 1),
        clean=False,
        proc_range=(process_time, process_time),
    )
    job.stages = [[module] for module in process_modules]
    job.proc_times = [process_time for _ in process_modules]
    job.n_wafer = 1
    job.priority = index + 1
    return job


def _update(job: JobSpec, key: int, load_port: str, material_id: int, current_time: float) -> Dict[str, Any]:
    """把示例 JobSpec 转成外部实时调度使用的 update payload。"""
    update, _ = build_update_params(
        job,
        key,
        job.priority,
        load_port,
        material_id,
        current_time,
        process_recipes=job_process_recipes(job, key),
    )
    return update


def _events_until(moves: Sequence[Mapping[str, Any]], timestamp: float) -> List[Dict[str, Any]]:
    """生成切点之前的开始/结束通知，并在同一时刻先处理结束。"""
    events: List[tuple[float, int, Dict[str, Any]]] = []
    for move in moves:
        start_time = float(move.get("StartTime") or 0.0)
        end_time = float(move.get("EndTime") or 0.0)
        if start_time >= timestamp - TIME_TOLERANCE:
            continue
        move_id = int(move["MoveID"])
        events.append((start_time, 1, {
            "MoveID": move_id,
            "MoveState": MoveStateReplay.RUNNING,
            "StartTime": start_time,
        }))
        if end_time <= timestamp + TIME_TOLERANCE:
            events.append((end_time, 0, {
                "MoveID": move_id,
                "MoveState": MoveStateReplay.DONE,
                "EndTime": end_time,
            }))
    return [event for _, _, event in sorted(events, key=lambda item: (item[0], item[1], item[2]["MoveID"]))]


def _find_stable_cut(scheduler: RealtimeRescheduler, pjob_name: str) -> float:
    """从指定任务加工完成后寻找最早的关门、空手机械手稳定切点。"""
    moves = scheduler.current_plan
    process_ends = [
        float(move["EndTime"])
        for move in moves
        if move.get("MoveType") == PROCESS_MOVE
        and list(move.get("MatIDList") or [])
        and pjob_name in {str(value) for value in (move.get("PJobName") or [])}
    ]
    if not process_ends:
        raise RuntimeError(f"找不到 {pjob_name} 的加工 Move")
    candidate_times = sorted({
        float(move.get("EndTime") or 0.0)
        for move in moves
        if float(move.get("EndTime") or 0.0) >= min(process_ends) - TIME_TOLERANCE
    })
    for timestamp in candidate_times:
        overlaps = [
            move for move in moves
            if float(move.get("StartTime") or 0.0) < timestamp - TIME_TOLERANCE
            and float(move.get("EndTime") or 0.0) > timestamp + TIME_TOLERANCE
        ]
        has_future = any(
            float(move.get("StartTime") or 0.0) >= timestamp - TIME_TOLERANCE
            and pjob_name in {str(value) for value in (move.get("PJobName") or [])}
            for move in moves
        )
        if overlaps or not has_future:
            continue
        replay = MoveStateReplay(scheduler.problem, moves, scheduler.state)
        for notification in _events_until(moves, timestamp):
            replay.update_move_state(notification)
        doors_closed = all(station.door is DoorState.CLOSED for station in replay.state.stations.values())
        robots_empty = all(material is None for robot in replay.state.robots.values() for material in robot.hands.values())
        if not replay.running_move_ids and doors_closed and robots_empty:
            return timestamp
    raise RuntimeError(f"找不到 {pjob_name} 的稳定加工结束切点")


def _notify_until(scheduler: RealtimeRescheduler, timestamp: float) -> None:
    """模拟外部系统，把重算点之前的 Move 开始/结束通知按时间顺序送入。"""
    for notification in _events_until(scheduler.current_plan, timestamp):
        scheduler.update_move_state(notification)


def build_two_recompute_case(input_path: Path = DEFAULT_INPUT) -> Dict[str, Any]:
    """运行一个首排和两次新增任务重算，返回可直接交给甘特图的统一数据。"""
    tool_topo, _ = load_alg_entries(input_path)
    initial_job = _job(0, ["PM1"], 24)
    first_new_job = _job(1, ["PM1", "PM2"], 28)
    second_new_job = _job(2, ["PM3", "PM4"], 32)

    scheduler = RealtimeRescheduler(tool_topo, _update(initial_job, 1, "LP1", 1, 0.0))

    first_cut = _find_stable_cut(scheduler, "1.P1-1")
    _notify_until(scheduler, first_cut)
    scheduler.recompute(
        _update(first_new_job, 2, "LP2", 101, first_cut),
        first_cut,
        reason="新增 PM1~PM2 任务",
    )

    second_cut = _find_stable_cut(scheduler, "2.P1-1")
    _notify_until(scheduler, second_cut)
    return scheduler.recompute(
        _update(second_new_job, 3, "LP3", 201, second_cut),
        second_cut,
        reason="新增 PM3~PM4 任务",
    )


def main() -> None:
    """解析命令行、运行示例并写出 JSON。"""
    parser = argparse.ArgumentParser(description="两次实时重算示例")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="含 AlgInit 的录制输入")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="统一 MoveList 输出路径")
    args = parser.parse_args()

    output = build_two_recompute_case(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as file:
        json.dump(output, file, ensure_ascii=False, indent=2)
    points = ", ".join(f"#{point['Index']}@{point['Time']:.2f}s" for point in output["RecomputePoints"])
    print(f"已输出 {len(output['MoveList'])} 条 Move；重算点：{points}")
    print(args.output)


if __name__ == "__main__":
    main()
