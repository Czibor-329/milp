# 运行、验收与策略选择

所有策略由 `scripts/run.py` 调用。单场景使用 `src/input_data` 中的名称；数据集模式可与存储的 MILP 标签比较 makespan gap。

```powershell
# 快速默认策略
python scripts/run.py --strategy heuristic --input s1-1c1p-preclean

# 双作业策略对比
python scripts/run.py --strategy heuristic search paper random bc --subsets train/2job --limit 3 --search-seconds 7 --random-orders 64 --seed 0

# MILP 基准及 MoveList 导出
python scripts/run.py --strategy milp --input s1-1c1p-preclean --tl 120 --export
```

`--strategy all` 当前展开为 `heuristic search paper random bc`，不包含 MILP。`--export` 将结果写入 `results/output/<strategy>/<subset-or-input>/`；`--out eval.json` 在数据集模式额外写逐实例记录与汇总。`--seed` 控制 `search`、`random`、`bc` 的随机性；`--search-seconds` 只影响 `search` 与 `paper`；`--random-orders` 只影响 `random`；`--tl` 只影响 `milp`。

## 结果验收

统一运行器会对每个可行结果执行两层检查：

1. `check_solution` 检查 schedule 的路径、腔、机器人、LoadLock 和清洁约束。
2. 排程导出为 MoveList 后，`validate_move_list` 再检查压力状态、门/取放重叠、ATM/VAC 访问侧和动作依赖。

控制台中的 `f` 表示是否得到可行排程，`v` 是两层校验发现的违例数。数据集中的 `gap%` 相对于已保存的 MILP 标签计算；无标签测试集显示为空，不代表策略更优或更差。

## 选型建议

| 目标 | 推荐 |
| --- | --- |
| 尽快获得可靠排程 | `heuristic` |
| 保持基底并用少量额外时间改进 | `random` |
| 两 route、可投入数秒 | `search` |
| 关注 PM 任务池排序、可投入数秒 | `paper` |
| 已训练 BC 模型，想利用历史 oracle 行为 | `bc`（默认保留 fallback） |
| 获取基准/标签或证明最优性 | `milp` |

比较策略时应固定输入、Gurobi时限、随机种子和策略预算，并同时报告 makespan、可行率、校验违例数与墙钟时间。对多容量加工腔，timing 系列与 MILP 的门簇建模口径不同，结论需单独标注。
