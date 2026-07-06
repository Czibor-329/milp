"""PreMoveID 依赖推导与图一致性校验。

本文件根据 MoveList 的时间顺序、站点槽位、机器人和晶圆信息推导必需的
PreMoveID 边，并校验现有 PreMoveID 是否完整、无环且符合类型与资源关联约束。
`populate_premove_ids` 会原地补齐依赖，`validate_premove_graph` 只返回问题列表。
"""

from typing import Dict, List, Optional, Set, Tuple

from src.validation.common import (
    ALLOWED_PRE_TYPES,
    MOVE_TYPES,
    as_list,
    dest_ref,
    latest,
    mat_key,
    same_mat,
    same_pjob_if_present,
    sort_key,
    source_ref,
    station_name,
    station_names,
    station_ref,
    station_slot_refs,
)


def required_premove_ids(moves: List[dict], tolerance: float = 1e-6) -> Dict[int, Set[int]]:
    """推导每个 move 按业务规则必须包含的 PreMoveID 集合。"""
    # 初始化所有合法 MoveID 的依赖集合，后续按时间顺序逐步填充。
    required_ids: Dict[int, Set[int]] = {
        int(move["MoveID"]): set()
        for move in moves
        if isinstance(move.get("MoveID"), int)
    }
    seen: List[dict] = []

    def add(current_move: dict, previous_move: Optional[dict]) -> None:
        """把非空且非自环的前置 move 加入当前 move 的必需依赖集合。"""
        if previous_move is not None and previous_move.get("MoveID") != current_move.get("MoveID"):
            required_ids.setdefault(int(current_move["MoveID"]), set()).add(int(previous_move["MoveID"]))

    def by_station_slot(
        station_slot: Optional[Tuple[str, int]],
        move_types: Set[int],
        material_move: Optional[dict] = None,
    ) -> List[dict]:
        """在已见 move 中查找引用指定站点槽位和类型的候选前置 move。"""
        if station_slot is None:
            return []
        candidates = []
        for previous_move in seen:
            if previous_move.get("MoveType") not in move_types or station_slot not in station_slot_refs(previous_move):
                continue
            if material_move is not None and mat_key(previous_move) and not same_mat(previous_move, material_move):
                continue
            candidates.append(previous_move)
        return candidates

    def by_robot(robot: str, move_types: Set[int], material_move: Optional[dict] = None) -> List[dict]:
        """在已见 move 中查找同一机器人和指定类型的候选前置 move。"""
        candidates = []
        for previous_move in seen:
            if previous_move.get("MoveType") not in move_types or previous_move.get("Robot") != robot:
                continue
            if material_move is not None and mat_key(previous_move) and not same_mat(previous_move, material_move):
                continue
            candidates.append(previous_move)
        return candidates

    def by_pressure(station: str) -> List[dict]:
        """在已见 move 中查找指定站点的压力转换前置 move。"""
        return [
            previous_move
            for previous_move in seen
            if previous_move.get("MoveType") == 10 and station_name(previous_move) == station
        ]

    # 按执行时间扫描，只从已经发生过的 move 中寻找当前 move 的最近前置。
    for current_move in sorted(moves, key=sort_key):
        if not isinstance(current_move.get("MoveID"), int):
            seen.append(current_move)
            continue
        move_type = current_move.get("MoveType")
        if move_type == 0:
            # Pick 依赖同站槽准备、机器人预转移到源站和源站压力转换。
            source = source_ref(current_move)
            add(current_move, latest(by_station_slot(source, {6}, current_move), current_move, tolerance))
            add(
                current_move,
                latest(
                    [move for move in by_robot(str(current_move.get("Robot") or ""), {5}) if dest_ref(move) == source],
                    current_move,
                    tolerance,
                ),
            )
            if source:
                add(current_move, latest(by_pressure(source[0]), current_move, tolerance))
        elif move_type == 1:
            # Place 依赖目标站准备、机器人预转移到目标站和目标站压力转换。
            destination = dest_ref(current_move)
            add(current_move, latest(by_station_slot(destination, {6}, current_move), current_move, tolerance))
            add(
                current_move,
                latest(
                    [
                        move for move in by_robot(str(current_move.get("Robot") or ""), {5}, current_move)
                        if dest_ref(move) == destination
                    ],
                    current_move,
                    tolerance,
                ),
            )
            if destination:
                add(current_move, latest(by_pressure(destination[0]), current_move, tolerance))
        elif move_type == 5:
            # PreTrans 依赖同机器人上一次取放，带晶圆信息时要求源站一致。
            robot = str(current_move.get("Robot") or "")
            if mat_key(current_move):
                add(
                    current_move,
                    latest(
                        [
                            move for move in by_robot(robot, {0}, current_move)
                            if source_ref(move) == source_ref(current_move)
                        ],
                        current_move,
                        tolerance,
                    ),
                )
            else:
                add(current_move, latest(by_robot(robot, {0, 1}), current_move, tolerance))
        elif move_type == 6:
            # Prepare 依赖同站槽最近的关门、驻留完成或压力转换。
            add(current_move, latest(by_station_slot(station_ref(current_move), {7, 9, 10}), current_move, tolerance))
        elif move_type == 7:
            # Complete 依赖同站槽的取放动作和可能存在的 Prepare。
            station_slot = station_ref(current_move)
            add(current_move, latest(by_station_slot(station_slot, {0, 1}, current_move), current_move, tolerance))
            add(current_move, latest(by_station_slot(station_slot, {6}, current_move), current_move, tolerance))
        elif move_type == 9:
            # ProcessComplete 依赖同站槽最近的 Complete，带晶圆信息时要求晶圆一致。
            material_move = current_move if mat_key(current_move) else None
            add(
                current_move,
                latest(by_station_slot(station_ref(current_move), {7}, material_move), current_move, tolerance),
            )
        elif move_type == 10:
            # PrePrepare 依赖同 LoadLock 前一次压力转换，以及最近可能占用站槽的动作。
            station_slot = station_ref(current_move)
            if station_slot:
                add(current_move, latest(by_pressure(station_slot[0]), current_move, tolerance))
            material_move = current_move if mat_key(current_move) else None
            add(current_move, latest(by_station_slot(station_slot, {7, 0, 1}, material_move), current_move, tolerance))
        seen.append(current_move)
    return required_ids


def populate_premove_ids(moves: List[dict]) -> None:
    """原地补齐每个 move 的 PreMoveID 字段。"""
    required_ids = required_premove_ids(moves)
    for move in moves:
        previous_ids = set(as_list(move, "PreMoveID"))
        if isinstance(move.get("MoveID"), int):
            previous_ids.update(required_ids.get(move["MoveID"], set()))
        move["PreMoveID"] = sorted(move_id for move_id in previous_ids if isinstance(move_id, int))


def _edge_consistency_errors(previous_move: dict, current_move: dict) -> List[str]:
    """校验一条 PreMoveID 边的时间、类型、资源和晶圆一致性。"""
    issues: List[str] = []
    previous_id = previous_move.get("MoveID")
    current_id = current_move.get("MoveID")
    previous_type = previous_move.get("MoveType")
    current_type = current_move.get("MoveType")
    # 先检查所有 PreMoveID 边都必须满足的时间先后和类型允许表。
    if previous_move["EndTime"] > current_move["StartTime"] + 1e-6:
        issues.append(f"ML PreMoveID 时间违例 id={previous_id}->{current_id}: "
                      f"前置结束 {previous_move['EndTime']:.6g} 晚于当前开始 {current_move['StartTime']:.6g}")
    if previous_type not in ALLOWED_PRE_TYPES.get(current_type, set()):
        issues.append(f"ML PreMoveID 类型违例 id={previous_id}->{current_id}: "
                      f"type-{current_type} 不允许前置 type-{previous_type}")

    previous_refs = station_slot_refs(previous_move)
    current_refs = station_slot_refs(current_move)
    # 再确认这条边至少通过机器人、站点或晶圆之一形成业务关联。
    same_robot = bool(previous_move.get("Robot") and previous_move.get("Robot") == current_move.get("Robot"))
    same_station_slot = bool(previous_refs & current_refs)
    same_station = bool(station_names(previous_move) & station_names(current_move))
    same_material = same_mat(previous_move, current_move)
    if not (same_robot or same_station or same_material):
        issues.append(f"ML PreMoveID 关联违例 id={previous_id}->{current_id}: Robot/Station/MatID 均不匹配")

    if same_material and not same_pjob_if_present(previous_move, current_move):
        issues.append(f"ML PreMoveID PJob 违例 id={previous_id}->{current_id}: PJobName 不一致")
    # 对携带晶圆信息的边，按当前 move 类型收紧 MatID 和 PJob 的一致性。
    if (
        mat_key(previous_move)
        and mat_key(current_move)
        and previous_type != 10
        and current_type in {0, 1, 5, 7, 9}
        and not same_material
    ):
        issues.append(f"ML PreMoveID 晶圆违例 id={previous_id}->{current_id}: MatIDList 不一致")
    if (
        mat_key(previous_move)
        and mat_key(current_move)
        and current_type == 10
        and previous_type != 10
        and not same_material
    ):
        issues.append(f"ML PreMoveID 晶圆违例 id={previous_id}->{current_id}: MatIDList 不一致")
    if previous_type == 10 and current_type == 10 and previous_move.get("CurState") != current_move.get("LastState"):
        issues.append(f"ML PreMoveID 压力链违例 id={previous_id}->{current_id}: "
                      f"{previous_move.get('CurState')} != {current_move.get('LastState')}")

    # 最后按具体 MoveType 组合检查站槽、源站和目标站是否对应。
    if (
        current_type == 0
        and previous_type == 6
        and station_ref(previous_move)
        and source_ref(current_move) != station_ref(previous_move)
    ):
        issues.append(f"ML PreMoveID 源站违例 id={previous_id}->{current_id}: 前置站槽不是 Pick 源站槽")
    if current_type == 0 and previous_type == 10 and station_name(previous_move) not in station_names(current_move):
        issues.append(f"ML PreMoveID 源站违例 id={previous_id}->{current_id}: PrePrepare 站点不是 Pick 源站")
    if current_type == 1:
        if previous_type == 6 and station_ref(previous_move) and dest_ref(current_move) != station_ref(previous_move):
            issues.append(f"ML PreMoveID 目标站违例 id={previous_id}->{current_id}: 前置站槽不是 Place 目标站槽")
        if previous_type == 10 and station_name(previous_move) not in station_names(current_move):
            issues.append(f"ML PreMoveID 目标站违例 id={previous_id}->{current_id}: PrePrepare 站点不是 Place 目标站")
        if previous_type == 5 and dest_ref(previous_move) and dest_ref(current_move) != dest_ref(previous_move):
            issues.append(f"ML PreMoveID 转位违例 id={previous_id}->{current_id}: PreTrans 目标不是 Place 目标")
    if (
        current_type == 5
        and previous_type == 0
        and mat_key(current_move)
        and source_ref(previous_move) != source_ref(current_move)
    ):
        issues.append(f"ML PreMoveID 转位违例 id={previous_id}->{current_id}: Pick 源站不是 PreTrans 源站")
    if (
        current_type == 7
        and previous_type in {0, 1, 6, 10}
        and previous_refs
        and current_refs
        and not same_station_slot
    ):
        issues.append(f"ML PreMoveID 关门违例 id={previous_id}->{current_id}: 前置站槽与 Complete 站槽不一致")
    if (
        current_type in {9, 10}
        and previous_type in {0, 1, 7}
        and previous_refs
        and current_refs
        and not same_station_slot
    ):
        issues.append(f"ML PreMoveID 站槽违例 id={previous_id}->{current_id}: 前置站槽与当前站槽不一致")
    return issues


def validate_premove_graph(moves: List[dict]) -> List[str]:
    """校验 PreMoveID 引用完整性、边一致性和依赖图无环。"""
    issues: List[str] = []
    # 只在基础字段合法的 move 上构图，避免后续图校验被无效记录干扰。
    good_moves = [move for move in moves if isinstance(move.get("MoveID"), int) and move.get("MoveType") in MOVE_TYPES]
    by_id = {move["MoveID"]: move for move in good_moves}
    required = required_premove_ids(good_moves)

    # 逐点检查 PreMoveID 字段自身，以及每条显式边是否满足业务一致性。
    for move in good_moves:
        move_id = move["MoveID"]
        previous_ids = as_list(move, "PreMoveID")
        if len(previous_ids) != len(set(previous_ids)):
            issues.append(f"ML PreMoveID 重复 id={move_id}: {previous_ids}")
        if move_id in previous_ids:
            issues.append(f"ML PreMoveID 自环 id={move_id}")
        missing = sorted(required.get(move_id, set()) - set(previous_ids))
        if missing:
            issues.append(f"ML PreMoveID 不完整 id={move_id}: 缺少 {missing}")
        for previous_id in previous_ids:
            previous_move = by_id.get(previous_id)
            if previous_move is None:
                issues.append(f"ML PreMoveID 引用不存在 id={move_id}: {previous_id}")
                continue
            issues.extend(_edge_consistency_errors(previous_move, move))

    visiting: Set[int] = set()
    visited: Set[int] = set()

    def dfs(move_id: int, path: List[int]) -> None:
        """深度优先遍历 PreMoveID 图并记录环路。"""
        if move_id in visiting:
            loop = path[path.index(move_id):] + [move_id] if move_id in path else path + [move_id]
            issues.append(f"ML PreMoveID 有环: {'->'.join(map(str, loop))}")
            return
        if move_id in visited:
            return
        visiting.add(move_id)
        for previous_id in as_list(by_id[move_id], "PreMoveID"):
            if previous_id in by_id:
                dfs(previous_id, path + [previous_id])
        visiting.remove(move_id)
        visited.add(move_id)

    # 所有边检查完成后，再遍历整张图检测循环依赖。
    for move_id in list(by_id):
        dfs(move_id, [move_id])
    return issues
