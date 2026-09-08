# 拓扑回放：动作状态

## 目标

拓扑回放在每个 Pick、Place、Swap 完成边界更新一次算法动作卡片。动作卡片用于回答：

1. 当前有哪些使能动作；
2. 哪些动作因设备物理条件被拦截；
3. 哪些动作因死锁预防规则被拦截。

回放不再运行推荐模型，也不展示模型偏好、预测工期或“推荐动作”。MoveList 只负责
推进当前设备状态，动作列表由生成该计划的算法解释。

## 算法动作接口

算法入口可以实现可选函数 `get_replay_actions(replay_json)`。输入为 JSON 文本：

```json
{
  "schemaVersion": 1,
  "CurrentTime": 12.5,
  "ToolTopo": {},
  "UpdateParams": {},
  "MoveList": [],
  "MoveStates": []
}
```

返回对象包含 `provider` 与 `actions`。每个动作的 `kind` 只能是 `pick`、`place`、
`swap`；`status` 只能是 `enabled`、`physical-blocked`、`deadlock-blocked`。
每个动作都应填写 `reason`：使能动作说明当前可执行，被拦截动作说明物理条件或
死锁规则。动作可携带 Robot、物料、源/目标站点、槽位和预计时间。

Swap 只在目标模块已有待取晶圆、Robot 手上同时有待放晶圆时成立。
动作括号按收发顺序列出所有涉及的晶圆，路径端点表达为
``Robot#手槽 → 模块#槽位``。Robot 尚未持片时，当前动作仍是 Pick，
不能因为完整搬运预览中后续含 Swap 就提前显示为模块到模块的 Swap。

内置算法列出当前路径的 Pick、Place、Swap。Pick 的目的端是 Robot 手槽
（例如 ``Pick(1) LP1#1 → ATR#1``），不会把下一工艺站或 LoadLock 写成取片目的。
同一 LoadPort / DummyPort / Buffer 上原因相同的拦截 Pick 会合并为一条，并给出
省略片数。算法没有实现该函数时，服务端返回空动作列表。平台不会使用另一套
状态机猜测算法当时的使能动作，也不会把 MoveList 中的后续动作冒充候选。

## 回放与筛选

- 时间轴推进到每个 Pick、Place 或 Swap 完成边界时重新调用接口。
- 状态筛选以复选框提供“使能动作、物理拦截、死锁规则拦截”；默认全部勾选，
  可组合取消不需要的状态。
- 不提供 Pick、Place、Swap 的类型筛选，动作卡片直接展示其类型标签。
- 卡片两列展示 ``Pick(物料) 源#槽 → 目的#槽``，用颜色区分状态，不显示状态文字标签；原因在鼠标悬浮或键盘聚焦时显示。
- 没有接口或没有匹配动作时保持空白。
- 浏览器按动作边界缓存结果，不在动画帧间重复调用算法。
- 回放跨越重算点时，以当前代 `UpdateParams` 的物料位置为起点；跨界搬运不重复
  执行，但其尚未序列化到 update 的开门现场和后续完成事件会继续恢复。动作按
  真实时间排序，同一时刻先完成前驱再启动后继。

## 死锁诊断包

拓扑回放工具栏提供“导出诊断包”。按钮按当前时间轴位置重新调用算法动作接口，
并下载一份 UTF-8 JSON，而不是仅截取页面上经过筛选的卡片。文件包含：

- 当前代完整 `UpdateParams`、`MoveStates`、重算轮次和回放秒数；
- 浏览器画面中的模块槽位、Robot 手槽和晶圆占位快照；
- 每片晶圆的原始 `StepID`、Route step 索引、完整 Route step 摘要和最近完成动作；
- 全部 MoveList，以及当前时刻之前最近二十条已完成或正在运行的 Move；
- 算法返回的全部 Pick、Place、Swap 候选与状态。被拦截动作额外展开
  `materials`、`robot`、`source/sourceSlot`、`destination/destinationSlot` 和原始
  `reason`，便于直接定位具体晶圆、模块、槽位和规则。

诊断包不改变算法判定，也不会用平台规则补造候选。若算法未实现
`get_replay_actions`，文件会保留复现输入并在 `warnings` 中明确说明缺少动作明细。
