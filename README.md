# CT MILP Oracle

Cluster Tool（多腔晶圆制造设备）排程的 **MILP 最优求解器**，从 `CT` 主仓库抽取的自包含子集。
吃预处理后的 IR（`PreprocessedTask`），用 Gurobi 求 makespan 最优排程，并能导出可校验的 MoveList。

> 仅含求解器核心，**不含** PPO/RL、Petri 网执行器、数据集生成等重型依赖（torch 等）。

## 依赖

- Python 3.10+
- [Gurobi](https://www.gurobi.com/)（需 license，学术版免费）+ `gurobipy`
- `numpy`

```bash
pip install -r requirements.txt
```

## 用法

```bash
# 合成验证用例（cases.py 里的 case1/2/3）
python scripts/run_milp.py --case 1 --n1 2 --n2 2

# 真实配置场景（CT/config/input_data/*.json），并导出 MoveList
python scripts/run_milp.py --input s1-1c1p-preclean --export

# 时限、打印片数
python scripts/run_milp.py --input s2-1c1p --tl 120 --show 8
```

求解结果含每片每 stage 的进站时刻 `a` / 取走时刻 `r`、发片顺序、swap 决策；
`--export` 把排程铺成 MoveList 写到 `results/output/<场景>.json`。

## 目录结构

```
CT/
  solutions/
    milp.py                  # 核心：建模 + 求解 + 自检 + MoveList 导出
    analytic.py              # 解析法调度（差分约束图 + Bellman-Ford），与 MILP 对照
    cases.py                 # 合成验证用例 case1/2/3
    preprocess/              # raw 接口 → PreprocessedTask IR 流水线
    construct/route_sequence.py
    model/pn_models.py
    takt/                    # 节拍分析（pjob_takt / takt_analysis）
  config/
    paths.py                 # 路径常量
    input_loader.py          # 读取 input_data 录制日志
    input_data/*.json        # 样例场景
    cluster_tool/task_loader.py
  infer/marathon_gen.py      # 合成 job / route 生成（cases.py 依赖，纯 stdlib）
  tool/log_setup.py
scripts/run_milp.py          # 入口
milp_design.md               # 建模设计文档
milp_handoff.md              # 交接说明
```

## 设计文档

建模细节（路径先后 P / 驻留 D / 腔互斥 C / 机器手互斥 R / LoadLock 状态 setup / 双臂换料 swap /
Big-M 收紧等）见 [`milp_design.md`](milp_design.md) 与 [`milp_handoff.md`](milp_handoff.md)。
