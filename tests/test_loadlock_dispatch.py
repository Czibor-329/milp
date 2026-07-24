"""LoadLock Petri-ETA 群控与前端配置边界的单元测试。

这些测试刻意使用最小解码状态，分别验证两层电梯式压力侧偏好、稳定决策、
逻辑 hop 与物理 LoadLock 选择的职责分离，以及前端配置的可见性和持久化。
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Iterable, Mapping

from realtime_scheduler.server import (
    create_workspace_test,
    get_workspace_device,
    import_workspace_device,
    update_workspace_test,
)
from src.export import check_solution
from src.parse import load_alg_entries, parse_task
from src.parse.generator import PM_POOL_6, expand_topo_pms
from src.paths import input_data_path
from src.schedule.api import start_schedule
from src.schedule.loadlock_dispatch import (
    ENTRY,
    EXIT,
    PetriLookLoadLockManager,
    resolve_loadlock_manager,
    separate_loadlock_choice,
)


ROOT = Path(__file__).resolve().parents[1]
PSE300_PATH = ROOT / "src" / "input_data" / "PSE300.json"
EDITOR_PATH = ROOT / "realtime_scheduler" / "frontend" / "config_editor.html"
HEURISTIC_INSTANCE = ROOT / "dataset" / "test" / "1stage" / "inst_0005.json"
LOADLOCK_NAMES = ("LA", "LB")


def _stage(stage_type: str, loadlock_direction: str = "") -> SimpleNamespace:
    """创建 manager 所需字段齐全的最小 Route stage。"""
    return SimpleNamespace(
        stage_type=stage_type,
        ll_type=loadlock_direction,
    )


def _wafer(loadlock_direction: str) -> SimpleNamespace:
    """创建经指定方向 LoadLock 的最小晶圆 Route。"""
    return SimpleNamespace(
        already_released=False,
        stages=[
            _stage("source"),
            _stage("loadlock", loadlock_direction),
            _stage("sink"),
        ],
    )


def _candidate(
    wafer_id: int,
    loadlock: str,
    earliest_start: float = 10.0,
) -> SimpleNamespace:
    """创建从 source 发往指定 LoadLock 的安全物理候选。"""
    return SimpleNamespace(
        wid=wafer_id,
        j=0,
        dest=(loadlock, 0),
        start=earliest_start,
    )


def _decode_state(
    request_directions: Mapping[int, str],
    *,
    last_directions: Mapping[str, str] | None = None,
    ready_times: Mapping[str, float] | None = None,
    planned_ready_times: Mapping[str, float] | None = None,
    service_counts: Mapping[str, int] | None = None,
) -> SimpleNamespace:
    """构造仅含 manager 读取字段的最小解码标识。

    ``last_directions`` 模拟每把锁最后完成的载片方向：entry 后停在真空侧，
    exit 后停在大气侧。请求晶圆保持在 source，不人为制造真空在制品。
    """
    wafers = {
        wafer_id: _wafer(direction)
        for wafer_id, direction in request_directions.items()
    }
    loadlock_last_services = {}
    for offset, (loadlock, direction) in enumerate(
        (last_directions or {}).items(),
        start=1,
    ):
        history_wafer_id = -offset
        wafers[history_wafer_id] = _wafer(direction)
        loadlock_last_services[loadlock] = (history_wafer_id, 1)

    runtime = SimpleNamespace(
        loadlock_environment={
            loadlock: "atmosphere" for loadlock in LOADLOCK_NAMES
        },
        station_ready=dict(ready_times or {}),
    )
    return SimpleNamespace(
        ir=SimpleNamespace(
            chambers={
                loadlock: SimpleNamespace(
                    type="loadlock",
                    capacity=2,
                    pump_time=20.0,
                    vent_time=30.0,
                )
                for loadlock in LOADLOCK_NAMES
            },
            runtime_availability=runtime,
        ),
        wmap=wafers,
        pos={wafer_id: 0 for wafer_id in request_directions},
        K={wafer_id: 2 for wafer_id in request_directions},
        occ={},
        loadlock_last_services=loadlock_last_services,
        loadlock_service_counts=dict(service_counts or {}),
        loadlock_ready_at=dict(planned_ready_times or {}),
    )


class PetriLookLoadLockManagerTests(unittest.TestCase):
    """验证两层 LOOK 直觉和职责分离，不依赖完整排程器。"""

    def setUp(self) -> None:
        """为每个案例创建无状态的 Petri-LOOK manager。"""
        self.manager = PetriLookLoadLockManager()

    def test_pressure_cycle_enters_estimated_finish_time(self) -> None:
        """同释放时刻应选择免空抽/空充、预计完成更早的锁。"""
        history = {"LA": ENTRY, "LB": EXIT}
        for request_direction, expected_loadlock in (
            (EXIT, "LA"),
            (ENTRY, "LB"),
        ):
            with self.subTest(request_direction=request_direction):
                state = _decode_state(
                    {1: request_direction},
                    last_directions=history,
                )
                candidates = [
                    _candidate(1, "LA"),
                    _candidate(1, "LB"),
                ]

                decisions = self.manager.quote(state, candidates, range(2))

                self.assertEqual(expected_loadlock, decisions[0].loadlock)
                self.assertEqual(0, decisions[0].empty_pressure_cycles)
                self.assertEqual(1, decisions[1].empty_pressure_cycles)

    def test_eta_can_override_pressure_side_preference(self) -> None:
        """当前压力侧释放过晚时，应选择需要空循环但更早完成的锁。"""
        state = _decode_state(
            {1: EXIT},
            last_directions={"LA": ENTRY, "LB": EXIT},
            ready_times={"LA": 100.0, "LB": 0.0},
        )
        candidates = [
            _candidate(1, "LA"),
            _candidate(1, "LB"),
        ]

        decisions = self.manager.quote(state, candidates, range(2))

        self.assertEqual("LB", decisions[0].loadlock)
        self.assertEqual(1, decisions[0].empty_pressure_cycles)
        self.assertLess(
            decisions[0].service_finish_at,
            decisions[1].service_finish_at,
        )

    def test_eta_carries_forward_planned_loadlock_completion(self) -> None:
        """解码中已提交的抽充气完成时刻必须进入下一次报价。"""
        state = _decode_state(
            {1: ENTRY},
            last_directions={"LA": EXIT, "LB": EXIT},
            ready_times={"LA": 0.0, "LB": 0.0},
            planned_ready_times={"LA": 100.0, "LB": 0.0},
        )
        candidates = [
            _candidate(1, "LA"),
            _candidate(1, "LB"),
        ]

        decisions = self.manager.quote(state, candidates, range(2))

        self.assertEqual("LB", decisions[0].loadlock)
        self.assertEqual(100.0, decisions[1].access_ready_at)

    def test_equal_quotes_use_stable_loadlock_name_tie_break(self) -> None:
        """完全同分时应固定选择 LA，不受候选输入排列影响。"""
        state = _decode_state({1: ENTRY})
        candidates = [
            _candidate(1, "LB"),
            _candidate(1, "LA"),
        ]

        first = self.manager.rank_candidates(state, candidates, [0, 1])
        second = self.manager.rank_candidates(state, candidates, [1, 0])

        self.assertEqual([1, 0], first)
        self.assertEqual(first, second)

    def test_separated_choice_preserves_logical_hop_order(self) -> None:
        """manager 只能重排组内 LA/LB，不能改变主 chooser 的晶圆顺序。"""
        state = _decode_state({1: ENTRY, 2: ENTRY})
        candidates = [
            _candidate(2, "LB"),
            _candidate(1, "LB"),
            _candidate(2, "LA"),
            _candidate(1, "LA"),
        ]

        def logical_chooser(
            _state: SimpleNamespace,
            _candidates: Iterable[SimpleNamespace],
        ) -> list[int]:
            """模拟主调度器先选晶圆 2、再选晶圆 1 的逻辑偏好。"""
            self.assertEqual(2, len(list(_candidates)))
            return [0, 1]

        chooser = separate_loadlock_choice(logical_chooser, self.manager)
        ordered = chooser(state, candidates)

        self.assertEqual([2, 0, 3, 1], ordered)
        self.assertEqual(
            [(2, 0), (2, 0), (1, 0), (1, 0)],
            [(candidates[index].wid, candidates[index].j) for index in ordered],
        )
        self.assertEqual(set(range(4)), set(ordered))


class LoadLockManagerHeuristicTests(unittest.TestCase):
    """验证公共 manager 能被 Heuristic 使用并改善完整排程。"""

    @classmethod
    def setUpClass(cls) -> None:
        """加载一例双锁瓶颈场景，分别运行旧固定锁和公共 manager。"""
        topology, _ = load_alg_entries(input_data_path("s1-1c1p-preclean"))
        topology = expand_topo_pms(topology, PM_POOL_6)
        payload = json.loads(HEURISTIC_INSTANCE.read_text(encoding="utf-8"))
        cls.problem = parse_task(topology, payload["update_params"])

    def test_manager_materially_improves_heuristic_without_losing_safety(self) -> None:
        """动态绑定应在该独立案例降低至少 10% makespan，且保持全约束可行。"""
        baseline = start_schedule(
            self.problem,
            verbose=False,
            loadlock_manager=None,
        )
        managed = start_schedule(
            self.problem,
            verbose=False,
            loadlock_manager="petri-eta",
        )

        self.assertTrue(getattr(baseline, "feasible", False))
        self.assertTrue(getattr(managed, "feasible", False))
        self.assertEqual([], check_solution(self.problem, managed))
        self.assertEqual(
            "petri-eta-v2",
            getattr(managed, "loadlock_manager", ""),
        )
        self.assertLessEqual(
            float(managed.makespan) / float(baseline.makespan),
            0.90,
        )

    def test_heuristic_accepts_a_custom_manager_instance(self) -> None:
        """公共入口应依赖 manager 协议，而不是写死 Petri-ETA 类名。"""

        class CustomManager(PetriLookLoadLockManager):
            name = "custom-test-manager"

        manager = CustomManager()
        self.assertIs(manager, resolve_loadlock_manager(manager))

        result = start_schedule(
            self.problem,
            verbose=False,
            loadlock_manager=manager,
        )

        self.assertTrue(getattr(result, "feasible", False))
        self.assertEqual([], check_solution(self.problem, result))
        self.assertEqual(
            "custom-test-manager",
            result.loadlock_manager_requested,
        )


class LoadLockManagerFrontendTests(unittest.TestCase):
    """验证 Neural LoadLock manager 选项可见且可随测试集保存。"""

    def test_editor_exposes_recommended_petri_look_option(self) -> None:
        """公共设置应提供 Petri-ETA/联合选择两项并默认公共 manager。"""
        html = "\n".join([
            EDITOR_PATH.read_text(encoding="utf-8"),
            (
                ROOT / "realtime_scheduler" / "frontend" / "src" / "config_editor.ts"
            ).read_text(encoding="utf-8"),
        ])

        self.assertIn('id="loadlockOptions"', html)
        self.assertIn('data-option="loadLockManager"', html)
        self.assertIn(
            '<option value="petri-look">Petri-ETA 通用管理器（Heuristic 推荐）</option>',
            html,
        )
        self.assertIn(
            '<option value="joint">当前策略联合选择 LA/LB（现有 Neural 默认）</option>',
            html,
        )
        self.assertIn(
            '["heuristic", "neural", "rl"].includes(state.strategy)',
            html,
        )
        self.assertIn(
            'state.options.loadLockManager = '
            'state.options.loadLockManager || "petri-look"',
            html,
        )
        self.assertIn(
            "if (control.dataset.option) "
            "{ state.options[control.dataset.option] = value; return; }",
            html,
        )
        self.assertIn("options: state.options", html)

    def test_workspace_round_trip_preserves_loadlock_manager(self) -> None:
        """创建和更新测试集后，所选 manager 必须从工作区原样读回。"""
        device_data = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device(
                PSE300_PATH.name,
                device_data,
                store_path,
            )
            raw_test = {
                "name": "LoadLock manager 配置",
                "strategy": "neural",
                "roundCount": 1,
                "times": [0],
                "options": {"loadLockManager": "joint"},
                "rounds": [{"currentTime": 0, "cjobs": []}],
            }

            created = create_workspace_test(device["id"], raw_test, store_path)
            loaded = get_workspace_device(device["id"], store_path)["tests"][0]
            self.assertEqual("joint", created["options"]["loadLockManager"])
            self.assertEqual("joint", loaded["options"]["loadLockManager"])

            raw_test["options"]["loadLockManager"] = "petri-look"
            updated = update_workspace_test(
                device["id"],
                created["id"],
                raw_test,
                store_path,
            )
            reloaded = get_workspace_device(device["id"], store_path)["tests"][0]
            self.assertEqual(
                "petri-look",
                updated["options"]["loadLockManager"],
            )
            self.assertEqual(
                "petri-look",
                reloaded["options"]["loadLockManager"],
            )


if __name__ == "__main__":
    unittest.main()
