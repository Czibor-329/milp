# 双臂 Robot 的加工腔原子换片

## 物理语义

单槽 PM 已有加工完成片、双臂 Robot 携带下一片到达时，一次开门内执行：

1. 空臂从 PM 取出已加工片；
2. 另一臂把未加工片放入同一 PM 槽；
3. 关门并立即开始下一片加工；
4. Robot 携已加工片离开。

MoveList 用一条 `MoveType=4` 表示中间的原子动作。`RecvMatList` 是从 PM
取出的旧片，`SendMatList` 是放入 PM 的新片；`RecvSlotList` 与
`SendSlotList` 必须是不同 Robot 手槽。

## 调度实现

解码器仍先按保守容量 Petri 网生成无死锁顺序。`solve_timing` 在固定顺序中识别：

- 同一物理 PM 槽的连续两次占用；
- 出片与入片使用同一台 `capacity >= 2` 且 `can_swap` 的 Robot；
- 原 Robot 顺序为“旧片出 PM，下一片入 PM”；
- 两片之间没有 WAC、dummy 或 Job 边界清洁。

满足条件后，Robot 局部顺序提升为“新片入站 hop，旧片出站 hop”，并增加换片
等式约束。PM 资源间隙由“pick + 关门 + 开门 + place”缩短为
“pick-old + place-new”。若换片差分图不可行，自动回退原顺序。

Heuristic、Neural、RL 共用该定时路径。MILP 保留其选腔和析取顺序，
求解后从该顺序恢复同样的换片重定时；重定时无改善时保留原 MILP 解。

## 少片验证

前端 PSE300“单次重算-1Job / t1”的 PM1(40s) 路线：

| 晶圆数 | PM 换片数 | Heuristic makespan | 状态回放 |
| ---: | ---: | ---: | --- |
| 2 | 1 | 228.11 s | 通过 |
| 3 | 2 | 303.95 s | 通过 |

两片案例的唯一换片为：

- PM1 旧片加工结束：`85.14`
- 开门：`85.14 → 88.97`
- `SwapMove(片1 → Robot, 片2 → PM1)`：`88.97 → 100.10`
- 关门：`100.10 → 100.85`
- 片2 加工：`100.85 → 140.85`

回归测试还逐项验证：携新片的转位恰在 SwapMove 起点结束、携旧片离开的转位
恰在 SwapMove 终点开始、换片时长等于 PM 的 `PickTime + PlaceTime`，以及连续
三片时两次换片的手槽状态均能通过 MoveList 整机回放。
