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
- `torch`（仅神经网络策略需要；PSE300 L2D 的训练和推理都需要）

```bash
pip install -r requirements.txt
# 使用 PSE300 L2D 时再安装，CPU 版即可
pip install -r requirements-l2d.txt
```

## PSE300 L2D 动态析取图策略

`src/schedule/l2d/` 实现固定选腔、只学习操作顺序的 L2D 风格 GraphCNN + Actor-Critic。解析期
会为每片晶圆 round-robin 分配严格递增且不重复的实际 PM 路径，LA/LB 仍按 rank 固定；
Actor 每步只在 Banker 安全候选中选择动作。完整顺序产生后只调用一次 timing 引擎求精确
时刻，因此这不是在线 MILP，也不是生产过程中的实时重调度。

```bash
# 第一阶段：单 Job，PM1–PM4，1–3 道工序，5–25 片
python -m src.schedule.l2d.train --phase one-job --output l2d_pse300_1job.pt

# 第二阶段：从第一阶段参数继续训练两个 PM 不共享的 Job
python -m src.schedule.l2d.train --phase two-job \
  --init l2d_pse300_1job.pt --output l2d_pse300_2job.pt

# 固定验证集评测 makespan、相对启发式 gap、耗时和 MoveList 合法性
python -m src.schedule.l2d.evaluate --checkpoint l2d_pse300_2job.pt
```

新训练默认使用 `pse300-hop-v2` 特征、跨 4 条轨迹的 PPO 更新和训练期方差基线；旧 v1
checkpoint 仍可按原特征语义做一次 greedy 推理。三并行腔退化的复现矩阵、根因和重新训练
验收要求见 [docs/l2d_three_chamber_investigation.md](docs/l2d_three_chamber_investigation.md)。

代码接口：

```python
from src.schedule.l2d import load_l2d_policy, start_schedule_l2d

policy = load_l2d_policy("l2d_pse300_1job.pt", device="cpu")
result = start_schedule_l2d(problem, policy)
```

这里的 `problem` 应使用 `process_assignment="acyclic_round_robin"` 解析，使 PM 与 LA/LB
在进入模型前已经固定。第一版不包含清洗、Residency/QTime、实时重调度、双臂 swap 或
PM 动态选腔。

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
`heuristic`（快速启发式定序）、`neural`（深层集合注意力 NumPy 推理 + 有预算物理修复）、
`random`（启发式基底叠随机 rollout）、`bc`（模仿学习策略）、
`rl`（RL 策略限时采样顶层顺序，默认 4 秒且硬限制 4.5 秒）、`milp`（Gurobi oracle）。
数据集模式与 `result.makespan`（MILP 标签）比 gap%；`--input` 单场景模式
自检 + 导出。`--export` 把排程铺成 MoveList 写到 `results/output/<strategy>/<子集>/inst_XXXX.json`。
`--wafer-count N` 可在解析前保持 PJob 比例地重建 N 片任务；缩放后原 MILP 标签自动视为不可用。

六腔共享路线拆成三条双腔路线的 75 片严格 A/B 可直接复现：

```bash
python scripts/benchmark_neural_route_decomposition.py
```

该实验同时比较原六腔 Neural reference、拆分 Neural 和拆分 Heuristic，并输出 makespan、
PM 负载、推理来源和端到端速度；设计与长期质量对照见
[深层神经派工文档](docs/scheduling/neural-dispatch.md)。
其中也说明了 Heuristic、Neural、BC 与 RL 共用的 Petri-ETA LoadLock manager、
接口边界和启发式 A/B 结果。

## 目录结构

```
src/
  parse/              # JSON 解析、工作数据类、清洗条件、双腔视图和输入生成
  timing/             # 固定资源顺序的差分约束图与精确定时
  schedule/           # 深层神经、启发式、RL、L2D、MILP 和实时重排
  export/             # MoveList 导出
  validation/         # MoveList 状态回放与验证
  paths.py            # 路径常量
  log_setup.py        # 日志
  input_data/*.json   # 样例场景
scripts/
  run.py              # 统一入口：多策略 × 模式(数据集批量 / 单场景) → 评测/自检/导出
  train_neural.py     # 强教师轨迹蒸馏 → 安全 NumPy checkpoint
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
