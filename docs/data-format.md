# 本地数据格式与交换规则

## 用户入口

设备和测试集必须通过前端“设备与测试集”卡片中的“导入 / 导出”操作交换。
`realtime_scheduler/data/` 是服务端内部存储，不是用户接口；不要手工复制、改名或合并其中的文件。

交换分为两个层级：

- **设备包**：包含设备 init、路径、组别和设备下全部测试集，可导入到另一套平台。
- **测试集包**：只包含一个测试集及其引用路径；导入时当前设备的 init 指纹必须与来源设备完全一致。

交换包使用 ZIP 容器并携带 `manifest.json`。导入不会静默覆盖同 ID、不同内容的数据；不支持的高版本数据包会被拒绝。
一个工作区最多保存 10 台设备；达到上限后仍可导入与现有 init 指纹相同的设备包以
合并测试，但新增不同设备会被拒绝。

## v6 主数据结构

`data/datasets/` 是设备与测试集唯一事实来源，不再生成 `data/devices/` 拓扑镜像。

```text
datasets/
├── manifest.json
└── <device UUID>/
    ├── metadata.json
    ├── device.json
    ├── routes.json
    ├── groups.json
    └── tests/
        └── <test UUID>/
            └── test.json
```

文件职责：

- `manifest.json`：根格式标识和 `schemaVersion`。
- `metadata.json`：设备稳定 ID、展示名称、指纹、时间戳及 `InitialMoveID` 等兼容初始化选项，不包含路径或测试内容。
- `device.json`：纯算法 init，只包含 `Stations` 和 `Robots`。
- `routes.json`：共享路径模板、路径别名及设备级共享配置。
- `groups.json`：测试组别和 Robot 槽位页面配置。
- `test.json`：单个测试的任务、轮次、路径参数、Clean、策略和 Baseline。

目录使用完整 UUID。展示名称可以重名或修改，不影响磁盘路径和内部引用。

服务在启动阶段检查格式标记和数据文件更新时间；进入正常运行后，设备列表与设备
概览信任设备元数据和 `tests/.tests-index.json`，读取单个测试时按稳定 UUID 直接
定位目标文件，不会为每次请求扫描全部测试。运行期间直接修改 `datasets/` 不属于
支持的交换方式，也不会保证立即被页面发现；外部数据必须通过导入接口进入，维护人员
确需处理内部文件时应先停止服务并在完成后重新启动。

## 版本和迁移

当前格式为 `schemaVersion: 6`。服务开始监听前完成迁移，页面不会读取迁移到一半的数据。

v5 的 `workspaces/` 与 `devices/` 首次升级时执行以下过程：

1. 读取并规范化旧工作区。
2. 在临时目录完整写入 v6 数据。
3. 校验写入成功后原子启用 `datasets/`。
4. 将旧 `workspaces/` 和 `devices/` 移入 `data/migration-backups/`。

格式变化必须逐版本提供幂等迁移器和回归夹具。软件不得猜测或改写高于自身支持版本的数据。

## 运行时数据

`checkpoints/`、`registered_algorithms/`、锁文件、`exports/` 结果与复现日志均不属于设备或测试集交换包，也不能作为设备主数据来源。
