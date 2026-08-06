# CT 调度平台

调度算法位于本仓库根目录的 `alg/`；该目录已被父仓库 Git 忽略。

## 首次部署

按以下顺序准备运行所需的数据与算法。

1. 将 `docs\\data.rar` 解压后，替换 `realtime_scheduler\\data\\`

2. `docs\\alg-heuristic.zip` 是启发式算法包。解压后将其中的 `alg` 目录放到仓库根目录

3. 外部算法统一放在 `alg\\other_alg\\` 中。每个外部算法使用独立子目录，并提供标准入口 `infer\\scheduler.py`。

## 最简文件树

```text
milp/
├── docs/
│   ├── data.rar
│   └── alg-heuristic-20260805-b5fa81c.zip
├── realtime_scheduler/
│   ├── data/                         # 由 data.rar 解压得到
│   │   ├── workspaces/               # 工作区数据（拆分目录，见下）
│   │   ├── devices/                  # 设备拓扑镜像
│   │   └── experiments.json
│   └── exports/                      # 运行结果与复现日志（可随时清理）
└── alg/                              # 由启发式算法包解压得到
    ├── infer/
    │   └── scheduler.py
    ├── src/
    └── other_alg/
        └── <外部算法名>/
            └── infer/
                └── scheduler.py
```

## 工作区数据存储

设备、路线、清洁配方与测试集保存在 `realtime_scheduler/data/workspaces/`，
按设备拆分目录、按测试集拆分文件，便于单独拷贝分享：

```text
data/workspaces/
└── <设备 id>/
    ├── device.json                 # 设备拓扑 + 共享路线/清洁配方 + 组别
    └── tests/
        └── <测试集 id>.json        # 单个测试集
```

- **分享测试集**：把 `data/workspaces/<设备 id>/tests/<测试集 id>.json`
  发给同事，放入对方相同设备的 `tests/` 目录，刷新页面即生效（无需重启）。
- **分享整台设备**（含其全部测试集）：拷贝整个 `<设备 id>/` 目录。
- **旧版单文件迁移**：首次启动会自动把旧的 `data/workspaces.json` 拆分为
  上述目录结构，原文件保留为 `data/workspaces.json.legacy.json`，确认无误后
  可手动删除。
- 数据目录不在 Git 版本控制中；`data/devices/` 中的设备拓扑是自动生成的镜像。

## 启动

完整开发环境先安装算法依赖，再从算法仓库环境启动服务：

```powershell
python realtime_scheduler\server.py --open
```

不带完整算法仓库时，安装主仓库依赖并使用任意兼容 Python 环境启动：

```powershell
python realtime_scheduler\server.py --open
```

默认地址为 `http://127.0.0.1:8765/config_editor.html`



## 算法部署方式

启发式算法目录固定为：

```text
<本仓库>/alg
```

其中必须提供：

```text
<算法名>/infer/scheduler.py				# 必须包含初始化函数init和重算函数update
src/
```

外部算法包放到：

```text
<本仓库>/alg/other_alg/<算法名>/infer/scheduler.py
```

算法包保留 `CT/infer/scheduler.py` 结构也可以。若打包算法位于其他目录，
设置：

```powershell
$env:CT_OTHER_ALGORITHM_ROOT = "D:\path\to\alg\other_alg"
```

`CT_OTHER_ALGORITHM_ROOT` 只在需要将外部算法存放到非默认位置时设置。

