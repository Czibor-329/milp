"""导出 MoveList 时使用的依赖字段补全工具。

校验路径不检查 ``PreMoveID`` 是否激活。本模块仅服务导出流程：生成的 MoveList
行仍需要尽力补出 ``PreMoveID`` 字段，供下游展示或存储显式依赖。
"""

from typing import Dict, List, Optional, Set, Tuple

from src.validation.move_fields import (
    COMPLETE_MOVE,
    PICK_MOVE,
    PLACE_MOVE,
    PREPARE_MOVE,
    PRE_PREPARE_MOVE,
    PRE_TRANS_MOVE,
    PROCESS_MOVE,
    as_list,
    dest_ref,
    latest,
    mat_key,
    same_mat,
    sort_key,
    source_ref,
    station_name,
    station_ref,
    station_slot_refs,
)


DEPENDENCY_TIME_TOLERANCE = 1e-6


def required_premove_ids(
    moves: List[dict],
    tolerance: float = DEPENDENCY_TIME_TOLERANCE,
) -> Dict[int, Set[int]]:
    """推断每个导出动作应该携带的 ``PreMoveID`` 集合。

    参数:
        moves: MoveList 行，可能已经包含也可能不包含 ``PreMoveID``。
        tolerance: 判断前置动作是否在当前动作开始前完成时使用的时间容差。

    返回:
        从 ``MoveID`` 到推断前置 ``MoveID`` 集合的映射。本函数只读取输入行，不修改它们。
    """
    required_ids: Dict[int, Set[int]] = {
        int(move["MoveID"]): set()
        for move in moves
        if isinstance(move.get("MoveID"), int)
    }
    seen: List[dict] = []

    def add(current_move: dict, previous_move: Optional[dict]) -> None:
        """在找到有效前置动作时增加一条依赖边。"""
        if previous_move is not None and previous_move.get("MoveID") != current_move.get("MoveID"):
            required_ids.setdefault(int(current_move["MoveID"]), set()).add(int(previous_move["MoveID"]))

    def by_station_slot(
        station_slot: Optional[Tuple[str, int]],
        move_types: Set[int],
        material_move: Optional[dict] = None,
    ) -> List[dict]:
        """返回已扫描动作中类型匹配且触碰指定站点槽位的动作。"""
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
        """返回已扫描动作中机器人、类型和可选物料匹配的动作。"""
        candidates = []
        for previous_move in seen:
            if previous_move.get("MoveType") not in move_types or previous_move.get("Robot") != robot:
                continue
            if material_move is not None and mat_key(previous_move) and not same_mat(previous_move, material_move):
                continue
            candidates.append(previous_move)
        return candidates

    def by_pressure(station: str) -> List[dict]:
        """返回指定站点上已扫描到的环境转换动作。"""
        return [
            previous_move
            for previous_move in seen
            if previous_move.get("MoveType") == PRE_PREPARE_MOVE and station_name(previous_move) == station
        ]

    # 按 MoveList 时间顺序扫描，把每个动作绑定到最近且已经完成的相关前置动作上。
    for current_move in sorted(moves, key=sort_key):
        if not isinstance(current_move.get("MoveID"), int):
            seen.append(current_move)
            continue

        move_type = current_move.get("MoveType")
        if move_type == PICK_MOVE:
            source = source_ref(current_move)
            add(current_move, latest(by_station_slot(source, {PREPARE_MOVE}, current_move), current_move, tolerance))
            add(
                current_move,
                latest(
                    [
                        move
                        for move in by_robot(str(current_move.get("Robot") or ""), {PRE_TRANS_MOVE})
                        if dest_ref(move) == source
                    ],
                    current_move,
                    tolerance,
                ),
            )
            if source:
                add(current_move, latest(by_pressure(source[0]), current_move, tolerance))
        elif move_type == PLACE_MOVE:
            destination = dest_ref(current_move)
            add(current_move, latest(by_station_slot(destination, {PREPARE_MOVE}, current_move), current_move, tolerance))
            add(
                current_move,
                latest(
                    [
                        move
                        for move in by_robot(str(current_move.get("Robot") or ""), {PRE_TRANS_MOVE}, current_move)
                        if dest_ref(move) == destination
                    ],
                    current_move,
                    tolerance,
                ),
            )
            if destination:
                add(current_move, latest(by_pressure(destination[0]), current_move, tolerance))
        elif move_type == PRE_TRANS_MOVE:
            robot = str(current_move.get("Robot") or "")
            if mat_key(current_move):
                add(
                    current_move,
                    latest(
                        [
                            move
                            for move in by_robot(robot, {PICK_MOVE}, current_move)
                            if source_ref(move) == source_ref(current_move)
                        ],
                        current_move,
                        tolerance,
                    ),
                )
            else:
                add(current_move, latest(by_robot(robot, {PICK_MOVE, PLACE_MOVE}), current_move, tolerance))
        elif move_type == PREPARE_MOVE:
            add(
                current_move,
                latest(
                    by_station_slot(station_ref(current_move), {COMPLETE_MOVE, PROCESS_MOVE, PRE_PREPARE_MOVE}),
                    current_move,
                    tolerance,
                ),
            )
        elif move_type == COMPLETE_MOVE:
            station_slot = station_ref(current_move)
            add(
                current_move,
                latest(by_station_slot(station_slot, {PICK_MOVE, PLACE_MOVE}, current_move), current_move, tolerance),
            )
            add(current_move, latest(by_station_slot(station_slot, {PREPARE_MOVE}, current_move), current_move, tolerance))
        elif move_type == PROCESS_MOVE:
            material_move = current_move if mat_key(current_move) else None
            add(
                current_move,
                latest(by_station_slot(station_ref(current_move), {COMPLETE_MOVE}, material_move), current_move, tolerance),
            )
        elif move_type == PRE_PREPARE_MOVE:
            station_slot = station_ref(current_move)
            if station_slot:
                add(current_move, latest(by_pressure(station_slot[0]), current_move, tolerance))
            material_move = current_move if mat_key(current_move) else None
            add(
                current_move,
                latest(
                    by_station_slot(station_slot, {COMPLETE_MOVE, PICK_MOVE, PLACE_MOVE}, material_move),
                    current_move,
                    tolerance,
                ),
            )

        seen.append(current_move)

    return required_ids


def populate_premove_ids(moves: List[dict]) -> None:
    """为 MoveList 导出就地补全每个动作的 ``PreMoveID`` 字段。

    参数:
        moves: 导出器生成的可变 MoveList 行。

    副作用:
        每行都会得到一个排序后的 ``PreMoveID`` 列表；已有的整数前置项会被保留。
    """
    required_ids = required_premove_ids(moves)
    for move in moves:
        previous_ids = set(as_list(move, "PreMoveID"))
        if isinstance(move.get("MoveID"), int):
            previous_ids.update(required_ids.get(move["MoveID"], set()))
        move["PreMoveID"] = sorted(move_id for move_id in previous_ids if isinstance(move_id, int))
