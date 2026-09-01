# CT 调度平台

## 快速开始

仓库不附带设备/测试数据或算法包。服务会以空工作区启动，由使用者在页面中导入设备或测试集交换包。

启动：

```powershell
python -m realtime_scheduler.backend.main --open
```

默认地址为 `http://127.0.0.1:8765/config_editor.html`

首次打开页面后，在“设备与测试集”卡片选择“导入”：

1. 导入设备包以创建设备，并同时导入其路径、分组和测试集；或先新建设备。
2. 选择目标设备后可导入单个测试集包；目标设备的 init 必须与来源完全一致。
3. 导入完成后，在设备和测试集选择器中选择刚导入的内容即可开始配置和运行。

终端默认显示调度业务阶段并隐藏浏览器轮询访问日志；调试 HTTP 时可增加`--access-log`，需要更详细的后端日志时可增加 `--log-level DEBUG`。

## 命令行运行测试

使用 [`scripts/run_dataset_suite.py`](scripts/run_dataset_suite.py) 可直接运行本地`realtime_scheduler/data/datasets/` 中的测试集。默认使用平台内置 MoveList 校验器，不启动 HongYe，也跳过 Baseline，适合本地复现与调试。

先逐层列出可用设备、测试组和测试：

```powershell
python scripts\run_dataset_suite.py --list
python scripts\run_dataset_suite.py --device 12kChamber --list
python scripts\run_dataset_suite.py --device 12kChamber --group 公司示例集 --list
```

运行一个测试组：

```powershell
python scripts\run_dataset_suite.py --device 12kChamber --group 公司示例集 --strategy heuristic
```

快速复现时可加 `--limit 3 --workers 1`；精确复现可重复传入`--test <测试 ID 或完整名称>`，并可用 `--json-output <路径>` 保存机器可读结果。

## 外部算法部署

本仓库不提供算法包。取得授权算法包后，按其交付说明部署；外部算法放在
`<本仓库>/alg/other_alg/`，每个算法使用独立子目录。当前支持的两种默认登记格式为：

```text
<本仓库>/alg/other_alg/<算法名>/src/infer/scheduler.py    # 公司端 src.infer.scheduler 交付布局
<本仓库>/alg/other_alg/<算法名>/CT/infer/scheduler.py     # 交付目录 CT/infer 布局
```

目录名 `<算法名>` 同时作为稳定算法 ID。平台只扫描该目录，不支持通过前端
直接导入策略。需要整体迁移算法仓库时设置 `CT_ALGORITHM_ROOT`，策略仍须位于
该仓库根目录的 `other_alg/` 子目录。
