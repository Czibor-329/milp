# MILP Oracle + 模仿学习 交接文档（对话浓缩）

> 给下一个会话/账号接力用。自包含，不依赖记忆。配套文件：`milp_design.md`(建模蓝图)、
> `CT/solutions/milp.py`(求解器)、`scripts/run_milp.py`(入口)。

## 0. 全局现状（plan.md 三个任务首版已全部跑通，均已 commit）

| 任务 | 状态 | 产物 |
|---|---|---|
| **任务1** MILP oracle | ✅ 见 §1-6（本文档主体） | `CT/solutions/milp.py` + `scripts/run_milp.py` |
| **任务2** 训练/测试集 | ✅ 见 §A | `scripts/gen_milp_dataset.py` + `scripts/extract_il_dataset.py` → `D:/ct_milp_dataset/` |
| **任务3** 模仿学习 | ✅ 见 §B | `CT/solutions/release_scheduler/imitation.py` + `scripts/{train,eval,run}_il_*.py` |

**当前用户拍板的范围**：单任务(单 route)、**无清洁**、**多工序**；测试集同分布 held-out。
数据集在 **D 盘**（C 盘空间紧）。git 分支 `feat-(milp-imitation)`，最近 4 个 commit 即这三任务。

**一条龙复跑**（venv）：
```
python scripts/gen_milp_dataset.py --n 200 --seed 1000 --train 0.8 --out D:/ct_milp_dataset
python scripts/extract_il_dataset.py --root D:/ct_milp_dataset
python scripts/train_il_policy.py    --root D:/ct_milp_dataset --epochs 400
python scripts/eval_il_policy.py     --root D:/ct_milp_dataset
python scripts/run_il_case.py --id 198 --heur    # 跑单个案例 + MILP/Heur 对照 + 导 movelist
```

## 1. 任务1 在做什么

用 Gurobi(已装 gurobipy 13.0.2 在 venv)写一个 **makespan 最优排程器**当 oracle，
沿最优轨迹抽 `(C6 obs, 专家发片动作)` 喂给任务3的模仿学习。

参考论文 *Non-cyclic Scheduling of Single-armed Cluster Tools for Two Wafer Types*（单臂/两专用产线/
无清洗的流水车间）**不能直接套**——本场景是带搬运机器手、阻塞、有限等待、共享腔的 **job-shop**。
论文里有用的是约束原语（驻留=WRTC、运输、阻塞、单臂序列、makespan），外壳要重写。

## 2. 已锁定的建模决策（用户逐条拍板，别再问）

| # | 决策 | 结论 |
|---|---|---|
| 1 拓扑 | 只做**非级联**：`料口→ATR(大气手)→LoadLock→VTR(真空手)→PM→原路回`。级联(3手/双真空腔)以后再说 |
| 2 腔分配 | 候选多个→**round-robin 预处理定死**，不设选腔变量 |
| 3 搬运 | 选 **B**：建 swap（双臂换料）。**swap 真身 = pick+place 合一趟**（见 §5 诊断②）|
| 4 wac | round-robin 后触发点确定→预处理展开成固定占腔，不进 MILP |
| 5 阻塞 | 不许举片等空腔；pick 仅在目标腔可立即接收时开始，片堵在源腔由驻留管 |
| 6 目标 | makespan |
| 更正① | 同 route 的片按 **id 升序**加工（id 大不得先于 id 小）→同route用FIFO，无0/1开关 |
| 更正② | LoadLock 有**真空/大气状态**：ATR 只能在大气态存取、VTR 只能在真空态存取；切换要 pump/vent |

**唯一真正的 0/1 开关** = 不同 route 的片抢同一共享腔的先后。

## 3. 真实设备数据（从 IR 读出，Case1 与 s1-1c1p-preclean 同拓扑）

- **路径**(s1-1c1p-preclean，11~13步)：`LP → ATR → LL[LA/LB] → VTR → heater → PM[1-4] → VTR → LL → ATR → Cooler → LP`。
  Case1 更简单：`LP→LL→PM1→PM3→LL→LP`（无 heater/cooler/清洗）。
- **机器手**：**ATR** cap=1(单臂)，pick=4.15/place=4.1/move=1.1；**VTR** cap=2(双臂,swap)，pick=5.83/place=5.3/move=1.65。move 所有站对同值、装/空载同值。
- **腔**：PM1-4 cap1；**heater cap2**；**Cooler cap7**；**LA/LB**：建模 cap1(单一压力态)但 **physical_capacity=2**(2物理槽,供 swap)；pump≈19.3/vent≈19.3。
- **门动作**(每腔每手)：pick_prepare/pick_complete/place_prepare/place_complete，如 PM3 pick_prepare=3.83。
- Case1 无驻留(resid=-1)、无qtime、无清洗 → 最干净的首测；真实文件才有 heater/cooler/清洗。

## 4. 已实现（iter-1 + 槽位）并测试通过

**文件**：
- `CT/solutions/milp.py`：`solve_milp(ir, time_limit)` / `export_movelist(ir,res)` / `check_solution(ir,res)`
- `scripts/run_milp.py`：入口，`--case 1/2/3 --n1 --n2`（合成）或 `--input <场景名>`（真实文件 CT/config/input_data）+ `--export`

**怎么跑**：
```
venv/Scripts/python.exe scripts/run_milp.py --case 1 --n1 2 --n2 2 --export
venv/Scripts/python.exe scripts/run_milp.py --input s1-1c1p-preclean --export
venv/Scripts/python.exe CT/tool/validate_movelist.py s1-1c1p-preclean   # 校验
```

**已建约束**（见 milp_design.md §4 细节）：
- 决策变量：`r[w,j]`=机器手开始从 stage j 取走的时刻；`a[w,j]`=放进时刻(线性表达式派生)
- (P)加工/抽充气完成才能取；(D)驻留(Case1不激活)；(Q)qtime(决策5下退化为数据检查)
- (C)腔互斥：按 **(腔,槽位)** 分组(多容量腔 round-robin 槽位→可并行)，同route FIFO/跨route 0-1 big-M；LL 含状态相关 setup(空抽/空充)
- (R)机器手互斥+空手 move(big-M)
- FIFO 发片(更正①)
- round-robin 定腔(LA/LB、PM1-4)
- **movelist 导出**：每段搬运在 `[r,a_next]` 窗口铺 `开门6→pick0→关门7→走位5→开门6→place1→关门7`，stage 另铺 加工9/抽充气10；多容量腔按槽位填 SlotList。过 validate_movelist。

**测试结果**：

| 输入 | wafers | makespan(iter1→1.5) | 求解 | 自检 | movelist |
|---|---|---|---|---|---|
| 合成 Case1 2+2 | 4 | 857.5→840.9(最优) | 0.01s | ✓ | 过校验 |
| 合成 Case1 5+15 | 20 | 2895.8→2760.9(最优) | 2.5s | ✓ | 过校验 |
| 真实 s1-1c1p-preclean | 25 | 2605→2366→**1227**(最优) | 17.5s | ✓ | 过校验 |

> Case1(只cap1腔/无清洗)**完全正确**。makespan 列：iter-1(2605)→1.5门重叠(2366)→1.6 LL解耦+门站级串行(1227)。
> 1227 已 < 出厂 1559 因 s1-1c1p-preclean 的 preclean 尚未建模（偏乐观，见下 §6-4）。

## 5. ★关键问题：真实文件 makespan 2x 偏大（2605 vs 企业最优1306）★

用户反馈：此案例贪心/企业能到 **~1306**，出厂调度器 **1559**，我只到 **2605**。
**诊断结论：不是约束写错，是缺了两个建模，叠加成 2x**：

**① 门动作被串进关键路径（~16%）**。证据：把所有门时间设0 → makespan 2605→**2196**。
真实里腔门**接近时提前开、离开时再关**，与机器手行程/加工**重叠**(validator 也允许门与别槽位并行；
出厂 trace 里 CompleteMove 与 PreTransMove 重叠)。我把 `开门→pick→走→开门→place→关门` 整段串行，
凭空给关键路径加了 ~1000s 门时间。

**② 无 swap/combine（剩 ~30%+）**。经查出厂方案用了 **30 次 swap**(LP1×14/LA×11/LB×5)，
其中 **ATR(单臂)也swap=23**。**"swap"真身 = pick+place 合一趟**：在**多槽位站点**(loadport 多槽、
LL 有2物理槽)单臂也能"放进空槽+从占用槽取"一趟完成；VTR(cap2)双臂还能在工艺腔换料。
我的模型每个 pick、每个 place 都强制单独跑一趟 → 机器手利用率低(VTR 59% vs 出厂74%)、空跑多。

**利用率对照**(s1-1c1p-preclean)：我 VTR busy=1479(含门)/util59%，出厂 VTR busy=1069(不含门)/util74%。
扣掉门后实际搬运工作量相近(~960 vs 1069)，差距在**门上路径 + 利用率(swap带来)**。

## 6. 下一步（按优先级）

1. ✅ **修门-行程重叠（已完成）**：依 validator —— 门(MoveType 6/7)只占站点、不占机器手(只做 0/1/5)。
   把四个门时间全部移出机器手路径 `L=pick+move+place`；改由 (P) 站内停留
   `r ≥ a + place_post + proc + pick_pre`（工艺锁死的两个门留在片路径）+ occ 腔占用
   `[a−place−place_pre, r+pick+pick_post]`（站点门-门串行、被行程掩盖的两个门进 occ）承载。
   export 把门铺到与走位/加工并行处。效果 **2605→2366**（介于 2605 与全门置 0 的 2196）；
   Case1/5+15 仍最优、movelist 过校验。详见 milp_design.md §6 iter-1.5。
2. ✅ **真实 2x 真因 = LL 进出 FIFO 过约束（已修，iter-1.6，非 swap！）**：原 (C) 同 route「一边倒」对
   **重访腔**（LL 每片 entry+exit 两次）强迫 w_hi 的 entry 排在 w_lo 的 exit 之后 → 每 LL 按整片往返串行、
   释放被节流 ~180s/片。修法：FIFO 只在「同 route 同 stage-index」用，entry-vs-exit 改 0/1。
   **2366→1227**（已 < 出厂 1559 / 企业 1306，因清洗未建模、偏乐观）。附带 **(Cd) 多容量腔门站级串行**
   （heater/Cooler 加工跨槽并行、门共用须互斥，+8）。瓶颈复盘：1227 时 VTR util 78%/heater 70%/LA 69%/ATR 57%。
3. **swap/combine**（iter-2，**增量**非大头）：VTR(78%) 是新瓶颈，swap 减其往返可再降一些，但远非旧说的 30%
   （那是门塞机器手路径的错判，iter-1.5 已纠）。核心 "pick+place 合一趟"，先 Case1 钉时序。
4. ✅ **清洗折叠（决策4，已做，iter-1.8）**：四类清洁=固定占腔事件(无片/无搬运/无0/1)。
   pre=首片 occ_start≥dur；post=Cmax≥末片 occ_end+dur；wac=每N片 occ_start(n+1)≥occ_end(n)+dur；
   dummy 已由 synthesize_dummy_routes 合成 dummy 晶圆随 pjobs 流转。清洁=MoveType9 无片(非 type4=swap)。
   顺带修 loadport 单门串行(用 (R) 同站门间隙 place_post+pick_pre，不加 0/1)。
   preclean/postclean/wacclean 最优过校验；dummy(33片)过校验但 cross-route 0/1 爆炸→100s gap26%(待提速)。
5. **swap/combine**（iter-2，增量）：见上 §6-3。
6. **dummy 33 片求解提速**：dummy route≠product route 致 LA/LB cross-route 0/1 爆炸。可 symmetry-break/warm-start。
   建模思路(milp_design.md §4-S)：在共享腔对 (w_out 出, w_in 进) 设 `swap` 0/1，=1 时把
   w_in 的 place 与 w_out 的 pick 绑同趟同点(VTR瞬时持2 / 多槽位单臂用空槽)，去掉两次往返。
   注意 ATR 在 loadport/LL 的单臂 combine 也要建（占 swap 大头）。
3. **清洗折叠**（决策4）：pre/post/dummy/wac。dummy/dummy-wac 已是合成晶圆(synthesize_dummy_routes)；
   pre/post_clean 在 `route.clean`(CleanSpec)，需折进对应腔占用；wac(waferless)是无搬运的占腔事件。
   真实文件(s1-1c1p-preclean 等)目前**没建清洗**，makespan 偏乐观。

## 7. 注意事项/坑

- 控制台 GBK：脚本里已 `sys.stdout=TextIOWrapper(...utf-8)`；打印 ✓ 等字符需保留。
- makespan 自检 `check_solution` 只查 (P)(C)(R)；它通过≠贴合真实，仅证 MILP 自洽。
- 多容量腔槽位是 round-robin **预分配**（非求解决策），符合决策2缩空间口径。
- 任务1/2/3 代码均已 commit 于分支 `feat-(milp-imitation)`。

---

# §A. 任务2 · 训练/测试集生成（MILP 标注）

**数据流**：随机 `update_params`(AlgSchedule) → `preprocess(ai, up)` → IR → `solve_milp` →
`export_movelist`。基础拓扑(Robots/Stations/传输时间)固定取 `s1-1c1p-preclean` 的 AlgInit，route 由随机 job 覆盖。

**A-1 实例生成** `scripts/gen_milp_dataset.py`：
- 随机 job 来自 `CT/infer/marathon_gen.py` 的 `JobSpec`。本任务给它加了 `clean=False` → `clean_type="none"`
  （`clean=True` 时 rng 流不变，无回归）；`job_process_recipes` 在 "none" 时跳过清洗 recipe。多工序复用已有 `stage_range`。
- 路径=裁剪版 s1-1c1p：`LP→ATR→LL→VTR→PM(stage0)→VTR→PM(stage1)…→VTR→LL→ATR→LP`（无 heater/cooler）。
- 每实例全信息落**一个自包含 json**：`spec`(lp/n_wafer/stages/proc_times) + `update_params` +
  `result`(status/makespan/gap/releases/schedule/self_check) + `movelist`。同分布随机划 train/test。
- 输出 `D:/ct_milp_dataset/`：`manifest.json` + `train/inst_NNNN.json` + `test/inst_NNNN.json`。
  **文件名用 0-indexed `i`**（注意日志打 `[i+1/n]`，文件是 `inst_{i:04d}`）。
- 实测 n=200 seed=1000：**200/200 gap0%（最优）、自检全过**、22s、~24MB；train159/test41。
  movelist 抽样过 `validate_movelist`（含 3 工序路径）。

**A-2 (obs,动作) 抽取** `scripts/extract_il_dataset.py`（这是旧 §1 说的「沿最优轨迹抽 (obs,专家动作)」）：
- 逐实例重建 C6：`net = make_env(env_overrides={"ir":ir,"template":init_net(ai)}).net`，
  `GreedyExecutor(net, external_release=True)` + `SlotProjector(net)` + `ReleaseObs(pr)`。
- **ExpertReplayPolicy（teacher-forcing）**：按 MILP `releases` 的发片时刻；在每个决策点
  `now ≥ 下一片目标时刻 且 C5 mask 可行 → 发`，否则 `SKIP`。多 route 时优先 JIT 推荐 `rp.slot.recipe`。
- 回放循环 **mirror `run_episode` 但去掉 buffer 门**（学习策略自掌时序，故训练分布也无 rope 门）。
  每决策点记 `(ReleaseObs.build(ex,rp), 动作 0=SKIP/1=发片)`。
- 聚合 `il_train.npz / il_test.npz`（X=obs dim26, y∈{0,1}）+ `il_manifest.json`。
- 实测：200 实例**全部 finished / 无 scrap / 发片数=MILP（bad=0）**；train 3739 对 / test 1108 对，
  obs∈[0,1] 无 NaN，发片占比~0.33。
- **obs 维度 26** = `ReleaseObs` 默认(max_resources6×2 + max_recipes4×3 + 2)。policy 推理必须用同样默认配置。

# §B. 任务3 · 模仿学习（行为克隆）

**B-1 策略** `CT/solutions/release_scheduler/imitation.py`：
- `ReleaseNet`：MLP `26→64→64→1`，输出 P(发片) 的 logit。
- `ImitationPolicy(model, projector, threshold=0.5)`：**drop-in 替 `HeuristicPolicy`**，同
  `act(executor, rp, mask)` 签名。`ReleaseObs` 取观测→sigmoid≥阈值则发(JIT 推荐/首个可行 route，
  **与 C5 mask 取交**)，否则 SKIP。`save_model/load_model` 存/读 `il_policy.pt`。
- 单 route 下动作退化为 发/SKIP 二选一——**学的就是 takt(节拍)**。多 route 已留好扩展（按 rp.options 选）。

**B-2 训练** `scripts/train_il_policy.py`：`il_train.npz` BCEWithLogits（正样本加权 (1-p)/p 抗 0.34 不均衡），
full-batch Adam。400ep test_acc **0.79** vs 多数类基线 0.66。**注：分类准确率非终极指标，下游 makespan 才是。**

**B-3 评测** `scripts/eval_il_policy.py`：测试集逐实例重建 env 跑整局。
- **IL 用 buffer=∞**（学习策略自掌发片时序，与抽数据口径一致，无 rope 门）；
  **Heuristic 用 buffer=3**（其原生 rope 配置=当前 baseline）；MILP=实例 json 最优 makespan（下界参考）。
- ⚠ MILP makespan 与 C6 仿真时间模型有口径差 → 比值是**指示性非精确**（偶见 IL/Heur < 1.0×）；
  IL vs Heur 在同一仿真器上才是严格 apples-to-apples。
- **结果（41 测试实例，全完工 / 0 scrap）**：IL makespan/MILP **均1.011 中位1.006** WPH35.7；
  Heur 均1.031 中位0.986 WPH34.2。**IL 更贴最优、方差更小，消掉 Heur 在单工序实例上的 ~1.2x 长尾。**

**B-4 单案例跑 + 对照 + 导 movelist** `scripts/run_il_case.py`（**用户要的脚本**）：
```
python scripts/run_il_case.py --id 198 --heur     # 测试集实例 198，IL+MILP(+Heur) 对照
```
重建 env 用 `il_policy.pt` 跑整局 → IL movelist；MILP movelist 直接取实例 json。两份(可选三份)
写到 `CT/results/output/{milp,il,heur}_inst_NNNN.json`，打印 makespan 对照。可
`validate_movelist.py il_inst_NNNN` 校验、或拖进 `CT/tool/movelist_gantt_viewer.html` 看甘特图。
实测 inst198：IL 698.0(0.998x) / MILP 699.5 / Heur 794.1(1.135x)，IL movelist 过校验。

# §C. 任务2/3 后续可做（按增益）

1. **DAgger 一轮**（增益通常最大）：学生 rollout 访问状态 → 调 MILP 重标 → 补进训练集，解 BC 分布漂移。
2. **多任务/多 route 扩展**：marathon_gen 已有 `build_concurrent_update`；`expert_act` 已按 `rp.options` 选 route，
   动作编码从 发/SKIP 二元扩成 route-index∪SKIP；obs 的 recipe 槽位也已多 route 友好。
3. **OOD 测试集**：放更大 n_wafer/更多工序验泛化（plan 任务2 原提，当前用户选了同分布）。
4. **训练提分**：mini-batch + 输入标准化 + 阈值调参（当前 0.5 full-batch）。
5. **清洁**：当前数据集 clean=False；要带清洁就 `JobSpec(clean=True)`，但 MILP 清洁折叠 dummy 33 片求解慢(§6-6)。

---

# §D. 单任务增强轮（6 腔室 + 驻留 + 泛化，已 commit `0a912cb`）

**做了什么**：把单任务无清洁从「3 腔 / 无驻留 / 40-120 / n=200」升到
「6 腔 / 加工腔驻留 / 40-200 / n=500」，并验证泛化。数据集在 `D:/ct_milp_dataset_6pm`。

**新参数（gen_milp_dataset CLI）**：`--pm-pool 6`(expand_topo_pms 现合成 PM5/6)、
`--residency 60`(挂到 process PM 步)、`--proc-min/max`、`--stage-max 2`、`--no-replay-filter`。
extract/eval/run 都已 `expand_topo_pms(PM_POOL_6)`；eval 加 `--model` 指外部模型(供 OOD)。

**★驻留暴露的执行器缺口（关键坑，下一轮务必记住）**：贪心 C6 执行器**无全流水线前瞻**，
按「最快完成」取片 → 晶圆在加工腔超驻留窗未撤离即 scrap。合成路径 PM 段间**无缓冲库所**
(LL→PM(s0)→PM(s1)→…，段间只有 VTR 机器手)，下游腔忙时上游片只能堵在加工腔→scrap。
实测裸贪心 37% scrap，且**放宽驻留(40/60/80s)仅 37%→30%→27%→20%**（堵塞等待可达下游
proc~200s，靠放宽治不了）。真正杠杆 = **每工序≥2 并行腔**：stage-max=2 时 6 腔分两组
≥2 腔/工序，下游几乎总有空位 → 60s 驻留下 scrap 仅 7.5%。

**两处应对（executor.py + replay 过滤）**：
- `_greedy_actions` 改 **LST 撤离**：受驻留约束的取片按松弛(proc+limit−stay，最急先做)优先，
  否则原「最快完成」。无驻留 slack=inf 退化历史行为（旧 200 实例零回归，pair 数一致）。
- 操作点 **residency=60 + stage-max=2**；gen 用 `replay_feasible`(replay.py) **过滤**：只留
  贪心可无 scrap 实现的 MILP 解 → 训练/测试全干净（500 实例跳 83≈14%）。
- `replay.py` 抽出 `build_executor/replay_milp/replay_feasible`，gen(判可行)与 extract(记 obs)复用。

**结果**：
| 评测 | IL 完工/ratio/scrap | Heur 完工/ratio/scrap |
|---|---|---|
| 同分布(92 test) | 90/92 · **1.085x**(中位1.068) · 2 · WPH47 | 88/92 · 1.303x · 4 · WPH40 |
| OOD-配方(3 工序) | 59/60 · 1.092x · 1 | **42/60** · 1.038x* · **18** |
| OOD-加工(200-300s) | 60/60 · **1.048x** · 0 | 54/60 · 1.351x · 6 |
| OOD-晶圆(16-30 片) | 59/60 · 1.054x · 1 | 59/60 · 1.307x · 1 |

\*Heur 1.038 只在它完工的 42 个上算；3 工序结构 OOD 它 scrap 18/60，IL 仅 1。
**结论：IL 全 OOD 维持 ~1.05-1.09x MILP，远优于 Heur，且结构 OOD 鲁棒性碾压(scrap 1 vs 18)。**

**未做/下一步（用户既定路线）**：Phase C = 多任务(先 2 任务)→ 加清洁。
注意多任务并发会**加剧拥塞→驻留可行性更紧**(stage-max/腔并行度/过滤率都要重估)；
动作编码从 发/SKIP 扩成 route-index∪SKIP；MILP 跨 route 0/1；清洁见 §6-4/§6-6。
