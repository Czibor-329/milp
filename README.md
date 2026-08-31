# CT 调度平台

## 快速开始

仓库不附带设备/测试数据或算法包。首次部署无需解压数据文件：服务会以空工作区启动，
由使用者在页面中导入获授权的设备或测试集交换包。算法也须由使用者按自身交付渠道另行取得。

部署后的最简文件树：

```text
milp/
├── realtime_scheduler/
│   ├── backend/                      # 服务端正式实现与模块启动入口
│   ├── frontend/                     # 浏览器页面与构建产物
│   └── data/                         # 首次运行时自动创建，仅保存本机运行数据
└── docs/                             # 部署与格式说明，不含数据或算法归档
```

启动：

```powershell
python -m realtime_scheduler.backend.main --open
```

默认地址为 `http://127.0.0.1:8765/config_editor.html`

首次打开页面后，在“设备与测试集”卡片选择“导入”：

1. 导入设备包以创建设备，并同时导入其路径、分组和测试集；或先新建设备。
2. 选择目标设备后可导入单个测试集包；目标设备的 init 必须与来源完全一致。
3. 导入完成后，在设备和测试集选择器中选择刚导入的内容即可开始配置和运行。

终端默认显示调度业务阶段并隐藏浏览器轮询访问日志；调试 HTTP 时可增加
`--access-log`，需要更详细的后端日志时可增加 `--log-level DEBUG`。

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

## 数据说明

> [!NOTE]
>
> 分享设备/测试不需要查看、复制或修改 `realtime_scheduler/data/`。设备和测试集的交换统一在页面“设备与测试集”卡片中使用“导入 / 导出”：设备导出包含该设备下的全部信息；测试集导出只包含当前测试，导入时必须先选择 init 完全相同的设备。
>

交换包上传大小限制为 64 MiB，ZIP 内 JSON 解压后的总量限制为 512 MiB；两者独立
校验，以支持包含大量测试集但压缩率较高的设备包，同时防止异常压缩包过度膨胀。
设备包导入导出会在弹窗中显示上传、校验、压缩和写入进度。服务端只读取或更新当前
设备目录；导出不解析其他设备的测试，导入也不会重写未参与交换的设备与测试。

`realtime_scheduler/data/` 由服务自动创建和维护，整个目录不在 Git 版本控制中。
首次启动时其中没有设备或测试数据；请始终通过页面导入/导出交换数据。简化结构：

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
