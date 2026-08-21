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
│   │   ├── workspaces/               # 工作区数据（拆分目录，见「数据说明」）
│   │   └── devices/                  # 设备拓扑镜像
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

## 外部算法部署

外部算法包统一放在 `<本仓库>/alg/other_alg/`，每个算法使用独立子目录。当前支持的两种默认登记格式为：

```text
<本仓库>/alg/other_alg/<算法名>/src/infer/scheduler.py    # 公司端 src.infer.scheduler 交付布局
<本仓库>/alg/other_alg/<算法名>/CT/infer/scheduler.py     # 交付目录 CT/infer 布局
```

目录名 `<算法名>` 同时作为稳定算法 ID。若打包算法位于其他目录，设置：

```powershell
$env:CT_OTHER_ALGORITHM_ROOT = "D:\path\to\alg\other_alg"
```

## 数据说明

`realtime_scheduler/data/` 由 `docs\data.rar` 解压得到（初始包含
`workspaces/`、`devices/` 与 `.gitignore`），之后由服务自动维护；整个目录
不在 Git 版本控制中。目录结构：

```text
data/
├── .gitignore                      # 数据目录整体不进 Git
├── workspaces/                     # 工作区数据：设备、路线、清洁配方与测试集
├── devices/                        # 设备拓扑镜像（由 data.rar 提供，服务自动刷新）
├── checkpoints/                    # 页面上传的模型检查点文件（运行时产生）
├── documentation/                  # 本地使用手册（Markdown）
├── registered_algorithms/          # 页面登记的单个算法源文件（运行时产生）
├── registered_algorithms.json      # 页面登记的算法索引（运行时产生）
└── *.lock                          # 运行时文件锁
```

- **workspaces/**：设备、路线、清洁配方与测试集，按设备拆分目录、按测试集拆分文件：
  
  ```text
  data/workspaces/
  └── <设备 id>/
      ├── device.json                 # 设备拓扑 + 共享路线/清洁配方 + 组别
      └── tests/
          └── <测试集 id>.json        # 单个测试集
  ```
  
  - **分享整台设备**（含其全部测试集）：拷贝整个 `<设备 id>/` 目录。
  
- **devices/**：按设备 ID 独立保存的设备拓扑镜像，由服务在保存工作区时自动刷新，供外部工具读取，无需手工维护。
  
- **checkpoints/**：页面上传的模型检查点文件（仅支持 `.npz/.pt/.pth/.ckpt`）。浏览器不会提供用户选择文件的真实路径，因此服务把文件复制到该目录，并返回算法运行时可读取的绝对路径。
  
- **documentation/**：本地使用手册，`*.md` 文件由页面「文档」面板通过`/api/documentation` 加载展示。算法仓库维护的接口文档可放在算法包的`docs/documentation/`，两者共用导航与 slug 唯一性校验。
  
- **registered_algorithms/ + registered_algorithms.json**：页面登记的单个算法源文件与登记索引，见「外部算法部署」。
  
- **\*.lock**：服务运行时的文件锁（如 `workspaces.lock`），只承载跨进程互斥、不保存业务数据，服务停止后可删除。
