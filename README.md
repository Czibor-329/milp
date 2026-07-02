# CT MILP Oracle

Cluster Tool（多腔晶圆制造设备）排程的 **MILP 最优求解器**，从 `CT` 主仓库抽取的自包含子集。
解析（`parse_task`）直接把 raw 接口产出求解器要的 `Problem`（拓扑 + 已展开晶圆 + 前/后清洗），
用 Gurobi 求 makespan 最优排程，并能导出可校验的 MoveList。

> 仅含求解器核心，**不含** PPO/RL、Petri 网执行器、数据集生成等重型依赖。

## 依赖

- Python 3.10+
- [Gurobi](https://www.gurobi.com/)（需 license，学术版免费）+ `gurobipy`
- `numpy`

```bash
pip install -r requirements.txt
```

## 用法

```bash
# 数据集批量评测（默认全子集，仅 heuristic），三策略对比：random / bc / heuristic
python scripts/run.py --strategy heuristic bc random --subsets train/2job --limit 3

# 真实配置场景（src/input_data/*.json）跑 MILP oracle 并导出 MoveList（旧 run_milp）
python scripts/run.py --strategy milp --input s1-1c1p-preclean --export --tl 120

# 导出各策略 MoveList + 写汇总 JSON
python scripts/run.py --strategy heuristic --export --out eval.json
```

统一入口 `scripts/run.py` 支持四种策略（`--strategy`，可多选，`all`=random/bc/heuristic）：
`heuristic`（快速启发式定序）、`random`（启发式基底叠随机 rollout）、`bc`（模仿学习策略）、
`milp`（Gurobi oracle）。数据集模式与 `result.makespan`（MILP 标签）比 gap%；`--input` 单场景模式
自检 + 导出。`--export` 把排程铺成 MoveList 写到 `results/output/<strategy>/<子集>/inst_XXXX.json`。

## 目录结构

```
src/
  model.py            # 工作数据类：Chamber/Robot/Stage/Wafer/Problem/CleanSpec/Durations
  parse.py            # parse_task(tool_topo, update_params) -> Problem（解析 + 晶圆展开，含 load_alg_entries）
  clean.py            # 清洗条件解析 + dummy 晶圆合成
  dual.py             # 双腔成对视图
  milp.py             # 核心：建模 + 求解 + 自检 + MoveList 导出（消费 Problem）
  timing.py           # 定时层：差分约束图 + Bellman-Ford + 局部搜索寻优
  features.py / labels.py / policy.py   # 模仿学习（BC）：特征 / 标签 / 候选打分网络
  marathon_gen.py     # 合成 job / route 生成（纯 stdlib）
  paths.py            # 路径常量
  log_setup.py        # 日志
  input_data/*.json   # 样例场景
scripts/
  run.py              # 统一入口：策略(heuristic/random/bc/milp) × 模式(数据集批量 / 单场景) → 评测/自检/导出
  gen_test.py         # 数据集生成（YAML 案例清单 → MILP 标注，swap 关）
  extract_labels.py / train_bc.py       # BC 标签抽取 / 训练
  dataset/cases/*.yaml  # 生成用案例清单（逐工序腔数 × proc）
milp_design.md        # 建模设计文档
milp_handoff.md       # 交接说明
```

## 设计文档

建模细节（路径先后 P / 驻留 D / 腔互斥 C / 机器手互斥 R / LoadLock 状态 setup / 双臂换料 swap /
Big-M 收紧等）见 [`milp_design.md`](milp_design.md) 与 [`milp_handoff.md`](milp_handoff.md)。
