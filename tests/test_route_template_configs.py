"""验证共享路径模板与测试独有工艺参数的迁移和运行时合并。"""

import json
from pathlib import Path

from realtime_scheduler.backend import application as batch_service
from realtime_scheduler.backend import application as server


ROOT = Path(__file__).resolve().parents[1]


def _legacy_route() -> dict:
    """构造一条带旧版内嵌时间、驻留和 Clean 的 Route。"""
    return {
        "name": "R1",
        "group": "R1",
        "bufferOption": 2,
        "prePJobCleanRefs": ["Pre1"],
        "stages": [
            {
                "stepId": 0,
                "postStepIds": [1],
                "needProcess": False,
                "visits": [{"stationName": "LP1"}],
            },
            {
                "stepId": 1,
                "postStepIds": [2],
                "needProcess": True,
                "visits": [{
                    "stationName": "PM1",
                    "processTime": 37,
                    "recipeTime": 37,
                    "processRecipe": "Recipe1",
                    "qTimeLimit": 55,
                    "residencyConstraint": 66,
                    "afterCleanRefs": ["Wac1"],
                }],
            },
            {
                "stepId": 2,
                "postStepIds": [],
                "needProcess": False,
                "visits": [{"stationName": "LP1"}],
            },
        ],
    }


def test_workspace_migration_copies_parameters_before_stripping_template() -> None:
    """升级旧仓库时应先复制测试参数，再把共享 Route 收敛为纯拓扑。"""
    catalog = {
        "version": 3,
        "devices": [{
            "id": "device-1",
            "device": {"Stations": {}, "Robots": {}},
            "routes": [_legacy_route()],
            "cleans": [{"name": "Pre1"}, {"name": "Wac1"}],
            "tests": [{
                "id": "test-1",
                "name": "Test1",
                "rounds": [{"cjobs": [{"pjobs": [{"routeRef": "R1"}]}]}],
            }],
        }],
    }

    assert server._migrate_workspace_catalog(catalog) is True

    device = catalog["devices"][0]
    template = device["routes"][0]
    assert catalog["version"] == server.WORKSPACE_STORE_VERSION
    assert "bufferOption" not in template
    assert template["stages"][1]["visits"] == [{"stationName": "PM1"}]
    test_case = device["tests"][0]
    assert test_case["routeConfigs"]["R1"]["bufferOption"] == 2
    assert test_case["routeConfigs"]["R1"]["stages"]["1"]["processTime"] == 37
    assert test_case["routeConfigs"]["R1"]["stages"]["1"]["afterCleanRefs"] == ["Wac1"]
    assert [clean["name"] for clean in test_case["cleans"]] == ["Pre1", "Wac1"]


def test_batch_plan_merges_test_parameters_without_mutating_template() -> None:
    """批量运行应使用测试参数生成 Route，同时保持设备模板不变。"""
    template = server._normalized_workspace_routes([_legacy_route()])[0]
    device = {
        "name": "Device1",
        "device": {"Stations": {}, "Robots": {}},
        "routes": [template],
        "cleans": [],
    }
    config = server._workspace_route_config_map([_legacy_route()])
    test_case = {
        "options": {},
        "routeConfigs": config,
        "cleans": [],
        "rounds": [{"currentTime": 0, "cjobs": [{"pjobs": [{"routeRef": "R1"}]}]}],
    }

    plan = batch_service.build_workspace_batch_plan(device, test_case, "heuristic", {})

    visit = plan["routes"][0]["stages"][1]["visits"][0]
    assert visit["processTime"] == 37
    assert visit["qTimeLimit"] == 55
    assert visit["residencyConstraint"] == 66
    assert template["stages"][1]["visits"] == [{"stationName": "PM1"}]


def test_same_template_uses_independent_pjob_route_configs() -> None:
    """两个 CJob 引用同一模板时，应生成互不覆盖的 Route 与 Recipe 实例。"""
    template = server._normalized_workspace_routes([_legacy_route()])[0]
    first_config = server._workspace_route_test_config(_legacy_route())
    second_config = json.loads(json.dumps(first_config))
    second_config["stages"]["1"]["processTime"] = 88
    device = {
        "name": "Device1",
        "device": {
            "Stations": {
                "LP1": {"Type": "LoadPort", "Capacity": 25},
                "LP2": {"Type": "LoadPort", "Capacity": 25},
                "PM1": {"Type": "ProcessChamber", "Capacity": 1},
            },
            "Robots": {},
        },
        "routes": [template],
        "cleans": [],
    }
    test_case = {
        "options": {},
        "routeConfigs": {"R1": first_config},
        "cleans": [],
        "rounds": [{"currentTime": 0, "cjobs": [
            {"taskId": "1", "loadPort": "LP1", "pjobs": [{
                "routeRef": "R1", "routeConfig": first_config,
            }]},
            {"taskId": "2", "loadPort": "LP2", "pjobs": [{
                "routeRef": "R1", "routeConfig": second_config,
            }]},
        ]}],
    }

    plan = batch_service.build_workspace_batch_plan(device, test_case, "heuristic", {})

    route_refs = [cjob["pjobs"][0]["routeRef"] for cjob in plan["rounds"][0]["cjobs"]]
    assert route_refs[0] != route_refs[1]
    route_times = {
        route["name"]: route["stages"][1]["visits"][0]["processTime"]
        for route in plan["routes"]
    }
    assert [route_times[name] for name in route_refs] == [37, 88]
    assert len({recipe["name"] for recipe in plan["recipes"]}) == 2


def test_v6_migration_copies_route_config_to_each_pjob() -> None:
    """v6 的模板级参数应幂等复制到每个 PJob，保留原有运行语义。"""
    config = server._workspace_route_test_config(_legacy_route())
    catalog = {
        "version": 6,
        "devices": [{
            "id": "device-1",
            "device": {"Stations": {}, "Robots": {}},
            "routes": [server._normalized_workspace_routes([_legacy_route()])[0]],
            "tests": [{
                "routeConfigs": {"R1": config},
                "rounds": [{"cjobs": [
                    {"pjobs": [{"routeRef": "R1"}]},
                    {"pjobs": [{"routeRef": "R1"}]},
                ]}],
            }],
        }],
    }

    assert server._migrate_workspace_catalog(catalog) is True
    pjobs = catalog["devices"][0]["tests"][0]["rounds"][0]["cjobs"]
    assert pjobs[0]["pjobs"][0]["routeConfig"] == config
    assert pjobs[1]["pjobs"][0]["routeConfig"] == config
    assert pjobs[0]["pjobs"][0]["routeConfig"] is not pjobs[1]["pjobs"][0]["routeConfig"]
    assert server._migrate_workspace_catalog(catalog) is False


def test_route_save_endpoint_logic_renames_all_test_references(tmp_path) -> None:
    """独立保存模板时应同步所有测试的引用和 routeConfigs 键。"""
    store_path = tmp_path / "workspaces.json"
    route = server._normalized_workspace_routes([_legacy_route()])[0]
    catalog = {
        "version": 4,
        "devices": [{
            "id": "device-1",
            "routes": [route],
            "cleans": [],
            "tests": [{
                "id": "test-1",
                "routeConfigs": {"R1": server._workspace_route_test_config(_legacy_route())},
                "rounds": [{"cjobs": [{"pjobs": [{"routeRef": "R1"}]}]}],
            }],
        }],
    }
    store_path.write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
    renamed_route = {**route, "name": "PM1"}

    result = server.update_workspace_routes(
        "device-1",
        {"routes": [renamed_route], "routeNameChanges": {"R1": "PM1"}},
        store_path,
    )

    test_case = result["tests"][0]
    assert test_case["rounds"][0]["cjobs"][0]["pjobs"][0]["routeRef"] == "PM1"
    assert list(test_case["routeConfigs"]) == ["PM1"]


def test_device_overview_and_route_save_keep_large_test_payloads_lazy(tmp_path) -> None:
    """切换设备和保存 Route 不应传输同设备下的其他完整测试集。"""
    store_path = tmp_path / "workspaces.json"
    route = server._normalized_workspace_routes([_legacy_route()])[0]
    first_test = {
        "id": "test-1", "name": "Test1", "group": "G1",
        "routeConfigs": {"R1": server._workspace_route_test_config(_legacy_route())},
        "rounds": [{"cjobs": [{"pjobs": [{"routeRef": "R1"}]}]}],
    }
    catalog = {
        "version": 4,
        "devices": [{
            "id": "device-1", "device": {"Stations": {}, "Robots": {}},
            "routes": [route], "cleans": [], "tests": [first_test],
        }],
    }
    store_path.write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")

    overview = server.get_workspace_device_overview("device-1", store_path)
    assert overview["tests"] == [{"id": "test-1", "name": "Test1", "group": "G1"}]
    assert server.get_workspace_test("device-1", "test-1", store_path)["rounds"]

    result = server.update_workspace_routes(
        "device-1", {"routes": [route]}, store_path, include_tests=False,
    )
    assert result["testCount"] == 1
    assert "tests" not in result


def test_directory_route_save_is_lazy_and_auto_migrates_old_store(tmp_path) -> None:
    """目录存储升级后，模板改名不再重写历史测试，读取和执行时再解析别名。"""
    store_dir = tmp_path / "workspaces"
    device_dir = store_dir / "device-1"
    tests_dir = device_dir / "tests"
    tests_dir.mkdir(parents=True)
    route = server._normalized_workspace_routes([_legacy_route()])[0]
    test_case = {
        "id": "test-1", "name": "Test1", "group": "",
        "routeConfigs": {"R1": server._workspace_route_test_config(_legacy_route())},
        "rounds": [{"cjobs": [{"pjobs": [{"routeRef": "R1"}]}]}],
    }
    (device_dir / "device.json").write_text(json.dumps({
        "id": "device-1", "device": {"Stations": {}, "Robots": {}},
        "routes": [route], "cleans": [],
    }, ensure_ascii=False), encoding="utf-8")
    (tests_dir / "test-1.json").write_text(
        json.dumps(test_case, ensure_ascii=False), encoding="utf-8",
    )
    (tests_dir / server.WORKSPACE_TEST_INDEX_FILE).write_text(json.dumps([
        {"id": "test-1", "name": "Test1", "group": ""},
    ], ensure_ascii=False), encoding="utf-8")
    (store_dir / server.WORKSPACE_STORE_VERSION_FILE).write_text(
        json.dumps({"version": 4}), encoding="utf-8",
    )

    assert server._prepare_workspace_data(store_dir) is True
    assert server._read_workspace_store_version(store_dir) == server.WORKSPACE_STORE_VERSION
    backups = list((tmp_path / "migration-backups").glob(
        f"datasets-v4-to-v{server.WORKSPACE_STORE_VERSION}-*"
    ))
    assert len(backups) == 1
    assert json.loads((backups[0] / server.WORKSPACE_STORE_VERSION_FILE).read_text(
        encoding="utf-8",
    ))["version"] == 4
    renamed = {**route, "name": "R2"}
    result = server.update_workspace_routes(
        "device-1", {"routes": [renamed], "routeNameChanges": {"R1": "R2"}},
        store_dir, include_tests=False,
    )
    assert result["testCount"] == 1
    assert "tests" not in result
    persisted_test = json.loads((tests_dir / "test-1.json").read_text(encoding="utf-8"))
    assert persisted_test["rounds"][0]["cjobs"][0]["pjobs"][0]["routeRef"] == "R1"
    assert server.get_workspace_test("device-1", "test-1", store_dir)["rounds"][0]["cjobs"][0]["pjobs"][0]["routeRef"] == "R2"
    device = server.get_workspace_device("device-1", store_dir)
    plan = batch_service.build_workspace_batch_plan(device, persisted_test, "heuristic", {})
    runtime_route_ref = plan["rounds"][0]["cjobs"][0]["pjobs"][0]["routeRef"]
    assert runtime_route_ref.startswith("R2__")
    assert runtime_route_ref in {route["name"] for route in plan["routes"]}
    assert plan["routes"][0]["stages"][1]["visits"][0]["processTime"] == 37


def test_workspace_migration_deduplicates_topology_and_preserves_referenced_config() -> None:
    """同拓扑旧 Route 应收敛为一个模板，各测试仍保留自己原先引用的参数。"""
    first = _legacy_route()
    second = json.loads(json.dumps(first))
    second["name"] = second["group"] = "R2"
    second["stages"][1]["visits"][0]["processTime"] = 88
    second["stages"][1]["visits"][0]["recipeTime"] = 88
    catalog = {
        "version": 3,
        "devices": [{
            "id": "device-1",
            "device": {"Stations": {}, "Robots": {}},
            "routes": [first, second],
            "tests": [
                {"id": "test-1", "rounds": [{"cjobs": [{"pjobs": [{"routeRef": "R1"}]}]}]},
                {"id": "test-2", "rounds": [{"cjobs": [{"pjobs": [{"routeRef": "R2"}]}]}]},
            ],
        }],
    }

    assert server._migrate_workspace_catalog(catalog) is True

    device = catalog["devices"][0]
    assert [route["name"] for route in device["routes"]] == ["R1"]
    assert device["tests"][0]["rounds"][0]["cjobs"][0]["pjobs"][0]["routeRef"] == "R1"
    assert device["tests"][1]["rounds"][0]["cjobs"][0]["pjobs"][0]["routeRef"] == "R1"
    assert device["tests"][0]["routeConfigs"]["R1"]["stages"]["1"]["processTime"] == 37
    assert device["tests"][1]["routeConfigs"]["R1"]["stages"]["1"]["processTime"] == 88


def test_workspace_migration_keeps_duplicate_when_one_test_uses_conflicting_configs() -> None:
    """单个测试同时依赖两套不同参数时不强制合并，避免升级后改变既有排程。"""
    first = _legacy_route()
    second = json.loads(json.dumps(first))
    second["name"] = second["group"] = "R2"
    second["stages"][1]["visits"][0]["processTime"] = 88
    second["stages"][1]["visits"][0]["recipeTime"] = 88
    catalog = {
        "version": 3,
        "devices": [{
            "id": "device-1",
            "device": {"Stations": {}, "Robots": {}},
            "routes": [first, second],
            "tests": [{
                "id": "test-1",
                "rounds": [{"cjobs": [{"pjobs": [{"routeRef": "R1"}, {"routeRef": "R2"}]}]}],
            }],
        }],
    }

    assert server._migrate_workspace_catalog(catalog) is True

    assert [route["name"] for route in catalog["devices"][0]["routes"]] == ["R1", "R2"]


def test_route_template_and_test_route_editors_use_separate_ui_states() -> None:
    """模板局部保存、模板选择和测试参数编辑应是三个清晰且可返回的界面状态。"""
    frontend = ROOT / "realtime_scheduler" / "frontend"
    template = (frontend / "config_editor.html").read_text(encoding="utf-8")
    source = (frontend / "src" / "config_editor.ts").read_text(encoding="utf-8")

    assert 'class="route-update-card"' in template
    assert 'id="saveRoutesButton"' not in template
    assert 'id="discardRoutesButton"' not in template
    assert 'data-action="save-route"' in source
    assert 'data-action="cancel-route-edit"' in source
    assert '路径名称（自动生成）' not in source
    assert 'class="field route-group-field"' not in source
    assert 'if (index === 0) return "Src";' in source
    assert 'return "Sink";' in source
    assert '${escapeHtml(group.label)}</option>' in source
    assert 'data-action="back-pjob-route-selection"' in source
    assert '<strong>Job Clean</strong>' in source
    picker_card = source.split("function renderPJobRouteCard", 1)[1].split(
        "/** 在路径引用弹窗内", 1,
    )[0]
    assert "routePickerCompactPath(route, false)" in picker_card
    assert '>路径模板</strong>' not in picker_card
    route_table = source.split("function renderRouteInstanceSteps", 1)[1].split(
        "/** 刷新弹窗", 1,
    )[0]
    assert "<th></th>" not in route_table
    assert '<th>类型</th>' in route_table
    assert 'data-action="open-pjob-step-drawer"' not in route_table
    assert 'route-step-source-note' in route_table
    assert 'fixed ? `<span class="route-step-source-note">由 CJob LoadPort 决定</span>`' in route_table
    assert 'fixed ? `<span class="route-step-readonly">—</span>`' in route_table
    assert 'function renderRouteBufferEditor(routeIndex, context)' in source
    assert 'data-scope="test-route"' in source
    assert 'data-key="bufferOption"' in source
    assert 'pjob.routeConfig = normalized;' in source
    assert 'runtimePJobRouteInstances()' in source
    pjob_picker = source.split("function renderPJobRoutePicker", 1)[1].split(
        "/** 绘制重算轮次", 1,
    )[0]
    assert "routePickerProcessSummary" not in pjob_picker
    assert "renderRoutePropertyTags(runtimeRoute)" in pjob_picker
    property_tags = source.split("function renderRoutePropertyTags", 1)[1].split(
        "/** 绘制一张紧凑", 1,
    )[0]
    assert 'if (cleanSummary !== "无")' in property_tags
    assert "if (hasResidency)" in property_tags
    assert "if (buffer.index > 0)" in property_tags
    assert "if (hasQTime)" in property_tags
    assert ': ""' in property_tags
    assert '(select.closest("dialog") || document.body).append(menu)' in source
    assert "正在保存统一生成的路径与 Clean 名称" not in source
    pjob_row = source.split('return `<div class="pjob-row">', 1)[1].split(
        "</div>`;", 1,
    )[0]
    assert pjob_row.index("pjob-material") < pjob_row.index("pjob-priority")
    assert pjob_row.index("pjob-priority") < pjob_row.index("pjob-origin-route")
    assert "· 参数仅作用于当前测试" not in source
    assert "点击 Step 编辑加工时间、QTime、驻留与 Clean" not in source
    assert "在 PJob 前后执行，仅作用于当前测试" not in source
    drawer = source.split("function renderStepDrawer()", 1)[1].split(
        "/** 从测试的路径引用面板", 1,
    )[0]
    assert "renderStepCleanEditor(routeIndex, stageIndex)" in drawer
    assert "renderRouteCleanEditor(routeIndex)" not in drawer
    assert "当前测试参数" not in drawer
    assert "editable-badge" not in drawer
    assert "step-overview-card" not in drawer
    open_drawer = source.split("function openPJobStepDrawer", 1)[1].split(
        "/** 关闭 Step 抽屉", 1,
    )[0]
    assert "drawerLayer.showModal()" in open_drawer
    assert 'document.getElementById("pjobRouteDialog").close()' not in open_drawer
    assert "returnFromDrawer" not in source
    assert 'width: min(560px, 100vw)' in (
        frontend / "assets" / "config_editor.css"
    ).read_text(encoding="utf-8")
