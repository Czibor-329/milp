"""本地调度平台 HTTP 与静态资源传输边界。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.execution.run_state import *
from realtime_scheduler.backend.execution.service import *
from realtime_scheduler.backend.execution.batch_service import DEFAULT_BATCH_WORKERS
from realtime_scheduler.backend.execution.validation_limiter import DEFAULT_VALIDATION_WORKERS
from realtime_scheduler.backend.preferences.repository import *
from realtime_scheduler.backend.workspace.repository import *
from realtime_scheduler.backend.workspace.catalog_service import *
from realtime_scheduler.backend.workspace.exchange_service import *
from realtime_scheduler.backend.workspace.transfer_jobs import *
from realtime_scheduler.backend.artifacts.repository import *
from realtime_scheduler.backend.wiring import *

class ConfigEditorHandler(BaseHTTPRequestHandler):
    """暴露调度控制台、设备测试集、甘特图和运行 API 的本地 HTTP 处理器。"""

    server_version = "CTConfigEditor/1.0"

    def handle_one_request(self) -> None:
        """记录单次 HTTP 请求起点，供统一响应性能头计算端到端服务耗时。"""
        self._request_started_performance = time.perf_counter()
        super().handle_one_request()

    def do_GET(self) -> None:
        """处理页面、健康检查和内存结果读取。"""
        parsed_url = urlparse(self.path)
        path = unquote(parsed_url.path)
        if path in {"/", "/config_editor.html"}:
            self._send_file(EDITOR_PATH, "text/html; charset=utf-8")
            return
        if path == "/movelist_gantt_viewer.html":
            self._send_file(VIEWER_PATH, "text/html; charset=utf-8")
            return
        if path == "/route_editor_logic.js":
            self._send_file(ROUTE_EDITOR_LOGIC_PATH, "text/javascript; charset=utf-8")
            return
        if path.startswith("/assets/"):
            self._send_frontend_asset(path.removeprefix("/assets/"))
            return
        if path == "/api/preferences/run-settings":
            try:
                self._send_json({"ok": True, "runSettings": read_run_preferences()})
            except Exception as error:  # noqa: BLE001
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            return
        if path == "/api/health":
            builtin_algorithms = discover_builtin_algorithms()
            other_algorithms = discover_other_algorithms()
            builtin_strategy_errors = {
                str(algorithm["strategy"]): str(algorithm["unavailableReason"])
                for algorithm in builtin_algorithms
                if not algorithm["available"]
            }
            strategy_availability = {
                str(algorithm["strategy"]): bool(algorithm["available"])
                for algorithm in builtin_algorithms
            }
            self._send_json({
                "ok": True,
                "service": "ct-config-editor",
                "schemaVersion": API_SCHEMA_VERSION,
                "algorithmRepositoryAvailable": BUILTIN_ALGORITHM_AVAILABLE,
                "strategies": strategy_availability,
                "strategyModels": {
                    "e2e-ctq": (
                        E2E_CTQ_MODEL_PATH.name if E2E_CTQ_MODEL_PATH.is_file() else ""
                    ),
                    "dual-actor-e2e": (
                        DUAL_ACTOR_MODEL_PATH.name
                        if DUAL_ACTOR_MODEL_PATH.is_file()
                        else ""
                    ),
                },
                "strategyErrors": builtin_strategy_errors,
                "algorithmMetadata": algorithm_metadata_for_health(
                    builtin_algorithms,
                    other_algorithms,
                ),
                "algorithms": [*builtin_algorithms, *other_algorithms],
                "otherAlgorithms": other_algorithms,
            })
            return
        if path == "/api/documentation":
            try:
                document = load_documentation((
                    DOCUMENTATION_DIR,
                    ALGORITHM_DOCUMENTATION_DIR,
                ))
            except DocumentationError as error:
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.NOT_FOUND,
                )
                return
            self._send_json({"ok": True, "document": document})
            return
        if path.startswith("/api/workspace-transfers/"):
            transfer_parts = [part for part in path.split("/") if part]
            if (
                len(transfer_parts) == 4
                and transfer_parts[:2] == ["api", "workspace-transfers"]
                and transfer_parts[3] == "download"
            ):
                try:
                    content, download_name = download_workspace_transfer(transfer_parts[2])
                    self._send_bytes(content, "application/zip", download_name)
                except LookupError as error:
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.NOT_FOUND)
                except ValueError as error:
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.CONFLICT)
                return
            if (
                len(transfer_parts) == 3
                and transfer_parts[:2] == ["api", "workspace-transfers"]
            ):
                transfer = read_workspace_transfer(transfer_parts[2])
                if transfer is None:
                    self._send_json({"ok": False, "error": "交换任务不存在或已过期"}, HTTPStatus.NOT_FOUND)
                else:
                    self._send_json({"ok": True, "transfer": transfer})
                return
        if path == "/api/search-telemetry":
            if not BUILTIN_ALGORITHM_AVAILABLE:
                self._send_json(
                    {"ok": False, "error": "本地算法仓库未加载，无法读取搜索遥测"},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            try:
                query = parse_qs(parsed_url.query)
                raw_revision = (query.get("since") or [None])[0]
                since_revision = (
                    None if raw_revision in {None, ""} else int(raw_revision)
                )
                self._send_json({
                    "ok": True,
                    "telemetry": builtin_algorithm_api.get_search_telemetry(
                        since_revision
                    ),
                })
            except (TypeError, ValueError) as error:
                self._send_json(
                    {"ok": False, "error": f"since 必须是整数：{error}"},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/workspaces":
            try:
                devices = list_workspace_devices()
                self._send_json({"ok": True, "devices": devices})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path.startswith("/api/workspaces/"):
            parts = [part for part in path.split("/") if part]
            if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "export":
                try:
                    content, download_name = export_workspace_device(parts[2])
                    self._send_bytes(content, "application/zip", download_name)
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            if (
                len(parts) == 6
                and parts[:2] == ["api", "workspaces"]
                and parts[3] == "tests"
                and parts[5] == "export"
            ):
                try:
                    content, download_name = export_workspace_test(parts[2], parts[4])
                    self._send_bytes(content, "application/zip", download_name)
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            if len(parts) == 5 and parts[:2] == ["api", "workspaces"] and parts[3] == "tests":
                try:
                    self._send_json({"ok": True, "test": get_workspace_test(parts[2], parts[4])})
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.NOT_FOUND)
                return
            if len(parts) == 3:
                try:
                    self._send_json({"ok": True, "device": get_workspace_device_overview(parts[2])})
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.NOT_FOUND)
                return
        if path.startswith("/api/results/"):
            result = read_result(path.rsplit("/", 1)[-1])
            if result is None:
                self._send_json({"ok": False, "error": "结果不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(result)
            return
        if path.startswith("/api/logs/"):
            log_id = path.rsplit("/", 1)[-1]
            reproduction_log = read_reproduction_log(log_id)
            if reproduction_log is None:
                self._send_json({"ok": False, "error": "日志不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(
                    reproduction_log,
                    download_name=f"ct-input-log-{log_id[:8]}.json",
                    top_level_item_per_line=True,
                )
            return
        run_parts = [part for part in path.split("/") if part]
        if len(run_parts) == 3 and run_parts[:2] == ["api", "runs"]:
            run = _single_run_snapshot(run_parts[2])
            if run is None:
                self._send_json({"ok": False, "error": "单测任务不存在或尚未开始"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(run)
            return
        batch_parts = run_parts
        if len(batch_parts) == 4 and batch_parts[:2] == ["api", "run-batches"] and batch_parts[3] == "logs":
            try:
                content, download_name = build_workspace_batch_log_archive(batch_parts[2])
                self._send_bytes(content, "application/zip", download_name)
            except LookupError as error:
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.NOT_FOUND)
            except ValueError as error:
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path.startswith("/api/run-batches/"):
            batch = read_workspace_batch_run(path.rsplit("/", 1)[-1])
            if batch is None:
                self._send_json({"ok": False, "error": "批量任务不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(batch)
            return
        self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        """接收控制台配置并同步运行后端策略。"""
        path = unquote(urlparse(self.path).path)
        if path == "/api/workspace-transfers":
            try:
                payload = self._read_json_object()
                transfer = create_workspace_transfer(
                    str(payload.get("direction") or ""),
                    str(payload.get("kind") or ""),
                    str(payload.get("deviceId") or ""),
                    str(payload.get("testId") or ""),
                )
                self._send_json(
                    {"ok": True, "transfer": transfer},
                    HTTPStatus.ACCEPTED,
                )
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        transfer_parts = [part for part in path.split("/") if part]
        if (
            len(transfer_parts) == 4
            and transfer_parts[:2] == ["api", "workspace-transfers"]
            and transfer_parts[3] == "content"
        ):
            try:
                transfer = upload_workspace_transfer(
                    transfer_parts[2],
                    self._read_binary_body(DATA_EXCHANGE_MAX_ARCHIVE_BYTES),
                )
                self._send_json(
                    {"ok": True, "transfer": transfer},
                    HTTPStatus.ACCEPTED,
                )
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/workspaces/import/device":
            try:
                device, created_device, imported_tests = import_workspace_device_archive(
                    self._read_binary_body(DATA_EXCHANGE_MAX_ARCHIVE_BYTES),
                )
                self._send_json({
                    "ok": True,
                    "device": {
                        "id": device["id"],
                        "name": device.get("name") or "未命名设备",
                        "testCount": len(device.get("tests") or []),
                    },
                    "createdDevice": bool(created_device),
                    "importedTests": imported_tests,
                })
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        import_test_parts = [part for part in path.split("/") if part]
        if (
            len(import_test_parts) == 4
            and import_test_parts[:2] == ["api", "workspaces"]
            and import_test_parts[3] == "import-test"
        ):
            try:
                test_case, created = import_workspace_test_archive(
                    import_test_parts[2],
                    self._read_binary_body(DATA_EXCHANGE_MAX_ARCHIVE_BYTES),
                )
                self._send_json({"ok": True, "created": created, "test": test_case})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/model-checkpoints":
            try:
                filename = unquote(str(self.headers.get("X-Checkpoint-Filename") or ""))
                checkpoint_path = save_model_checkpoint(
                    filename,
                    self._read_binary_body(MAX_CHECKPOINT_BYTES),
                )
                self._send_json({"ok": True, "modelPath": str(checkpoint_path)})
            except (OSError, ValueError) as error:
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/search-control":
            try:
                if not BUILTIN_ALGORITHM_AVAILABLE:
                    raise RuntimeError("本地算法仓库未加载，无法控制搜索")
                payload = self._read_json_object()
                result = builtin_algorithm_api.control_search(
                    str(payload.get("command") or ""),
                    payload.get("actionKey"),
                )
                self._send_json({"ok": True, **result})
            except (RuntimeError, TypeError, ValueError) as error:
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/analysis/replay-decision":
            try:
                if not BUILTIN_ALGORITHM_AVAILABLE:
                    raise RuntimeError("当前部署未提供 Machine，无法评估回放动作")
                payload = self._read_json_object()
                result_id = str(payload.get("resultId") or "").strip()
                saved_result = read_result(result_id) if result_id else None
                if result_id and saved_result is None:
                    raise ValueError("结果不存在或已过期")
                moves = normalize_move_payload(
                    saved_result
                    if saved_result is not None
                    else payload.get("moves", payload.get("result")),
                )
                raw_plan = payload.get("plan")
                replay_context = (
                    saved_result.get("ReplayContext")
                    if isinstance(saved_result, Mapping)
                    else None
                )
                if not isinstance(raw_plan, Mapping) and isinstance(replay_context, Mapping):
                    raw_plan = replay_context.get("plan")
                if not isinstance(raw_plan, Mapping):
                    raise ValueError("缺少生成该 MoveList 的完整计划，无法重建 Machine")
                recommendation_model = str(
                    payload.get("recommendationModel") or "e2e-ctq"
                ).strip().lower()
                recommendation_models = {
                    "e2e-ctq": E2E_CTQ_MODEL_PATH,
                    "dual-actor-e2e": DUAL_ACTOR_MODEL_PATH,
                }
                if recommendation_model not in recommendation_models:
                    raise ValueError(
                        f"拓扑回放不支持推荐模型：{recommendation_model}"
                    )
                decision = ReplayMachine(
                    raw_plan,
                    moves,
                    recommendation_models[recommendation_model],
                    (
                        replay_context.get("updates") or []
                        if isinstance(replay_context, Mapping)
                        else []
                    ),
                    recommendation_model=recommendation_model,
                ).evaluate(_finite_number(payload.get("time"), 0.0))
                self._send_json({"ok": True, "decision": decision})
            except Exception as error:  # noqa: BLE001
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/analysis/schedule":
            try:
                payload = self._read_json_object()
                result_id = str(payload.get("resultId") or "").strip()
                if result_id:
                    saved_result = read_result(result_id)
                    if saved_result is None:
                        raise ValueError("结果不存在或已过期")
                    moves = normalize_move_payload(saved_result)
                    run_metrics = saved_result.get("RunMetricsMetadata")
                    if not isinstance(run_metrics, Mapping):
                        legacy_metadata = saved_result.get("ProductionMetricsMetadata")
                        run_metrics = {
                            "cpuTimeMs": (
                                _finite_number(legacy_metadata.get("calculationSeconds")) * 1000.0
                                if isinstance(legacy_metadata, Mapping)
                                else None
                            ),
                            # RecomputePoints 只记录首排之后的重算点；首轮同样会
                            # 调用一次算法 update，必须纳入 CPU Time 的平均分母。
                            "recomputeCount": (
                                len(list(saved_result.get("RecomputePoints") or [])) + 1
                                if isinstance(legacy_metadata, Mapping)
                                else 0
                            ),
                        }
                else:
                    moves = normalize_move_payload(
                        payload.get("moves", payload.get("result")),
                    )
                    run_metrics = {
                        "cpuTimeMs": payload.get("cpuTimeMs"),
                        "recomputeCount": payload.get("recomputeCount"),
                    }
                device = payload.get("device")
                if device is not None and not isinstance(device, Mapping):
                    raise ValueError("device 必须是 JSON 对象或 null")
                context = payload.get("context")
                if context is None:
                    routes = payload.get("routes")
                    rounds = payload.get("rounds")
                    if routes is not None or rounds is not None:
                        if routes is not None and not isinstance(routes, list):
                            raise ValueError("routes 必须是数组")
                        if rounds is not None and not isinstance(rounds, list):
                            raise ValueError("rounds 必须是数组")
                        context = build_schedule_analysis_context(routes, rounds)
                if context is not None and not isinstance(context, Mapping):
                    raise ValueError("context 必须是 JSON 对象或 null")
                analysis = analyze_schedule_performance(
                    moves,
                    device,
                    str(payload.get("windowMode") or "steady"),
                    context,
                    run_metrics,
                )
                self._send_json({
                    "ok": True,
                    "analysis": analysis,
                    "bottleneck": summarize_bottleneck_utilization(analysis),
                })
            except Exception as error:  # noqa: BLE001
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/analysis/test-group":
            try:
                payload = self._read_json_object()
                cases = payload.get("cases")
                if not isinstance(cases, list):
                    raise ValueError("cases 必须是数组")
                if not all(isinstance(item, Mapping) for item in cases):
                    raise ValueError("cases 的每一项都必须是 JSON 对象")
                self._send_json({
                    "ok": True,
                    "analysis": analyze_test_group_performance(cases),
                })
            except Exception as error:  # noqa: BLE001
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/run-batch":
            try:
                payload = self._read_json_object()
                device_id = str(payload.get("deviceId") or "")
                strategy = str(payload.get("strategy") or "heuristic")
                options = payload.get("options")
                if not isinstance(options, Mapping):
                    options = {}
                test_ids = payload.get("testIds")
                if test_ids is not None and not isinstance(test_ids, list):
                    raise ValueError("testIds 必须是测试 ID 数组")
                result = start_workspace_test_batch(
                    device_id,
                    str(payload.get("group") or ""),
                    strategy,
                    options,
                    hongye_check=bool(payload.get("hongYeCheck", True)),
                    skip_baseline=bool(payload.get("skipBaseline")),
                    compatibility_mode=bool(payload.get("compatibilityMode", True)),
                    maximum_workers=int(payload.get("maximumWorkers", DEFAULT_BATCH_WORKERS)),
                    validation_workers=int(payload.get("validationWorkers", DEFAULT_VALIDATION_WORKERS)),
                    use_process_isolation=True,
                    test_ids=test_ids,
                )
                self._send_json(result, HTTPStatus.ACCEPTED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/workspaces/devices":
            try:
                payload = self._read_json_object()
                device, created = import_workspace_device(
                    str(payload.get("name") or "未命名设备"), payload.get("device"),
                )
                self._send_json({"ok": True, "created": created, "device": {
                    "id": device["id"],
                    "name": device["name"],
                    "testCount": len(device.get("tests") or []),
                }})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        workspace_parts = [part for part in path.split("/") if part]
        if len(workspace_parts) == 4 and workspace_parts[:2] == ["api", "workspaces"] and workspace_parts[3] == "groups":
            try:
                payload = self._read_json_object()
                groups = create_workspace_test_group(workspace_parts[2], str(payload.get("name") or ""))
                self._send_json({"ok": True, "groups": groups}, HTTPStatus.CREATED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(workspace_parts) == 4 and workspace_parts[:2] == ["api", "workspaces"] and workspace_parts[3] == "tests":
            try:
                payload = self._read_json_object()
                test_case = create_workspace_test(workspace_parts[2], payload)
                self._send_json({"ok": True, "test": test_case}, HTTPStatus.CREATED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path != "/api/run":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        payload: Any = None
        replay_plan: Optional[Dict[str, Any]] = None
        baseline_response: Optional[Dict[str, Any]] = None
        client_run_id = ""
        request_started = time.perf_counter()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("请求为空或超过大小限制")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, Mapping):
                raise ValueError("请求体必须是 JSON 对象")
            workspace_device_id = str(payload.get("workspaceDeviceId") or "")
            workspace_test_id = str(payload.get("workspaceTestId") or "")
            strategy = str(payload.get("strategy") or "heuristic")
            client_run_id = str(payload.get("clientRunId") or "").strip()
            if client_run_id:
                _start_single_run(
                    client_run_id,
                    strategy,
                    str(payload.get("testCaseName") or payload.get("deviceName") or "当前测试"),
                )
            if workspace_device_id and workspace_test_id:
                device, test_case = get_workspace_run_context(
                    workspace_device_id,
                    workspace_test_id,
                )
                selected_plan = deepcopy(dict(payload))
                runtime_device = deepcopy(device.get("device"))
                if isinstance(runtime_device, dict):
                    apply_robot_slot_selection(runtime_device, device.get("robotSlots"))
                    selected_plan["device"] = runtime_device
                replay_plan = deepcopy(selected_plan)
                if client_run_id:
                    with _monitor_single_run(client_run_id, strategy):
                        result, baseline, run_error = _execute_workspace_test_with_baseline(
                            device,
                            test_case,
                            strategy,
                            dict(payload.get("options") or {}),
                            selected_plan=selected_plan,
                            hongye_check=bool(payload.get("hongYeCheck", True)),
                            skip_baseline=bool(payload.get("skipBaseline")),
                            compatibility_mode=bool(payload.get("compatibilityMode", True)),
                        )
                else:
                    result, baseline, run_error = _execute_workspace_test_with_baseline(
                        device,
                        test_case,
                        strategy,
                        dict(payload.get("options") or {}),
                        selected_plan=selected_plan,
                        hongye_check=bool(payload.get("hongYeCheck", True)),
                        skip_baseline=bool(payload.get("skipBaseline")),
                        compatibility_mode=bool(payload.get("compatibilityMode", True)),
                    )
                baseline_response = deepcopy(baseline)
                if run_error is not None or result is None:
                    raise run_error or RuntimeError("运行未返回结果")
                result.update(_baseline_comparison(result, baseline))
            else:
                replay_plan = deepcopy(dict(payload))
                if client_run_id:
                    with _monitor_single_run(client_run_id, strategy):
                        result = execute_plan(payload)
                else:
                    result = execute_plan(payload)
            artifact = deepcopy(dict(result["output"]))
            artifact["RunMetricsMetadata"] = {
                "cpuTimeMs": max(
                    0.0,
                    float(result.get("cpuTimeMs", result.get("totalElapsedMs", 0.0))),
                ),
                # updates 与每次算法 update 一一对应，包含首排 update #1。
                "recomputeCount": len(list(result.get("updates") or [])),
            }
            if replay_plan is not None:
                artifact["ReplayContext"] = {
                    "schema": "machine-replay-context-v1",
                    "plan": replay_plan,
                    "updates": deepcopy(list(result.get("updates") or [])),
                }
            result_id = save_result(artifact)
            log_id = save_reproduction_log(result["reproductionLog"])
            response = {
                key: value
                for key, value in result.items()
                if key not in {"output", "reproductionLog"}
            }
            response["resultId"] = result_id
            response["ganttUrl"] = f"/movelist_gantt_viewer.html?src=/api/results/{result_id}"
            response.update(_log_response_fields(log_id))
            if client_run_id:
                _finish_single_run(client_run_id, "completed")
            self._send_json(response)
        except LoggedPlanError as error:
            if client_run_id:
                _finish_single_run(client_run_id, "failed", str(error))
            log_id = save_reproduction_log(error.reproduction_log)
            response = {"ok": False, "error": str(error)}
            if baseline_response is not None:
                response["baseline"] = baseline_response
            response.update(_log_response_fields(log_id))
            response.update(_logged_failure_result_fields(
                error,
                replay_plan=replay_plan,
            ))
            strategy = str(payload.get("strategy") or "") if isinstance(payload, Mapping) else ""
            if strategy.casefold().startswith("other_alg:"):
                elapsed_ms = (time.perf_counter() - request_started) * 1000.0
                moves = list((error.failure_output or {}).get("MoveList") or [])
                response.update({
                    "metricsAvailable": True,
                    "totalElapsedMs": elapsed_ms,
                    "cpuTimeMs": elapsed_ms,
                    "validation": "failed",
                    "robotWaferDwellTime": _robot_wafer_dwell_time(moves),
                })
                if baseline_response is not None and "makespan" in response:
                    response.update(_baseline_comparison(response, baseline_response))
            self._send_json(response, HTTPStatus.BAD_REQUEST)
        except Exception as error:  # noqa: BLE001
            reproduction = ReproductionLog()
            reproduction.add("Input", [deepcopy(dict(payload))] if isinstance(payload, Mapping) else [])
            reproduction.add("AlgOutput", _alg_output_info(feedback=[{
                "Level": "Error",
                "Type": type(error).__name__,
                "Message": str(error),
            }]))
            log_id = save_reproduction_log(reproduction.entries)
            cancelled_error_type = globals().get("SearchCancelledError")
            cancelled = (
                isinstance(error, UserRunCancelledError)
                or cancelled_error_type is not None
                and isinstance(error, cancelled_error_type)
            )
            if cancelled:
                response = {"ok": False, "cancelled": True, "error": "运行已取消"}
            else:
                response = {"ok": False, "error": str(error) or type(error).__name__}
            if client_run_id:
                _finish_single_run(
                    client_run_id,
                    "cancelled" if cancelled else "failed",
                    response["error"],
                )
            if baseline_response is not None:
                response["baseline"] = baseline_response
            response.update(_log_response_fields(log_id))
            self._send_json(response, HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:
        """保存测试、路径模板、机器手槽位或测试组别。"""
        path = unquote(urlparse(self.path).path)
        if path == "/api/preferences/run-settings":
            try:
                payload = self._read_json_object()
                settings = update_run_preferences(payload.get("runSettings"))
                self._send_json({"ok": True, "runSettings": settings})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        parts = [part for part in path.split("/") if part]
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "device-timing":
            try:
                payload = self._read_json_object()
                device_data = update_workspace_device_timing(
                    parts[2], payload.get("timing"),
                )
                self._send_json({"ok": True, "device": device_data})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "robot-slots":
            try:
                payload = self._read_json_object()
                robot_slots = update_workspace_robot_slots(
                    parts[2], payload.get("robotSlots"),
                )
                self._send_json({"ok": True, "robotSlots": robot_slots})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "routes":
            try:
                payload = self._read_json_object()
                result = update_workspace_routes(parts[2], payload, include_tests=False)
                self._send_json({"ok": True, **result})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "groups":
            try:
                payload = self._read_json_object()
                result = rename_workspace_test_group(
                    parts[2], str(payload.get("oldName") or ""), str(payload.get("name") or ""),
                )
                self._send_json({"ok": True, **result})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) != 5 or parts[:2] != ["api", "workspaces"] or parts[3] != "tests":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            payload = self._read_json_object()
            test_case = update_workspace_test(parts[2], parts[4], payload)
            self._send_json({"ok": True, "test": test_case})
        except Exception as error:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_DELETE(self) -> None:
        """删除导出文件、设备下指定测试集或测试组，并返回剩余数据。"""
        path = unquote(urlparse(self.path).path)
        if path == "/api/exports":
            try:
                deleted_counts = clear_exported_artifacts()
                self._send_json({"ok": True, "deleted": deleted_counts})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path.startswith("/api/run-batches/"):
            batch = cancel_workspace_batch_run(path.rsplit("/", 1)[-1])
            if batch is None:
                self._send_json({"ok": False, "error": "批量任务不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(batch)
            return
        if path.startswith("/api/runs/"):
            run = _cancel_single_run(path.rsplit("/", 1)[-1])
            if run is None:
                self._send_json({"ok": False, "error": "单测任务不存在或尚未开始"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(run)
            return
        parts = [part for part in path.split("/") if part]
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[2] == "devices":
            try:
                deleted = delete_workspace_device(parts[3])
                self._send_json({"ok": True, "deleted": deleted})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "groups":
            try:
                payload = self._read_json_object()
                result = delete_workspace_test_group(parts[2], str(payload.get("name") or ""))
                self._send_json({"ok": True, **result})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) != 5 or parts[:2] != ["api", "workspaces"] or parts[3] != "tests":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            remaining_tests = delete_workspace_test(parts[2], parts[4])
            self._send_json({"ok": True, "tests": remaining_tests})
        except Exception as error:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def log_message(self, format_string: str, *args: Any) -> None:
        """按开关输出 HTTP 访问日志，默认不干扰业务阶段日志。"""
        log_http_access(f"{self.address_string()} {format_string % args}")

    def _send_file(self, path: Path, content_type: str) -> None:
        """发送白名单中的静态文件。"""
        if not path.is_file():
            self._send_json({"ok": False, "error": f"文件不存在：{path}"}, HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self._send_performance_headers(len(content))
        self.end_headers()
        self.wfile.write(content)

    def _send_bytes(self, content: bytes, content_type: str, download_name: str) -> None:
        """发送一次性生成的二进制下载内容。"""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self._send_performance_headers(len(content))
        self.end_headers()
        self.wfile.write(content)

    def _send_frontend_asset(self, asset_name: str) -> None:
        """发送构建后的前端资源，并拒绝目录穿越和未知文件类型。"""
        content_types = {
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".map": "application/json; charset=utf-8",
        }
        asset_path = (FRONTEND_ASSET_DIR / asset_name).resolve()
        if asset_path.parent != FRONTEND_ASSET_DIR.resolve():
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        content_type = content_types.get(asset_path.suffix.lower())
        if content_type is None:
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        self._send_file(asset_path, content_type)

    def _read_json_object(self) -> Dict[str, Any]:
        """读取受大小限制的 JSON 对象请求体。"""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("请求为空或超过大小限制")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, Mapping):
            raise ValueError("请求体必须是 JSON 对象")
        return dict(payload)

    def _read_binary_body(self, maximum_bytes: int) -> bytes:
        """读取有明确上限的二进制请求体，供本机模型文件上传使用。"""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > maximum_bytes:
            raise ValueError("文件为空或超过大小限制")
        return self.rfile.read(length)

    def _send_performance_headers(self, response_bytes: int) -> None:
        """附加当前请求的服务耗时和响应体积，便于浏览器与基准工具采集。"""
        started = getattr(self, "_request_started_performance", time.perf_counter())
        elapsed_ms = max(0.0, (time.perf_counter() - started) * 1000.0)
        self.send_header("Server-Timing", f"app;dur={elapsed_ms:.3f}")
        self.send_header("X-Response-Bytes", str(max(0, int(response_bytes))))

    def _send_json(
        self,
        payload: Any,
        status: HTTPStatus = HTTPStatus.OK,
        download_name: Optional[str] = None,
        top_level_item_per_line: bool = False,
    ) -> None:
        """以 UTF-8 JSON 返回 API 结果。"""
        if top_level_item_per_line:
            content_text = format_reproduction_log(payload)
        else:
            content_text = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        content = content_text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self._send_performance_headers(len(content))
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(content)



__all__ = tuple(name for name in globals() if not name.startswith('__'))
