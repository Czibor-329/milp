# 公共解码与定时机制

除 `milp` 外，策略都遵循“候选偏好 -> 安全解码 -> 精确定时 -> 保留最优可行解”的框架。策略只改变候选的优先顺序、发片交织或 LoadLock 选腔；资源约束和时间计算保持一致。

## 解码器的每一步

`decode_orders` 在全部尚未完成的晶圆中构造合法候选。候选必须满足：去向资源未被占用（`reserve=True` 时也不得被预留）；同 route 的发片按 `wid` FIFO；swap 模式下 LoadLock 出片还须遵守进入顺序。默认候选排序键为：近似最早可开始时间、下游阶段优先、晶圆编号。

排序并不等同于直接提交。默认 `banker=True`：解码器按策略给出的偏好顺序逐个模拟，只有模拟后仍能通过纯下游排空完成所有晶圆的候选才会提交。这一安全掩码防止把 LoadLock 或加工腔填满后无处出片的死锁。`banker=False` 仅用于批量搜索或 teacher replay，遇死锁即丢弃该候选解。

`decode_orders_choosing` 是 BC 的选腔版本。若下一站是拥有多个候选的 LoadLock，同一 hop 会按空闲候选腔/槽拆成多个动作；提交后会把选中的腔、槽和对应抽/充气时间写回克隆的 wafer。加工腔仍由解析阶段的 round-robin 静态分配，不属于 BC 的选腔范围。

## 定时与可行性

`solve_timing` 接收固定的腔序、机器人序与 LoadLock 序，并将约束写为 `t_b >= t_a + w` 的有向边：

- 片内加工、搬运链与工艺驻留上界；驻留上界用反向负权边表示。
- 同一腔/槽的占用先后和 LoadLock 空抽/空充 setup。
- 同一机器手相邻 hop 的转位或同站门动作间隙。
- 同 route 的发片 FIFO、清洁（pre/post/WAC/dummy-WAC）和 dummy 清洁段顺序。
- swap 模式下 entry/exit 跨槽共存时的压力态约束。

随后以 Bellman-Ford 求最长路；若存在正环，则该定序无法满足驻留等约束，结果不可行。可行时生成每片各 stage 的进站/取走时刻、makespan，并由 `check_solution` 复核 P/C/R/LL/Clean 约束。

## 共同的保底规则

多数启发式候选会和既有可行解比较，只有 makespan 严格更小才替换。因此离线的
`random`、`search` 与默认 `bc` 都不会比其可行性地板更差。快速启发式本身先评估
backward 基线；当喂片序因驻留不可行时，`start_schedule` 还会以 `reserve=True`
的驻留预留解码回退。

## 已知口径

多容量的非 skip 加工腔在 timing 解码/定时层未显式建模门簇互斥，命中时会告警，makespan 可能偏乐观。MILP 对此建有门簇约束，因此两者比较时需注意该差异。
