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
被拦截动作应填写 `reason`，并可携带 Robot、物料、源/目标站点、槽位和预计时间。

算法没有实现该函数时，服务端返回空动作列表。平台不会使用另一套状态机猜测算法
当时的使能动作，也不会把 MoveList 中的后续动作冒充候选。

## 回放与筛选

- 时间轴推进到每个 Pick、Place 或 Swap 完成边界时重新调用接口。
- 状态筛选支持“使能动作、物理拦截、死锁规则拦截、全部状态”。
- 类型筛选支持 Pick、Place、Swap 与全部类型。
- 卡片显示动作路径、Robot、物料和拦截原因；没有接口或没有匹配动作时保持空白。
- 浏览器按动作边界缓存结果，不在动画帧间重复调用算法。
