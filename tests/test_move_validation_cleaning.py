"""平台 WAC、Pre/PostClean 与 Dummy 清洁校验测试。"""

from __future__ import annotations

from types import SimpleNamespace

from realtime_scheduler.backend.validation.move_validation import (
    ATMOSPHERE,
    VACUUM,
    DoorState,
    LoadLockState,
    MachineState,
    MaterialState,
    MoveStateReplay,
    RobotState,
    SlotPhase,
    SlotState,
    ValidationErrorCode,
    validate_move_list,
)
from tests.support.move_validation_fixtures import (
    dual_chamber_update as _dual_chamber_update,
    move as _move,
)

def test_platform_rejects_product_process_after_wac_counter_expires() -> None:
    """当前 ProcessCount 已达到阈值时，产品工艺必须先执行 WAC。"""
    update = {
        "Stations": {
            "PM1": {
                "Type": "ProcessChamber",
                "Capacity": 1,
                "StateVariables": {
                    "ProcessCount": {"Value": {"Value": 2}},
                },
            },
        },
        "Robots": {},
        "Materials": [{
            "ID": 101,
            "CurrentModuleName": "PM1",
            "SlotID": 1,
            "StepID": 4,
            "PJobName": "P1",
        }],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {
                "RouteSteps": [{
                    "Visits": [{
                        "StationName": "PM1",
                        "ProcessRecipe": "ProductRecipe",
                        "AfterOutPM": [{
                            "CheckConditions": {
                                "WAC": [{
                                    "TaskName": "WacClean",
                                    "UpdateStateVariables": ["ProcessCount"],
                                }],
                            },
                            "ExecuteOrder": [{
                                "StateVariableName": "ProcessCount",
                                "ThresholdValueList": [2, 9999],
                            }],
                        }],
                    }],
                }],
            },
        }],
    }
    state = MachineState.from_sources(None, update)
    state.stations["PM1"].slots[1].phase = SlotPhase.UNPROCESSED
    state.stations["PM1"].slots[1].material = MaterialState(101, "P1", 4)

    issues = validate_move_list(
        None,
        [_move(
            1,
            9,
            0,
            10,
            ModuleName="PM1",
            MatIDList=[101],
            StepIDList=[4],
            SlotList=[1],
            PJobName=["P1"],
            ProcessRecipe="ProductRecipe",
        )],
        state,
    )

    assert issues == [
        "[MVL-CLEAN-WAC-MISSING] MoveID=1 MoveType=9：WacClean 到期后仍开始产品工艺 count=2 PJob=P1"
    ]
    assert validate_move_list(
        None,
        [_move(
            1, 9, 0, 10, ModuleName="PM1", MatIDList=[101],
            StepIDList=[4], SlotList=[1], PJobName=["P1"],
            ProcessRecipe="ProductRecipe",
        )],
        state,
        skipped_clean_validation_types=["wacclean"],
    ) == []

def test_platform_rejects_wac_clean_before_counter_threshold() -> None:
    """WAC 清洁必须在同一 PM 的对应 PJob 计数达到阈值后才可执行。"""
    update = {
        "Stations": {
            "PM1": {
                "Type": "ProcessChamber",
                "Capacity": 1,
                "StateVariables": {
                    "ProcessCount": {"Value": {"Value": 1}},
                },
            },
        },
        "Robots": {},
        "Materials": [],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {
                "RouteSteps": [{
                    "Visits": [{
                        "StationName": "PM1",
                        "ProcessRecipe": "ProductRecipe",
                        "AfterOutPM": [{
                            "CheckConditions": {
                                "WAC": [{
                                    "TaskName": "WacClean",
                                    "UpdateStateVariables": ["ProcessCount"],
                                }],
                            },
                            "ExecuteOrder": [{
                                "StateVariableName": "ProcessCount",
                                "ThresholdValueList": [2, 9999],
                            }],
                        }],
                    }],
                }],
            },
        }],
    }

    issues = validate_move_list(
        None,
        [_move(
            1,
            9,
            0,
            10,
            ModuleName="PM1",
            MatIDList=[],
            SlotList=[1],
            PJobName=["P1"],
            CleanTaskName="WacClean",
            ProcessRecipe="WacRecipe",
            IsLastCleanTaskMove=True,
        )],
        update,
    )

    assert issues == [
        "[MVL-CLEAN-WAC-EARLY] MoveID=1 MoveType=9：WacClean 未达到 Wac 阈值就执行 count=1 PJob=P1"
    ]

def test_single_chamber_wac_counter_isolated_by_pjob() -> None:
    """单腔 PM 的一个 PJob 到期不得阻止另一个 PJob 的产品加工。"""
    update = {
        "Stations": {"PM1": {
            "Type": "ProcessChamber",
            "Capacity": 1,
            "StateVariables": {"ProcessCount": {"Value": {"Value": 0}}},
        }},
        "Robots": {},
        "Materials": [{
            "ID": 102,
            "CurrentModuleName": "PM1",
            "SlotID": 1,
            "StepID": 4,
            "PJobName": "P2",
        }],
        "ProcessRecipes": [{
            "ModuleName": "PM1",
            "Name": "ProductRecipe",
            "Weight": {"ProcessCount": 1},
        }],
        "ProcessJobs": [
            {
                "JobName": pjob_name,
                "OriginRoute": {"RouteSteps": [{"Visits": [{
                    "StationName": "PM1",
                    "ProcessRecipe": "ProductRecipe",
                    "AfterOutPM": [{
                        "CheckConditions": {"WAC": [{
                            "TaskName": "WacClean",
                            "UpdateStateVariables": ["ProcessCount"],
                        }]},
                        "ExecuteOrder": [{
                            "StateVariableName": "ProcessCount",
                            "ThresholdValueList": [2, 9999],
                        }],
                    }],
                }]}]},
            }
            for pjob_name in ("P1", "P2")
        ],
    }
    state = MachineState.from_sources(None, update)
    station = state.stations["PM1"]
    state.add_wac_counter(station, "P1", "ProcessCount", 2)
    station.slots[1].phase = SlotPhase.UNPROCESSED

    assert state.wac_counter_value(station, "P1", "ProcessCount") == 2
    assert state.wac_counter_value(station, "P2", "ProcessCount") == 0
    assert validate_move_list(
        None,
        [_move(
            1, 9, 0, 10,
            ModuleName="PM1", MatIDList=[102], StepIDList=[4], SlotList=[1],
            PJobName=["P2"], ProcessRecipe="ProductRecipe",
        )],
        state,
    ) == []
    state.add_wac_counter(station, "P2", "ProcessCount", 1)
    state.reset_wac_counter(station, ["P1"], "ProcessCount")
    assert state.wac_counter_value(station, "P1", "ProcessCount") == 0
    assert state.wac_counter_value(station, "P2", "ProcessCount") == 1

def test_dual_chamber_wac_counter_remains_global() -> None:
    """双腔 PM 的不同 PJob 仍必须共用腔室 WAC 计数。"""
    update = {
        "Stations": {"PM1": {
            "Type": "MultiProcessChamber",
            "Capacity": 2,
            "StateVariables": {"ProcessCount": {"Value": {"Value": 2}}},
        }},
        "Robots": {},
        "Materials": [{
            "ID": 102,
            "CurrentModuleName": "PM1",
            "SlotID": 1,
            "StepID": 4,
            "PJobName": "P2",
        }],
        "ProcessJobs": [
            {
                "JobName": pjob_name,
                "OriginRoute": {"RouteSteps": [{"Visits": [{
                    "StationName": "PM1",
                    "ProcessRecipe": "ProductRecipe",
                    "AfterOutPM": [{
                        "CheckConditions": {"WAC": [{
                            "TaskName": "WacClean",
                            "UpdateStateVariables": ["ProcessCount"],
                        }]},
                        "ExecuteOrder": [{
                            "StateVariableName": "ProcessCount",
                            "ThresholdValueList": [2, 9999],
                        }],
                    }],
                }]}]},
            }
            for pjob_name in ("P1", "P2")
        ],
    }

    issues = validate_move_list(
        None,
        [_move(
            1, 9, 0, 10,
            ModuleName="PM1", MatIDList=[102], StepIDList=[4], SlotList=[1],
            PJobName=["P2"], ProcessRecipe="ProductRecipe",
        )],
        update,
    )

    assert issues == [
        "[MVL-CLEAN-WAC-MISSING] MoveID=1 MoveType=9：WacClean 到期后仍开始产品工艺 count=2 PJob=P2"
    ]

def test_skipping_wac_only_ignores_counter_threshold() -> None:
    """跳过 WAC 后只忽略次数阈值，Clean 动作仍进入完整物理校验。"""
    update = {
        "Stations": {"PM1": {
            "Type": "ProcessChamber",
            "Capacity": 1,
            "StateVariables": {"ProcessCount": {"Value": {"Value": 1}}},
        }},
        "Robots": {},
        "Materials": [],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {"RouteSteps": [{"Visits": [{
                "StationName": "PM1",
                "ProcessRecipe": "ProductRecipe",
                "AfterOutPM": [{
                    "CheckConditions": {"WAC": [{
                        "TaskName": "WacClean",
                        "CleanRecipe": "WacRecipe",
                        "UpdateStateVariables": ["ProcessCount"],
                    }]},
                    "ExecuteOrder": [{
                        "StateVariableName": "ProcessCount",
                        "ThresholdValueList": [2, 9999],
                    }],
                }],
            }]}]},
        }],
    }
    move = _move(
        1, 9, 0, 10,
        ModuleName="PM1",
        MatIDList=[],
        SlotList=[1],
        PJobName=["P1"],
        CleanTaskName="WacClean",
        ProcessRecipe="WacRecipe",
        IsLastCleanTaskMove=True,
    )

    assert validate_move_list(
        None,
        [move],
        update,
        skipped_clean_validation_types=["wacclean"],
    ) == []

    open_door_state = MachineState.from_sources(None, update)
    open_door_state.stations["PM1"].door = DoorState.OPEN
    issues = validate_move_list(
        None,
        [move],
        open_door_state,
        skipped_clean_validation_types=["wacclean"],
    )
    assert issues and "加工或清洁时必须关门" in issues[0]

    wrong_recipe_move = {**move, "ProcessRecipe": "WrongRecipe"}
    issues = validate_move_list(
        None,
        [wrong_recipe_move],
        update,
        skipped_clean_validation_types=["wacclean"],
    )
    assert issues and "MVL-CLEAN-RECIPE-INVALID" in issues[0]

def test_skipped_clean_still_requires_recipe_and_dummy_material() -> None:
    """跳过触发义务不能放过错误 Recipe，也不能把 Dummy Clean 当空腔 Clean。"""
    pre_update = {
        "Stations": {"PM1": {"Type": "ProcessChamber", "Capacity": 1}},
        "Robots": {},
        "Materials": [],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {"PrePJob": {"PM1": [{
                "CheckConditions": {"Pre": [{
                    "TaskName": "PreClean",
                    "CleanRecipe": "PreRecipe",
                    "MaterialCount": 0,
                }]},
            }]}},
        }],
    }
    wrong_recipe = _move(
        1, 9, 0, 10,
        ModuleName="PM1", MatIDList=[], SlotList=[1], PJobName=["P1"],
        CleanTaskName="PreClean", ProcessRecipe="WrongRecipe",
        IsLastCleanTaskMove=True,
    )
    issues = validate_move_list(
        None, [wrong_recipe], pre_update,
        skipped_clean_validation_types=["preclean"],
    )
    assert issues and "MVL-CLEAN-RECIPE-INVALID" in issues[0]

    dummy_update = {
        "Stations": {"PM1": {"Type": "ProcessChamber", "Capacity": 1}},
        "Robots": {},
        "Materials": [],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {"PrePJob": {"PM1": [{
                "CheckConditions": {"Dummy": [{
                    "TaskName": "PreDummyClean",
                    "CleanRecipe": "DummyRecipe",
                    "MaterialCount": 2,
                }]},
            }]}},
        }],
    }
    empty_dummy_clean = _move(
        1, 9, 0, 10,
        ModuleName="PM1", MatIDList=[], SlotList=[1], PJobName=["P1"],
        CleanTaskName="PreDummyClean", ProcessRecipe="DummyRecipe",
        IsLastCleanTaskMove=True,
    )
    issues = validate_move_list(
        None, [empty_dummy_clean], dummy_update,
        skipped_clean_validation_types=["dummy"],
    )
    assert issues and "必须先完成足量 Dummy" in issues[0]

def test_dummy_wac_empty_tail_follows_each_completed_dummy_stage() -> None:
    """每片 Dummy 带片清洁后都应立即允许且只允许一次空腔 WAC。"""
    update = {
        "Stations": {"PM1": {"Type": "ProcessChamber", "Capacity": 1}},
        "Robots": {},
        "Materials": [],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {"PrePJob": {"PM1": [{
                "CheckConditions": {"DummyWac": [{
                    "TaskName": "PreWacClean",
                    "CleanRecipe": "DummyRecipe",
                    "EmptyCleanRecipeAfterMaterial": "EmptyWacRecipe",
                    "MaterialCount": 2,
                }]},
            }]}},
        }],
    }
    move = _move(
        1, 9, 0, 10,
        ModuleName="PM1", MatIDList=[], SlotList=[1], PJobName=["P1"],
        CleanTaskName="WacClean", ProcessRecipe="EmptyWacRecipe",
        IsLastCleanTaskMove=True,
    )
    state = MachineState.from_sources(None, update)

    issues = validate_move_list(None, [move], state)
    assert issues and "必须紧跟一片" in issues[0]

    clean_key = ("P1", "PM1", "PreWacClean")
    state.completed_clean_counts[clean_key] = 1
    assert validate_move_list(None, [move], state) == []

    state.completed_dummy_wac_counts[clean_key] = 1
    issues = validate_move_list(None, [move], state)
    assert issues and "必须紧跟一片" in issues[0]

    state.completed_clean_counts[clean_key] = 2
    assert validate_move_list(None, [move], state) == []

def test_dummy_wac_blocks_next_dummy_and_product_until_tail_completed() -> None:
    """未完成上一片尾随 WAC 时，不得继续下一片 Dummy 或开始产品工艺。"""
    update = {
        "Stations": {"PM1": {"Type": "ProcessChamber", "Capacity": 1}},
        "Robots": {},
        "Materials": [],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {"PrePJob": {"PM1": [{
                "CheckConditions": {"DummyWac": [{
                    "TaskName": "PreWacClean",
                    "CleanRecipe": "DummyRecipe",
                    "EmptyCleanRecipeAfterMaterial": "EmptyWacRecipe",
                    "MaterialCount": 2,
                }]},
            }]}},
        }],
    }
    state = MachineState.from_sources(None, update)
    clean_key = ("P1", "PM1", "PreWacClean")
    state.completed_clean_counts[clean_key] = 1
    state.stations["PM1"].slots[1] = SlotState(
        phase=SlotPhase.UNPROCESSED,
        material=MaterialState(101, pjob_name="dummy_P1"),
    )
    next_dummy = _move(
        1, 9, 0, 10,
        ModuleName="PM1", MatIDList=[101], SlotList=[1], PJobName=["P1"],
        CleanTaskName="PreWacClean", ProcessRecipe="DummyRecipe",
        IsLastCleanTaskMove=True,
    )
    issues = validate_move_list(None, [next_dummy], state)
    assert issues and "上一片 Dummy 离腔后必须先完成空腔 WAC" in issues[0]

    state.completed_clean_counts[clean_key] = 2
    state.completed_dummy_wac_counts[clean_key] = 1
    state.stations["PM1"].slots[1] = SlotState(
        phase=SlotPhase.UNPROCESSED,
        material=MaterialState(201, pjob_name="P1"),
    )
    product_process = _move(
        2, 9, 10, 20,
        ModuleName="PM1", MatIDList=[201], SlotList=[1], PJobName=["P1"],
        ProcessRecipe="ProductRecipe",
    )
    issues = validate_move_list(None, [product_process], state)
    assert issues and "MVL-CLEAN-DUMMY-MISSING" in issues[0]
    assert "required=2 actual=1" in issues[0]

    state.completed_dummy_wac_counts[clean_key] = 2
    assert validate_move_list(None, [product_process], state) == []

def test_platform_requires_preclean_before_first_product_process() -> None:
    """平台必须独立拦截未完成 PreClean 的 PJob 首片加工。"""
    update = {
        "Stations": {"PM1": {"Type": "ProcessChamber", "Capacity": 1}},
        "Robots": {},
        "Materials": [{
            "ID": 101,
            "CurrentModuleName": "PM1",
            "SlotID": 1,
            "StepID": 4,
            "PJobName": "P1",
        }],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {
                "PrePJob": {"PM1": [{
                    "CheckConditions": {"Pre": [{
                        "TaskName": "PreClean",
                        "CleanRecipe": "PreRecipe",
                        "MaterialCount": 0,
                    }]},
                }]},
            },
        }],
    }
    state = MachineState.from_sources(None, update)
    state.stations["PM1"].slots[1].phase = SlotPhase.UNPROCESSED
    state.stations["PM1"].slots[1].material = MaterialState(101, "P1", 4)

    issues = validate_move_list(
        None,
        [_move(
            1, 9, 0, 10, ModuleName="PM1", MatIDList=[101], StepIDList=[4],
            SlotList=[1], PJobName=["P1"], ProcessRecipe="ProductRecipe",
        )],
        state,
    )

    assert issues == [
        "[MVL-CLEAN-PRE-MISSING] MoveID=1 MoveType=9：PreClean 未完成就开始产品工艺 required=1 actual=0 PJob=P1"
    ]

    assert validate_move_list(
        None,
        [_move(1, 9, 0, 10, ModuleName="PM1", MatIDList=[101], StepIDList=[4], SlotList=[1], PJobName=["P1"], ProcessRecipe="ProductRecipe")],
        state,
        skipped_clean_validation_types=["preclean"],
    ) == []

def test_platform_rejects_duplicate_preclean_for_same_pjob_station() -> None:
    """同一 PJob/PM 的一次性 PreClean 完成后不得再次执行。"""
    update = {
        "Stations": {"PM1": {"Type": "ProcessChamber", "Capacity": 1}},
        "Robots": {},
        "Materials": [],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {
                "PrePJob": {"PM1": [{
                    "CheckConditions": {"Pre": [{
                        "TaskName": "PreClean",
                        "CleanRecipe": "PreRecipe",
                        "MaterialCount": 0,
                    }]},
                }]},
            },
        }],
    }
    state = MachineState.from_sources(None, update)
    first_clean = _move(
        1,
        9,
        0,
        10,
        ModuleName="PM1",
        MatIDList=[],
        SlotList=[1],
        PJobName=["P1"],
        CleanTaskName="PreClean",
        ProcessRecipe="PreRecipe",
        IsLastCleanTaskMove=True,
    )
    duplicate_clean = {
        **first_clean,
        "MoveID": 2,
        "StartTime": 10,
        "EndTime": 20,
    }

    issues = validate_move_list(None, [first_clean, duplicate_clean], state)

    assert issues == [
        "[MVL-CLEAN-PRE-DUPLICATE] MoveID=2 MoveType=9："
        "PreClean 已完成，不能重复执行 required=1 actual=1 PJob=P1"
    ]

def test_platform_requires_postclean_after_product_process() -> None:
    """产品加工已完成而当前代计划没有 PostClean 时必须报义务缺失。"""
    update = {
        "Stations": {"PM1": {"Type": "ProcessChamber", "Capacity": 1}},
        "Robots": {},
        "Materials": [{"ID": 101, "CurrentModuleName": "PM1", "SlotID": 1, "StepID": 4, "PJobName": "P1"}],
        "ProcessJobs": [{"JobName": "P1", "OriginRoute": {"PostPJob": {"PM1": [{"CheckConditions": {"Post": [{"TaskName": "PostClean", "CleanRecipe": "PostRecipe", "MaterialCount": 0}]}}]}}}],
    }
    state = MachineState.from_sources(None, update)
    state.stations["PM1"].slots[1].phase = SlotPhase.UNPROCESSED
    state.stations["PM1"].slots[1].material = MaterialState(101, "P1", 4)
    issues = validate_move_list(None, [_move(1, 9, 0, 10, ModuleName="PM1", MatIDList=[101], StepIDList=[4], SlotList=[1], PJobName=["P1"], ProcessRecipe="ProductRecipe")], state)
    assert issues == ["[MVL-CLEAN-POST-MISSING] PostClean 未完成 required=1 actual=0 PJob=P1 PM=PM1"]
    assert validate_move_list(
        None,
        [_move(1, 9, 0, 10, ModuleName="PM1", MatIDList=[101], StepIDList=[4], SlotList=[1], PJobName=["P1"], ProcessRecipe="ProductRecipe")],
        state,
        skipped_clean_validation_types=["postclean"],
    ) == []

def test_skipping_preclean_does_not_skip_dummy_clean_obligation() -> None:
    """同一 PM 有多类前置 Clean 时，只跳过被明确取消的类别。"""
    update = {
        "Stations": {"PM1": {"Type": "ProcessChamber", "Capacity": 1}},
        "Robots": {},
        "Materials": [{
            "ID": 101, "CurrentModuleName": "PM1", "SlotID": 1,
            "StepID": 4, "PJobName": "P1",
        }],
        "ProcessJobs": [{
            "JobName": "P1",
            "OriginRoute": {"PrePJob": {"PM1": [{
                "CheckConditions": {
                    "Pre": [{
                        "TaskName": "PreClean", "CleanRecipe": "PreRecipe",
                        "MaterialCount": 0,
                    }],
                    "Dummy": [{
                        "TaskName": "PreDummyClean", "CleanRecipe": "DummyRecipe",
                        "MaterialCount": 2,
                    }],
                },
            }]}},
        }],
    }
    state = MachineState.from_sources(None, update)
    state.stations["PM1"].slots[1].phase = SlotPhase.UNPROCESSED
    state.stations["PM1"].slots[1].material = MaterialState(101, "P1", 4)
    product_move = _move(
        1, 9, 0, 10, ModuleName="PM1", MatIDList=[101], StepIDList=[4],
        SlotList=[1], PJobName=["P1"], ProcessRecipe="ProductRecipe",
    )

    issues = validate_move_list(
        None, [product_move], state,
        skipped_clean_validation_types=["preclean"],
    )
    assert issues and "MVL-CLEAN-DUMMY-MISSING" in issues[0]
