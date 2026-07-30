# CT 调度平台

调度算法位于本仓库根目录的 `alg/`；该目录已被父仓库 Git 忽略。

## 首次部署

按以下顺序准备运行所需的数据与算法。

1. 将 `docs\\data.rar` 解压后，替换 `realtime_scheduler\\data\\`

2. `docs\\alg-heuristic-20260730-bf5c6c3.zip` 是启发式算法包。解压后将其中的 `alg` 目录放到仓库根目录

3. 外部算法统一放在 `alg\\other_alg\\` 中。每个外部算法使用独立子目录，并提供标准入口 `infer\\scheduler.py`。

## 最简文件树

```text
milp/
├── docs/
│   ├── data.rar
│   └── alg-heuristic-20260730-bf5c6c3.zip
├── realtime_scheduler/
│   └── data/                         # 由 data.rar 解压得到
└── alg/                              # 由启发式算法包解压得到
    ├── infer/
    │   └── scheduler.py
    ├── src/
    └── other_alg/
        └── <外部算法名>/
            └── infer/
                └── scheduler.py
```

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

