"""Machine 调度边界、自动物理动作和非稳定状态续排测试。"""

from __future__ import annotations

import unittest
from inspect import getsource

from src.parse.model import Chamber, CleanSpec, Problem, Robot, Stage, Wafer
from src.schedule.machine_policy import (
    HeuristicMachineSelector,
    NeuralMachineSelector,
    RlMachineSelector,
)
from src.schedule.realtime import _build_recompute_problem
from src.validation import validate_move_list
from src.validation.move_fields import (
    COMPLETE_MOVE,
    PICK_MOVE,
    PLACE_MOVE,
    PREPARE_MOVE,
    PRE_PREPARE_MOVE,
    PRE_TRANS_MOVE,
    SWAP_MOVE,
)
from src.validation.state import (
    DoorState,
    LoadLockState,
    Machine,
    MachineState,
    MaterialState,
    RobotState,
    SlotPhase,
    SlotState,
    StaleRobotActionError,
    StationState,
)


def _chamber(name: str, station_type: str, *, process: bool = False) -> Chamber:
    """构造包含一秒门动作的测试站点。"""
    return Chamber(
        name,
        station_type,
        1,
        pump_time=3.0 if station_type == "LoadLock" else None,
        vent_time=4.0 if station_type == "LoadLock" else None,
        pick_prepare_time={"R": 1.0, "R1": 1.0, "R2": 1.0},
        place_prepare_time={"R": 1.0, "R1": 1.0, "R2": 1.0},
        pick_complete_time={"R": 1.0, "R1": 1.0, "R2": 1.0},
        place_complete_time={"R": 1.0, "R1": 1.0, "R2": 1.0},
    )


def _robot(name: str, scope: list[str]) -> Robot:
    """构造一秒取放和转位的单臂 Robot。"""
    return Robot(
        name,
        scope,
        1,
        False,
        {station: 1.0 for station in scope},
        {station: 1.0 for station in scope},
        [{"Time": 1.0}],
    )


def _wafer(
    wid: int,
    material_id: int,
    source: str,
    process: str,
    robot: str,
) -> Wafer:
    """构造 source→process→sink 的最小 Route。"""
    return Wafer(
        wid,
        material_id,
        f"route-{wid}",
        wid,
        [
            Stage(0, source, "source", 0.0, "", robot, -1.0),
            Stage(1, process, "process", 5.0, robot, robot, -1.0),
            Stage(2, source, "sink", 0.0, robot, "", -1.0),
        ],
        [robot, robot],
        f"P{wid}",
    )


def _loadlock_wafer(
    wid: int,
    material_id: int,
    *,
    source_slot: int = 0,
    residency: float = -1.0,
) -> Wafer:
    """构造经双槽 LoadLock 进出真空区的单工序晶圆。"""
    return Wafer(
        wid,
        material_id,
        "shared-loadlock-route",
        wid,
        [
            Stage(0, "LP", "source", 0.0, "", "ATR", -1.0, slot=source_slot),
            Stage(1, "LL", "loadlock", 3.0, "ATR", "VTR", -1.0, "entry", 0),
            Stage(2, "PM", "process", 5.0, "VTR", "VTR", residency),
            Stage(3, "LL", "loadlock", 4.0, "VTR", "ATR", -1.0, "exit", 1),
            Stage(4, "LP", "sink", 0.0, "ATR", "", -1.0, slot=source_slot),
        ],
        ["ATR", "VTR", "VTR", "ATR"],
        "P",
    )


def _loadlock_problem(wafers: list[Wafer]) -> Problem:
    """构造双槽 LoadLock、单臂 ATR/VTR 的测试设备。"""
    load_port = _chamber("LP", "LoadPort")
    load_port.capacity = 2
    load_lock = _chamber("LL", "LoadLock")
    load_lock.capacity = 2
    return Problem(
        {
            "LP": load_port,
            "LL": load_lock,
            "PM": _chamber("PM", "ProcessChamber"),
        },
        {
            "ATR": _robot("ATR", ["LP", "LL"]),
            "VTR": _robot("VTR", ["LL", "PM"]),
        },
        wafers,
    )


class MachineTests(unittest.TestCase):
    """验证策略只需选择 RobotAction，物理细节由 Machine 生成。"""

    def test_action_preview_adds_rotation_doors_and_process(self) -> None:
        """Robot 指向错误且门关闭时应补转位、两侧门动作和加工。"""
        problem = Problem(
            {
                "LP": _chamber("LP", "LoadPort"),
                "PM": _chamber("PM", "ProcessChamber"),
            },
            {"R": _robot("R", ["LP", "PM"])},
            [_wafer(0, 1, "LP", "PM", "R")],
        )
        initial = MachineState.from_sources(problem, None)
        initial.robots["R"].position = "PM"
        machine = Machine(problem, initial)

        action = machine.get_robot_actions()[0]
        move_types = [move["MoveType"] for move in action.move_preview]

        self.assertEqual(PRE_TRANS_MOVE, move_types[0])
        self.assertGreaterEqual(move_types.count(PREPARE_MOVE), 2)
        self.assertGreater(action.finish_time, action.earliest_start)

        result = machine.run(HeuristicMachineSelector())
        self.assertEqual(
            [],
            validate_move_list(problem, [dict(move) for move in result.moves], initial),
        )

    def test_stale_action_is_rejected(self) -> None:
        """提交一个动作后，旧 revision 的候选不得再次使用。"""
        problem = Problem(
            {"LP": _chamber("LP", "LoadPort"), "PM": _chamber("PM", "ProcessChamber")},
            {"R": _robot("R", ["LP", "PM"])},
            [_wafer(0, 1, "LP", "PM", "R")],
        )
        machine = Machine(problem)
        action = machine.get_robot_actions()[0]
        machine.apply_robot_action(action.action_id, expected_revision=action.revision)
        with self.assertRaises(StaleRobotActionError):
            machine.apply_robot_action(action.action_id)

    def test_public_views_are_recursively_read_only(self) -> None:
        """策略不得通过快照或动作预览修改 Machine 内部状态。"""
        problem = Problem(
            {"LP": _chamber("LP", "LoadPort"), "PM": _chamber("PM", "ProcessChamber")},
            {"R": _robot("R", ["LP", "PM"])},
            [_wafer(0, 1, "LP", "PM", "R")],
        )
        machine = Machine(problem)
        snapshot = machine.get_state()
        action = machine.get_robot_actions()[0]

        with self.assertRaises(TypeError):
            snapshot.stations["LP"].slots[1] = None  # type: ignore[index]
        with self.assertRaises(TypeError):
            action.move_preview[0]["MoveType"] = 999  # type: ignore[index]

    def test_local_selectors_do_not_depend_on_physical_move_details(self) -> None:
        """三个本地 selector 只能按公开候选特征排序，不读取门、压力或回放层。"""
        forbidden_names = (
            "DoorState",
            "LoadLockState",
            "MoveStateReplay",
            "export_movelist",
            "PREPARE_MOVE",
            "PRE_PREPARE_MOVE",
        )
        for selector_type in (
            HeuristicMachineSelector,
            NeuralMachineSelector,
            RlMachineSelector,
        ):
            source = getsource(selector_type)
            with self.subTest(selector=selector_type.__name__):
                self.assertFalse(
                    any(name in source for name in forbidden_names),
                    source,
                )

    def test_independent_robot_is_not_delayed_by_busy_robot(self) -> None:
        """一个 Robot 忙碌时，另一条独立搬运仍从当前时刻开始。"""
        problem = Problem(
            {
                "LP1": _chamber("LP1", "LoadPort"),
                "PM1": _chamber("PM1", "ProcessChamber"),
                "LP2": _chamber("LP2", "LoadPort"),
                "PM2": _chamber("PM2", "ProcessChamber"),
            },
            {
                "R1": _robot("R1", ["LP1", "PM1"]),
                "R2": _robot("R2", ["LP2", "PM2"]),
            },
            [
                _wafer(0, 1, "LP1", "PM1", "R1"),
                _wafer(1, 2, "LP2", "PM2", "R2"),
            ],
        )
        initial = MachineState.from_sources(problem, None)
        initial.robots["R1"].busy_until = 30.0
        actions = Machine(problem, initial, current_time=10.0).get_robot_actions()
        starts = {action.robot: action.earliest_start for action in actions}

        self.assertGreaterEqual(starts["R1"], 30.0)
        self.assertEqual(10.0, starts["R2"])

    def test_loadlock_environment_is_hidden_in_action(self) -> None:
        """访问压力态不匹配的 LoadLock 时，候选预览自动包含压力转换。"""
        wafer = Wafer(
            0,
            1,
            "ll",
            0,
            [
                Stage(0, "LP", "source", 0.0, "", "R", -1.0),
                Stage(1, "LL", "loadlock", 3.0, "R", "R", -1.0, "entry"),
                Stage(2, "LP", "sink", 0.0, "R", "", -1.0),
            ],
            ["R", "R"],
            "P",
        )
        problem = Problem(
            {"LP": _chamber("LP", "LoadPort"), "LL": _chamber("LL", "LoadLock")},
            {"R": _robot("R", ["LP", "LL"])},
            [wafer],
        )
        initial = MachineState.from_sources(problem, None)
        self.assertIsInstance(initial.stations["LL"], LoadLockState)
        initial.stations["LL"].environment = "VAC"  # type: ignore[union-attr]

        action = Machine(problem, initial).get_robot_actions()[0]

        self.assertIn(
            PRE_PREPARE_MOVE,
            [move["MoveType"] for move in action.move_preview],
        )

    def test_atmosphere_loadlock_exchange_is_a_policy_candidate(self) -> None:
        """ATR 应能在一次开门内先放生片再取熟片，且保留单向候选。"""
        incoming = _loadlock_wafer(0, 1, source_slot=0)
        outgoing = _loadlock_wafer(1, 2, source_slot=1)
        problem = _loadlock_problem([incoming, outgoing])
        initial = MachineState.from_sources(problem, None)
        initial.stations["LP"].slots[2] = SlotState()
        initial.stations["LL"].slots[2] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(2, "P", 3),
        )
        initial.stations["LL"].environment = "ATM"  # type: ignore[union-attr]
        machine = Machine(problem, initial)

        actions = machine.get_robot_actions()
        incoming_actions = [
            action for action in actions if action.material_ids[0] == 1
        ]
        selected_id = HeuristicMachineSelector(problem).choose(
            machine.get_state(),
            actions,
        )
        selected = next(action for action in actions if action.action_id == selected_id)

        self.assertEqual({"transfer", "ll_exchange"}, {a.kind for a in incoming_actions})
        disabled_actions = Machine(
            problem,
            initial,
            allow_loadlock_exchange=False,
        ).get_robot_actions()
        self.assertNotIn("ll_exchange", {action.kind for action in disabled_actions})
        self.assertEqual("ll_exchange", selected.kind)
        self.assertEqual("atmosphere_exchange", selected.flow_kind)
        ll_moves = [
            move
            for move in selected.move_preview
            if move["MoveType"] != PRE_TRANS_MOVE
            and (
                move.get("Station") == "LL"
                or "LL" in (move.get("SrcStationList") or ())
                or "LL" in (move.get("DestStationList") or ())
            )
        ]
        self.assertEqual(
            [PREPARE_MOVE, 1, 0, 7, PRE_PREPARE_MOVE],
            [move["MoveType"] for move in ll_moves],
        )

        machine.apply_robot_action(selected.action_id)
        self.assertEqual(1, machine.state.stations["LL"].slots[1].material.material_id)
        self.assertIsNone(machine.state.stations["LL"].slots[2].material)
        self.assertEqual(2, machine.state.robots["ATR"].hands[1].material_id)

    def test_vacuum_loadlock_exchange_is_a_policy_candidate(self) -> None:
        """VTR 应能在一次开门内先放熟片再取生片。"""
        outgoing = _loadlock_wafer(0, 1, source_slot=0)
        incoming = _loadlock_wafer(1, 2, source_slot=1)
        problem = _loadlock_problem([outgoing, incoming])
        initial = MachineState.from_sources(problem, None)
        initial.stations["LP"].slots[1] = SlotState()
        initial.stations["LP"].slots[2] = SlotState()
        initial.stations["LL"].slots[1] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(2, "P", 1),
        )
        initial.stations["PM"].slots[1] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(1, "P", 2),
            busy_until=5.0,
        )
        initial.stations["LL"].environment = "VAC"  # type: ignore[union-attr]
        machine = Machine(problem, initial)

        actions = machine.get_robot_actions()
        exchange = next(action for action in actions if action.kind == "ll_exchange")

        self.assertEqual("vacuum_exchange", exchange.flow_kind)
        machine.apply_robot_action(exchange.action_id)
        self.assertEqual(1, machine.state.stations["LL"].slots[2].material.material_id)
        self.assertIsNone(machine.state.stations["LL"].slots[1].material)
        self.assertEqual(2, machine.state.robots["VTR"].hands[1].material_id)

    def test_dual_arm_vtr_loadlock_exchange_is_atomic_swap(self) -> None:
        """双臂 VTR 的 LoadLock 交换必须导出单个 Swap，而非连续 Place/Pick。"""
        outgoing = _loadlock_wafer(0, 1, source_slot=0)
        incoming = _loadlock_wafer(1, 2, source_slot=1)
        problem = _loadlock_problem([outgoing, incoming])
        problem.robots["VTR"].capacity = 2
        problem.robots["VTR"].can_swap = True
        initial = MachineState.from_sources(problem, None)
        initial.stations["LP"].slots[1] = SlotState()
        initial.stations["LP"].slots[2] = SlotState()
        initial.stations["LL"].slots[1] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(2, "P", 1),
        )
        initial.stations["PM"].slots[1] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(1, "P", 2),
            busy_until=5.0,
        )
        initial.stations["LL"].environment = "VAC"  # type: ignore[union-attr]
        machine = Machine(problem, initial)

        exchange = next(
            action
            for action in machine.get_robot_actions()
            if action.kind == "ll_exchange"
        )
        ll_moves = [
            move
            for move in exchange.move_preview
            if move["MoveType"] != PRE_TRANS_MOVE
            and (
                move.get("Station") == "LL"
                or "LL" in (move.get("StationList") or ())
            )
        ]

        self.assertEqual(
            [PREPARE_MOVE, SWAP_MOVE, COMPLETE_MOVE, PRE_PREPARE_MOVE],
            [move["MoveType"] for move in ll_moves],
        )
        self.assertNotIn(PLACE_MOVE, [move["MoveType"] for move in ll_moves])
        self.assertNotIn(PICK_MOVE, [move["MoveType"] for move in ll_moves])
        swap = next(move for move in ll_moves if move["MoveType"] == SWAP_MOVE)
        self.assertEqual((2,), swap["StnRecvSlotList"])
        self.assertEqual((1,), swap["StnSendSlotList"])
        self.assertEqual((2,), swap["RecvMatList"])
        self.assertEqual((1,), swap["SendMatList"])
        machine.apply_robot_action(exchange.action_id)
        self.assertEqual(
            [],
            validate_move_list(problem, machine.export_movelist(), initial),
        )
        self.assertEqual(1, machine.state.stations["LL"].slots[2].material.material_id)
        self.assertIsNone(machine.state.stations["LL"].slots[1].material)
        self.assertIsNone(machine.state.robots["VTR"].hands[1])
        self.assertEqual(2, machine.state.robots["VTR"].hands[2].material_id)

    def test_short_process_output_can_delay_a_risky_feed(self) -> None:
        """送片会跨过 PM 完工时刻时，策略应先预留出片窗口。"""
        incoming = _loadlock_wafer(0, 1, source_slot=0)
        outgoing = _loadlock_wafer(1, 2, source_slot=1, residency=8.0)
        problem = _loadlock_problem([incoming, outgoing])
        initial = MachineState.from_sources(problem, None)
        initial.stations["LP"].slots[2] = SlotState()
        initial.stations["PM"].slots[1] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(2, "P", 2),
            busy_until=5.0,
        )
        machine = Machine(problem, initial)
        actions = machine.get_robot_actions()
        feed = next(action for action in actions if action.flow_kind == "feed")
        process_departure = next(
            action
            for action in actions
            if action.material_ids[0] == 2
        )

        self.assertLess(feed.earliest_start, process_departure.earliest_start)
        self.assertGreaterEqual(
            feed.projected_ready_time,
            process_departure.earliest_start,
        )
        self.assertEqual(
            process_departure.action_id,
            HeuristicMachineSelector(problem).choose(machine.get_state(), actions),
        )

    def test_held_material_can_build_recompute_problem_and_place(self) -> None:
        """非稳定切点上的 Robot 持片应成为 held_place，而不是被拒绝。"""
        old_problem = Problem(
            {"LP": _chamber("LP", "LoadPort"), "PM": _chamber("PM", "ProcessChamber")},
            {"R": _robot("R", ["LP", "PM"])},
            [_wafer(0, 1, "LP", "PM", "R")],
        )
        state = MachineState(
            stations={
                "LP": StationState("LP", "LoadPort", {1: SlotState()}),
                "PM": StationState("PM", "ProcessChamber", {1: SlotState()}),
            },
            robots={
                "R": RobotState(
                    "R",
                    {1: MaterialState(1, "P0", 0)},
                    {"LP", "PM"},
                    "LP",
                    5.0,
                )
            },
            robot_aliases={"R": "R"},
        )
        empty_incoming = Problem(old_problem.chambers, old_problem.robots, [])

        combined, next_state = _build_recompute_problem(
            old_problem,
            empty_incoming,
            state,
        )
        actions = Machine(
            combined,
            next_state,
            current_time=2.0,
        ).get_robot_actions()

        self.assertEqual(1, len(actions))
        self.assertEqual("held_place", actions[0].kind)
        self.assertGreaterEqual(actions[0].earliest_start, 5.0)

    def test_fork_rebuilds_candidates_without_sharing_mutable_state(self) -> None:
        """已枚举候选后仍可安全 fork，分支提交不影响原 Machine。"""
        problem = Problem(
            {"LP": _chamber("LP", "LoadPort"), "PM": _chamber("PM", "ProcessChamber")},
            {"R": _robot("R", ["LP", "PM"])},
            [_wafer(0, 1, "LP", "PM", "R")],
        )
        machine = Machine(problem)
        machine.get_robot_actions()
        branch = machine.fork()
        action = branch.get_robot_actions()[0]
        branch.apply_robot_action(action.action_id)

        self.assertEqual(0, machine.revision)
        self.assertEqual(1, branch.revision)

    def test_dual_arm_machine_emits_atomic_process_swap(self) -> None:
        """双臂 Robot 面对已占 PM 时应提供并导出原子 SwapMove。"""
        wafers = [
            Wafer(
                index,
                index + 1,
                "swap",
                index,
                [
                    Stage(0, "LP", "source", 0.0, "", "R", -1.0, slot=index),
                    Stage(1, "PM", "process", 5.0, "R", "R", -1.0),
                    Stage(2, "LP", "sink", 0.0, "R", "", -1.0, slot=index),
                ],
                ["R", "R"],
                f"P{index}",
            )
            for index in range(2)
        ]
        robot = _robot("R", ["LP", "PM"])
        robot.capacity = 2
        robot.can_swap = True
        problem = Problem(
            {
                "LP": Chamber(
                    **{
                        **_chamber("LP", "LoadPort").__dict__,
                        "capacity": 2,
                    }
                ),
                "PM": _chamber("PM", "ProcessChamber"),
            },
            {"R": robot},
            wafers,
        )

        result = Machine(problem).run(HeuristicMachineSelector())
        moves = [dict(move) for move in result.moves]

        self.assertIn(4, [move["MoveType"] for move in moves])
        self.assertEqual([], validate_move_list(problem, moves))

    def test_recompute_keeps_only_running_open_and_reuses_open_door(self) -> None:
        """开门 Move 运行中重算时，不补旧搬运链也不重复打开同一扇门。"""
        problem = Problem(
            {"LP": _chamber("LP", "LoadPort"), "PM": _chamber("PM", "ProcessChamber")},
            {"R": _robot("R", ["LP", "PM"])},
            [_wafer(0, 1, "LP", "PM", "R")],
        )
        machine = Machine(problem)
        first_plan = machine.run(HeuristicMachineSelector())
        first_move = dict(first_plan.moves[0])
        self.assertEqual(PREPARE_MOVE, first_move["MoveType"])
        machine.update_move_state({
            "MoveID": first_move["MoveID"],
            "MoveState": 0,
            "StartTime": first_move["StartTime"],
        })

        recomputed = machine.recompute(
            problem,
            0.5,
            HeuristicMachineSelector(),
        )
        moves = [dict(move) for move in recomputed.moves]
        cancelled_ids = {
            int(move["MoveID"])
            for move in first_plan.moves
            if int(move["MoveID"]) != int(first_move["MoveID"])
        }
        source_opens = [
            move
            for move in moves
            if move["MoveType"] == PREPARE_MOVE
            and move.get("Station") == "LP"
            and move.get("RelatedActionType") == 1
        ]

        self.assertEqual(1, len(source_opens))
        self.assertTrue(
            cancelled_ids.isdisjoint(
                int(move["MoveID"]) for move in moves
            )
        )
        self.assertEqual([], validate_move_list(problem, moves))

    def test_unfinished_place_gets_close_and_process_without_old_tail(self) -> None:
        """切点上的已放片状态应由 Machine 自动补关门和加工后再出片。"""
        problem = Problem(
            {"LP": _chamber("LP", "LoadPort"), "PM": _chamber("PM", "ProcessChamber")},
            {"R": _robot("R", ["LP", "PM"])},
            [_wafer(0, 1, "LP", "PM", "R")],
        )
        initial = MachineState.from_sources(problem, None)
        initial.stations["LP"].slots[1] = SlotState()
        initial.stations["PM"].slots[1] = SlotState(
            SlotPhase.UNPROCESSED,
            MaterialState(1, "P0", 1),
            busy_until=4.0,
        )
        initial.stations["PM"].door = DoorState.OPEN
        initial.robots["R"].position = "PM"
        machine = Machine(problem, initial, current_time=3.0)

        result = machine.run(HeuristicMachineSelector())
        moves = [dict(move) for move in result.moves]

        self.assertEqual(7, moves[0]["MoveType"])
        self.assertEqual(9, moves[1]["MoveType"])
        self.assertEqual([], validate_move_list(problem, moves, initial))

    def test_dummy_wac_is_internal_event_between_dummy_and_product(self) -> None:
        """dummy 片离开 PM 后应由 Machine 插入无片 WAC，不交给策略选择。"""
        wafers = [
            Wafer(
                index,
                index + 1,
                "dummy-clean",
                index,
                [
                    Stage(0, "LP", "source", 0.0, "", "R", -1.0, slot=index),
                    Stage(1, "PM", "process", 2.0, "R", "R", -1.0),
                    Stage(2, "LP", "sink", 0.0, "R", "", -1.0, slot=index),
                ],
                ["R", "R"],
                "Dummy" if index == 0 else "Product",
            )
            for index in range(2)
        ]
        problem = Problem(
            {
                "LP": Chamber(
                    **{
                        **_chamber("LP", "LoadPort").__dict__,
                        "capacity": 2,
                    }
                ),
                "PM": _chamber("PM", "ProcessChamber"),
            },
            {"R": _robot("R", ["LP", "PM"])},
            wafers,
            dummy_wac=[CleanSpec(["PM"], 3.0, "WAC")],
            dummy_owner={"Dummy": "Product"},
        )

        result = Machine(problem).run(HeuristicMachineSelector())
        moves = [dict(move) for move in result.moves]
        empty_clean = [
            move
            for move in moves
            if move["MoveType"] == 9
            and move.get("ModuleName") == "PM"
            and not move.get("MatIDList")
        ]

        self.assertEqual(1, len(empty_clean))
        self.assertEqual("WAC", empty_clean[0]["RecipeName"])
        self.assertEqual([], validate_move_list(problem, moves))

    def test_pre_periodic_and_post_clean_are_automatic_events(self) -> None:
        """前清洗、周期 WAC 和后清洗都应自动占用 PM，候选中不出现清洗动作。"""
        wafer = _wafer(0, 1, "LP", "PM", "R")
        wafer.stages[1].clean_time = 2.0
        wafer.stages[1].clean_trigger = 1
        wafer.stages[1].clean_recipe = "Periodic"
        problem = Problem(
            {"LP": _chamber("LP", "LoadPort"), "PM": _chamber("PM", "ProcessChamber")},
            {"R": _robot("R", ["LP", "PM"])},
            [wafer],
            pre_clean=[CleanSpec(["PM"], 3.0, "Pre")],
            post_clean=[CleanSpec(["PM"], 4.0, "Post")],
        )
        machine = Machine(problem)

        self.assertTrue(
            all(
                move.get("MatIDList")
                for action in machine.get_robot_actions()
                for move in action.move_preview
                if move["MoveType"] == 9
            )
        )
        moves = [dict(move) for move in machine.run(HeuristicMachineSelector()).moves]
        clean_recipes = [
            move.get("RecipeName")
            for move in moves
            if move["MoveType"] == 9 and not move.get("MatIDList")
        ]

        self.assertEqual(["Pre", "Periodic", "Post"], clean_recipes)
        self.assertEqual([], validate_move_list(problem, moves))


if __name__ == "__main__":
    unittest.main()
