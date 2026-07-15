# CT MILP Oracle

Cluster Tool（多腔晶圆制造设备）排程的 **MILP 最优求解器**，从 `CT` 主仓库抽取的自包含子集。
解析（`parse_task`）直接把 raw 接口产出求解器要的 `Problem`（拓扑 + 已展开晶圆 + 前/后清洗），
用 Gurobi 求 makespan 最优排程，并能导出可校验的 MoveList。

> RL 只负责顶层顺序策略，底层仍由轻量 `timing` 差分约束引擎精确定时。训练需 PyTorch；
> 推理可自动回退到受限 checkpoint 解析 + NumPy MLP。Petri 网执行器不在本仓库内。

## 依赖

- Python 3.10+
- [Gurobi](https://www.gurobi.com/)（需 license，学术版免费）+ `gurobipy`
- `numpy`
- `torch`（仅 `bc` / `rl` 训练需要；推理可只用 NumPy）

```bash
pip install -r requirements.txt
# 训练神经网络策略时再安装，CPU 版即可
pip install torch
```

## 用法

```bash
# 数据集批量评测（默认全子集，仅 heuristic），三策略对比：random / bc / heuristic
python scripts/run.py --strategy heuristic bc random --subsets train/2job --limit 3

# 真实配置场景（src/input_data/*.json）跑 MILP oracle 并导出 MoveList（旧 run_milp）
python scripts/run.py --strategy milp --input s1-1c1p-preclean --export --tl 120

# 导出各策略 MoveList + 写汇总 JSON
python scripts/run.py --strategy heuristic --export --out eval.json

# RL 顶层搜索：4 秒预算；把样例扩成 25 片验证 5→25 外推
python scripts/run.py --strategy rl --subsets train/1stage --limit 1 \
  --wafer-count 25 --rl-search-seconds 4.0

# 默认把任务缩成 5 片训练，并在结束时用少量 25 片任务验证
python scripts/train_rl.py --train-wafers 5 --eval-wafers 25
```

统一入口 `scripts/run.py` 支持多种策略（`--strategy`，可多选）：
`heuristic`（快速启发式定序）、`random`（启发式基底叠随机 rollout）、`bc`（模仿学习策略）、
`rl`（RL 策略限时采样顶层顺序，默认 4 秒且硬限制 4.5 秒）、`milp`（Gurobi oracle）。
数据集模式与 `result.makespan`（MILP 标签）比 gap%；`--input` 单场景模式
自检 + 导出。`--export` 把排程铺成 MoveList 写到 `results/output/<strategy>/<子集>/inst_XXXX.json`。
`--wafer-count N` 可在解析前保持 PJob 比例地重建 N 片任务；缩放后原 MILP 标签自动视为不可用。

## 目录结构

```
src/
  model.py            # 工作数据类：Chamber/Robot/Stage/Wafer/Problem/CleanSpec/Durations
  parse.py            # parse_task(tool_topo, update_params) -> Problem（解析 + 晶圆展开，含 load_alg_entries）
  clean.py            # 清洗条件解析 + dummy 晶圆合成
  dual.py             # 双腔成对视图
  milp.py             # 核心：建模 + 求解 + 自检 + MoveList 导出（消费 Problem）
  timing/             # 定时层：差分约束图 + Bellman-Ford；RL/BC 只向它提供顶层资源顺序
  features.py / labels.py / policy.py   # 模仿学习（BC）：特征 / 标签 / 候选打分网络
  marathon_gen.py     # 合成 job / route 生成（纯 stdlib）
  paths.py            # 路径常量
  log_setup.py        # 日志
  input_data/*.json   # 样例场景
scripts/
  run.py              # 统一入口：策略(heuristic/random/bc/milp) × 模式(数据集批量 / 单场景) → 评测/自检/导出
  gen_test.py         # 数据集生成（YAML 案例清单 → MILP 标注，swap 关）
  extract_labels.py / train_bc.py       # BC 标签抽取 / 训练
  train_rl.py         # 5片 self-critical RL 微调；结束时做 25 片规模外推验证
  dataset/cases/*.yaml  # 生成用案例清单（逐工序腔数 × proc）
milp_design.md        # 建模设计文档
milp_handoff.md       # 交接说明
```

## 设计文档

建模细节（路径先后 P / 驻留 D / 腔互斥 C / 机器手互斥 R / LoadLock 状态 setup / 双臂换料 swap /
Big-M 收紧等）见 [`milp_design.md`](milp_design.md) 与 [`milp_handoff.md`](milp_handoff.md)。
