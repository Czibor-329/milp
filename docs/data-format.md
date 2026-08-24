# 本地数据格式与交换规则

## 用户入口

设备和测试集必须通过前端“设备与测试集”卡片中的“导入 / 导出”操作交换。
`realtime_scheduler/data/` 是服务端内部存储，不是用户接口；不要手工复制、改名或合并其中的文件。

交换分为两个层级：

- **设备包**：包含设备 init、路径、组别和设备下全部测试集，可导入到另一套平台。
- **测试集包**：只包含一个测试集及其引用路径；导入时当前设备的 init 指纹必须与来源设备完全一致。

交换包使用 ZIP 容器并携带 `manifest.json`。导入不会静默覆盖同 ID、不同内容的数据；不支持的高版本数据包会被拒绝。

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
