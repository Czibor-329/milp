# CT 调度平台

调度算法位于本仓库根目录的 `alg/`；该目录已被父仓库 Git 忽略。

## 首次部署

按以下顺序准备运行所需的数据与算法。

1. 将 `docs\\data.rar` 解压后，替换 `realtime_scheduler\\data\\`

2. `docs\\alg-heuristic-20260813-7750ba9.zip` 是当前启发式算法包。解压后将其中的 `alg` 目录放到仓库根目录

3. 外部算法统一放在 `alg\\other_alg\\` 中。每个外部算法使用独立子目录，并提供标准入口 `infer\\scheduler.py`。

## 最简文件树

```text
milp/
├── docs/
│   ├── data.rar
│   └── alg-heuristic-20260813-7750ba9.zip
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

> 服务默认**免登录**（打开即用，适合本地/直接把项目发给别人使用）；对外
> 部署、多人共用时**必须**设置环境变量 `CT_REQUIRE_AUTH=1` 开启登录认证，
> 否则任何能访问地址的人都能操作系统。
>
> 开启登录后：首次启动自动创建默认账号 `admin`（密码 `admin123`，控制台
> 会提示），请立即用 `python realtime_scheduler\server.py --add-user admin`
> 修改密码。账号管理命令见 `docs/deploy-windows.md`。未登录访问页面会跳转
> 到登录页，调用 API 返回 401；健康检查 `/api/health` 不要求登录，供监控探测。
>
> **权限管理**（强制登录模式下生效）：账号分管理员（admin）与普通用户
> （user）两种角色。管理员拥有全部设备与算法权限，登录后在主页面侧边栏
> 进入「用户管理」，可为每个普通用户分配可见的设备（含其测试集）与可用的
> 算法；普通用户登录后只能看到并使用被分配的内容，未分配的设备不可见、
> 未分配的算法不可运行。权限修改即时生效，无需重启服务。

## 对外部署

把平台部署到一台常开的 Windows 电脑上、让用户在任意地点通过公网网址
登录调度的完整步骤（账号管理、开机自启、防火墙、cpolar 内网穿透）见
[`docs/deploy-windows.md`](docs/deploy-windows.md)。



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

本地算法选择器由 `alg/algorithms.json` 驱动。新增算法时只需在算法仓库中：

1. 实现算法，并把算法 ID 加入 `infer/function.py` 的 `SUPPORTED_ALGORITHMS`；
2. 在 `algorithms.json` 的 `algorithms` 数组增加一项。

前端会从健康检查接口自动生成算法卡片，不需要再修改 HTML 或 TypeScript。
`enabled: false` 可隐藏暂不使用的算法；`requiredFiles` 可声明模型等运行依赖，缺失时
卡片仍会显示但不可选择；`optionGroups` 当前支持 `loadlock` 和
`heuristic-objectives` 两个通用参数区。配置由服务实时读取，刷新页面即可生效。

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

### 通过页面登记单个算法文件

不满足目录包结构、只有单个 Python 文件的外部算法，可以在页面「运行策略」
面板点击「＋ 添加算法」，选择包含 `init` 和 `update` 两个函数的 `.py` 文件
即可登记。文件不要求放在 `alg/` 下，也不需要 `CT/infer/scheduler.py`
结构：

```python
def init(topo_data_json):
    ...

def update(tool_json, algorithm=None):
    ...
    return output_json
```

登记会校验文件必须在顶层定义 `init` 和 `update` 两个函数（只做语法与
函数检查，不执行源码）；通过后源文件复制到 `realtime_scheduler/data/
registered_algorithms/<算法名>/` 下，登记信息写入 `realtime_scheduler/data/
registered_algorithms.json`。这两处都在 Git 之外且重启保留，因此登记是
一次性的——刷新页面后新算法就会出现在策略列表里，之后与 `other_alg`
目录算法同样通过 `init/update` 标准接口调用。登记操作需要管理员权限。

