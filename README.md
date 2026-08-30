# CT 调度平台

调度算法位于本仓库根目录的 `alg/`；该目录已被父仓库 Git 忽略。

## 快速开始

按以下顺序准备运行所需的数据与算法：

1. 将 `docs\data.rar` 解压后，替换 `realtime_scheduler\data\`
2. `docs\alg-heuristic-20260813-7750ba9.zip` 是当前启发式算法包。解压后将其中的 `alg` 目录放到仓库根目录

部署完成后的最简文件树：

```text
milp/
├── docs/
│   ├── data.rar
│   └── alg-heuristic-20260813-7750ba9.zip
├── realtime_scheduler/
│   ├── data/                         # 由 data.rar 解压得到，各目录含义见「数据说明」
│   │   └── datasets/                 # 设备与测试集的唯一主数据
│   └── exports/                      # 运行结果与复现日志（可随时清理）
└── alg/                              # 由启发式算法包解压得到
    ├── src/
    │   └── api.py
    └── other_alg/                    # 外部算法（可选，见「外部算法部署」）
        └── <外部算法名>/
            └── infer/
                └── scheduler.py
```

启动：

```powershell
python realtime_scheduler\server.py --open
```

默认地址为 `http://127.0.0.1:8765/config_editor.html`

## 终端运行测试集

调试算法时可以绕过浏览器，直接运行本地数据目录中的设备测试组。该入口默认使用
平台内置 MoveList 校验器，不启动 HongYe，并跳过 Baseline：

```powershell
.\venv\Scripts\python.exe scripts\run_dataset_suite.py --device 12kChamber --group 公司示例集 --strategy heuristic --limit 3
```

使用 `--list` 逐级查看设备、测试组和测试 ID；使用重复的 `--test` 精确选择案例，
或用 `--json-output output\dataset-run.json` 保存完整结果。完整参数运行
`.\venv\Scripts\python.exe scripts\run_dataset_suite.py --help` 查看。
需要与页面默认校验口径一致时传入 `--hongye-check`，脚本会改用 HongYe
SchStateLib 校验器。

## 性能回归

平台使用确定性 v7 合成数据验证启动、设备列表、设备概览、单测试读写删除和测试组删除，正常业务
规模最多包含 10 台设备。PR 可先执行结构性硬门禁和 `small` HTTP 预算：

```powershell
python -m pytest tests/performance/test_storage_performance_contracts.py -q
python scripts/run_performance_suite.py --profile small --enforce
```

发布前在固定 Windows 机器运行 `medium` 场景，并用上一正式版本的 JSON 报告做
相对比较；数据格式变化还必须增加 `--migration`：

```powershell
python scripts/run_performance_suite.py --profile medium --baseline previous.json --enforce
python scripts/run_performance_suite.py --profile medium --migration --enforce
```

详细指标、夹具和分层门禁见 [`docs/performance-standards.md`](docs/performance-standards.md)
与 [`docs/performance-testing.md`](docs/performance-testing.md)。基准脚本会通过
`CT_DATA_DIR` 启动隔离服务，不会读取或改写生产 `data/datasets/`。

## 外部算法部署

外部算法包统一放在 `<本仓库>/alg/other_alg/`，每个算法使用独立子目录。当前支持的两种默认登记格式为：

```text
<本仓库>/alg/other_alg/<算法名>/src/infer/scheduler.py    # 公司端 src.infer.scheduler 交付布局
<本仓库>/alg/other_alg/<算法名>/CT/infer/scheduler.py     # 交付目录 CT/infer 布局
```

目录名 `<算法名>` 同时作为稳定算法 ID。平台只扫描该目录，不支持通过前端
直接导入策略。需要整体迁移算法仓库时设置 `CT_ALGORITHM_ROOT`，策略仍须位于
该仓库根目录的 `other_alg/` 子目录。

## 数据说明

> [!NOTE]
>
> 分享设备/测试不需要查看、复制或修改 `realtime_scheduler/data/`。设备和测试集的交换统一在页面“设备与测试集”卡片中使用“导入 / 导出”：设备导出包含该设备下的全部信息；测试集导出只包含当前测试，导入时必须先选择 init 完全相同的设备。
>

交换包上传大小限制为 64 MiB，ZIP 内 JSON 解压后的总量限制为 512 MiB；两者独立
校验，以支持包含大量测试集但压缩率较高的设备包，同时防止异常压缩包过度膨胀。

`realtime_scheduler/data/` 由服务自动维护，整个目录不在 Git 版本控制中。简化结构：

一个工作区最多保存 10 台设备；相同 init 指纹的重复导入会复用已有设备，不重复占用
设备名额。

```text
data/
├── .gitignore                      # 数据目录整体不进 Git
├── datasets/                       # 设备与测试集的唯一主数据，格式版本见 manifest.json
├── checkpoints/                    # 页面上传的模型检查点文件（运行时产生）
├── documentation/                  # 本地使用手册（Markdown）
├── migration-backups/              # 自动升级前的旧数据备份
└── *.lock                          # 运行时文件锁
```

- **datasets/**：内部使用稳定 UUID 寻址。UUID 和实际文件布局不是用户接口，请勿通过手工复制目录分享数据。

  ```text
  data/datasets/
  ├── manifest.json                  # 数据格式及 schemaVersion
  └── <设备 id>/
      ├── metadata.json               # 设备名称、ID、时间戳及兼容初始化选项
      ├── device.json                 # 纯 init，只包含 Stations 和 Robots
      ├── routes.json                 # 设备路径模板与共享配置
      ├── groups.json                 # 测试组别与设备级页面配置
      └── tests/
          └── <测试集 id>/
              └── test.json           # 单个测试集
  ```

旧版 `workspaces/` 和 `devices/` 会在首次启动时自动迁移；v7 将路径参数保存到具体 PJob，使用同一模板的多个 CJob/PJob 仍可配置不同的加工时间、QTime、驻留、Buffer 和 Clean。Dummy / Dummy WAC Clean 还可独立配置 DummyPort 库存，旧数据默认按 8 片读取。格式升级前的数据会保留在 `migration-backups/`，确认新版数据正常后可由维护人员清理。详细格式、交换包和迁移规则见 [`docs/data-format.md`](docs/data-format.md)。

- **checkpoints/**：页面上传的模型检查点文件（仅支持 `.npz/.pt/.pth/.ckpt`）。浏览器不会提供用户选择文件的真实路径，因此服务把文件复制到该目录，并返回算法运行时可读取的绝对路径。
  
- **documentation/**：本地使用手册，`*.md` 文件由页面「文档」面板通过`/api/documentation` 加载展示。算法仓库维护的接口文档可放在算法包的`docs/documentation/`，两者共用导航与 slug 唯一性校验。
  
- **\*.lock**：服务运行时的文件锁（如 `workspaces.lock`），只承载跨进程互斥、不保存业务数据，服务停止后可删除。
