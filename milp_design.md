# Case1 MILP Oracle 设计

任务1（plan.md）：用 Gurobi 复现一个**最优排程器**当 oracle，沿最优轨迹抽 `(obs, 专家动作)` 喂给模仿学习。
论文 *Non-cyclic Scheduling of Single-armed Cluster Tools for Two Wafer Types* 是单臂、两专用产线、无清洗的流水车间，**不能直接套**；本场景是带搬运机器手、阻塞、有限等待（驻留+qtime）、共享腔的 **job-shop**。本文档是建模蓝图。

---

## 0. 已锁定的范围（用户逐条拍板，见 memory `ct-milp-oracle-design`）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 拓扑 | 只做**非级联**：`料口→ATR→LoadLock→VTR→PM→原路回`。级联（3手/双真空腔）以后再说 |
| 2 | 腔分配 | 候选多个 → **round-robin 预处理定死**，不设选腔变量 |
| 3 | 搬运 | 建 swap（双臂换料），即决策 B。swap = pick+place 在同腔合成一趟 |
| 4 | wac | round-robin 后触发点确定 → 预处理展开成固定占腔，不进 MILP |
| 5 | 阻塞 | 不允许举片等空腔；pick 仅在目标腔可立即接收时开始，片堵在源腔由驻留管 |
| 6 | 目标 | makespan |
| 更正① | 同 route 的片按 id 升序加工（id 大不得先于 id 小） |
| 更正② | LoadLock 有真空/大气状态：ATR 只能在大气态存取、VTR 只能在真空态存取 |

---

## 1. 一片晶圆的路径（Case1 R1，从真实 IR 读出）

`R_1`: 11 步，stage（偶）/ transport（奇）交织。R_2 把 LP1→LP2、PM1→PM2，其余相同：

| stage j | 站点 | 类型 | 停留 proc | 进站手 | 出站手 |
|---|---|---|---|---|---|
| 0 | LP1 | source | 0 | — | ATR |
| 1 | LA/LB | loadlock | pump≈19.3（进站=抽气）| ATR | VTR |
| 2 | PM1 | process | 300 | VTR | VTR |
| 3 | **PM3** | process | 100 | VTR | VTR |
| 4 | LA/LB | loadlock | vent≈19.3（出站=充气）| VTR | ATR |
| 5 | LP1 | sink | 0 | ATR | — |

**PM3 是 R_1、R_2 共用** —— 唯一需要"谁先谁后"决策的地方。

## 2. 资源与真实时长（IR）

- 腔（cap=1）：PM1、PM2、PM3、LA、LB（其余 LP/Buffer/Cooler cap≥25 不约束）
- 机器手：**ATR**（cap=1，单臂，scope=LP/LL/Buffer…）、**VTR**（cap=2，双臂 swap，scope=PM/LL）
- 单次动作时长（含开关门）：
  - `pick_dur(R,c) = 门开 pick_prepare[c][R] + pick_time[c] + 门关 pick_complete[c][R]`
  - `place_dur(R,c) = place_prepare[c][R] + place_time[c] + place_complete[c][R]`
  - `move_dur(R)`：ATR=1.1，VTR=1.65（数据里所有站对相同，且装/空载同值）
  - LL：pump≈19.3 / vent≈19.3（LA/LB 各自略不同）

> Case1 特例：所有 process 的 residual_time_limit=-1、transport 的 qtime=-1、无清洗 → 驻留(D)、运输(Q)、清洗约束在 Case1 全部不激活。但代码仍按 IR 通用实现，留给后续 case。

## 3. 决策变量

- **连续** `r[w,j]`：机器手开始把 w 从 stage j 取走的时刻（j=0..K-1）。`r[w,0]` 即发片时刻。
  - 派生（线性表达式，非独立变量）：
    - `a[w,0] = 0`
    - `a[w,j+1] = r[w,j] + pick_dur(robot_j, c_j) + move_dur(robot_j) + place_dur(robot_j, c_{j+1})`
  - `a[w,j]` = w 放进 stage j 完成的时刻；`a[w,K]` = 回到料口 = 完工。
- **0/1** 仅在顺序未被 FIFO 定死处：
  - 共享腔（PM3）上跨 route 两片先后
  - 同一机器手上跨片两次搬运的先后
  - 同一 LoadLock 上两次使用的先后（含状态 setup，见 §4-LL）
- **swap[c, w_out, w_in]**（VTR，§4-S）
- `Cmax`

## 4. 约束（逐条）

记每个"占用 / 搬运"的脚标。`M` 取一个大上界。

**(P) 加工/抽充气完成 + 路径先后**
```
r[w,j] ≥ a[w,j] + proc[w,j]
```

**(D) 驻留**（仅 process 且 residual_time_limit>0）
```
r[w,j] ≤ a[w,j] + proc[w,j] + δ[w,j]
```

**(Q) 运输 qtime**：决策5 不许举片等待 → 每次搬运固定时长，退化为数据检查 `L_j ≤ qtime`，不进求解。

**(C) 腔一次一片**（cap=1 腔）。占用区间
`occ = [a[w,j] − place_dur(进站手,c), r[w,j] + pick_dur(出站手,c)]`：
- 同 route 两片：按 id FIFO，一边倒（无 0/1）
  `occ_end(低id) + setup ≤ occ_start(高id)`
- 跨 route 两片（PM3）：0/1 析取
  ```
  occ_start[w'] ≥ occ_end[w] + setup − M(1−x)
  occ_start[w]  ≥ occ_end[w'] + setup − M·x
  ```
- 同片重访（同 LL 进+出）：按 stage 顺序，precedence 已定，跳过

**(R) 机器手一次一片 + 空手走位**。op(w,j) 占机器手区间 `[r[w,j], a[w,j+1]]`：
- 跨片两 op（同手）：0/1 析取，gap 含空手 move
  ```
  r[w',j'] ≥ a[w,j+1] + move_dur − M(1−y)
  r[w,j]   ≥ a[w',j'+1] + move_dur − M·y
  ```
- 同片两 op：precedence 已序，跳过

**(LL) LoadLock 状态互斥**（更正②）。每次"使用" type ∈ {entry, exit}：
- entry：ATR 放 → pump → VTR 取，结束态=真空
- exit：VTR 放 → vent → ATR 取，结束态=大气
- 同一 LL 连续两次使用 i→j，**状态相关 setup**（静态常数）：

  | i 结束态 | j 需要态 | setup |
  |---|---|---|
  | entry(真空) | entry(大气) | 空充 vent |
  | entry(真空) | exit(真空) | 0 |
  | exit(大气) | entry(大气) | 0 |
  | exit(大气) | exit(真空) | 空抽 pump |

  并进 (C) 的析取里（setup 替换那个 0）。这样"手必须匹配 LL 状态"自动成立，且连续使用状态不符时插入空抽/空充。

**(S) swap（双臂 B）**。VTR 在腔 c 把"取 w_out + 放 w_in"合成一趟（一手托 w_in、一手取 w_out、再放 w_in）：
```
swap[c,w_out,w_in]=1 ⇒
  w_in 进 c 的 place 与 w_out 出 c 的 pick 绑同趟、同点、先取后放（VTR 瞬时持 2）
swap=0 ⇒ 退回 (C)(R) 两趟
```
省掉两次 VTR 往返的空载与门动作。仅 VTR（cap=2）可用；w_in 须已运到 c 边（非举片干等，决策5）。

**FIFO（更正①）**：同 route，`r[低id,0] ≤ r[高id,0]`，且 (C) 的同 route 一边倒，保证 id 升序加工。

## 5. 目标
```
min Cmax;   Cmax ≥ a[w,K]  ∀w   (a[w,K] = 回到料口的时刻)
```

## 6. 实现状态

- **iter-1（已实现并测试，`CT/solutions/milp.py`）**：(P)(D)(Q)(C)(R)(LL)(FIFO) + makespan，round-robin 定腔。搬运为**单片原子搬运**（swap 暂关）。Case1/小规模求到最优。
- **iter-1.5 门-行程重叠（已实现并测试）**：依 validator —— 门动作(MoveType 6/7)只占**站点**、不占机器手(只做 0/1/5)。故四个门时间全部移出机器手关键路径 `L = pick + move + place`；改由
  - **站内停留** (P)：`r ≥ a + place_post(进站门关) + proc + pick_pre(出站门开)`（加工腔门关后才加工、加工完才开门 → 这两个门工艺锁死，留在片路径上）
  - **腔占用** occ：`[a − place − place_pre, r + pick + pick_post]`（站点门-门串行；source 门关 / dest 门开与行程并行被掩盖）
  承载。export 把门铺到与行程并行的位置（源门开在 pick 前、源门关/目标门开在走位中、目标门关在下一动作中）。效果：真实 s1-1c1p-preclean **2605→2366**（介于全门串行 2605 与全门置 0 乐观下界 2196），Case1 857.5→840.9，5+15 2895.8→2760.9，均仍最优、movelist 过校验。
- **iter-1.6 LL 进出 FIFO 解耦（已实现并测试，真实 2x 缺口的真因）**：原 (C) 同 route「一边倒」把
  *所有* w_lo 的腔访问排在 w_hi 之前 —— 对 **重访腔**（LL 每片用两次：entry 早、exit 晚）等于强迫
  w_hi 的 entry 排到 w_lo 的 **exit** 之后，逼每个 LL 按整片往返串行（释放被节流 ~180s/片）。修法：
  FIFO 只在「同 route **同一 stage-index**」成立（entry-vs-entry、exit-vs-exit），不同 visit（entry-vs-exit）
  改用 0/1 析取。效果 s1-1c1p-preclean **2366→1227**（已低于出厂 1559/企业 1306，因清洗尚未建模，§6-3 偏乐观）。
  附带新增 **(Cd) 多容量腔门整站串行**：heater(cap2)/Cooler(cap7) 加工可跨槽并行，但开关门(6/7)共用门机构，
  须站级互斥（validator 规则）——把每访的进站/出站门簇两两不重叠；门短、占用低，仅 +8（1227 vs 无此约束 1219）。
- **瓶颈复盘（iter-1.6 后）**：诊断 swap 价值用 —— makespan 1227 时 VTR util **78%**、heater 70%、LA 69%、ATR 57%。
  即 swap（减 VTR 往返）现是**真**的增量杠杆，但远非旧 handoff 说的 30%（那是 iter-1.5 前门塞进机器手路径时的错判）。
- **iter-1.7 导出补全（甘特图两 bug，仅 export，makespan 不变）**：用户看甘特图发现两处缺失。诊断：
  **时序本已正确**（MILP 已强约束），只是 `export_movelist` 漏铺了两类操作 —— 补铺即可、validator 仍过。
  - **bug1 机器手转位**：VTR 在 heater place 后指向 heater，去 LB pick 须先转过来。该转位时长 = move，
    本就由 (R) 空手 move 间隙强制（实测 place@heater→pick@LB 间隔恰 1.65=move）。修：export 在每次 pick 前
    `[r−move, r]` 铺空载 PreTransMove(type5, 无晶圆, 仅当上一目标≠本源)。共补 143 条。
  - **bug2 LL 空充/空抽**：LA/LB 进片(大气→真空)后留真空态，下一大气片进前须先充气(vent)。该 vent 时长本就由
    `ll_setup`(entry→entry=vent / exit→exit=pump) 强制（实测两连续 entry 间隔恰 19.3=vent）。修：export 在
    下一次占用前 `[occ_s−setup, occ_s]` 铺空 pump/vent(type10)。共补 8 条。LA 时间线现 pump(进)↔vent(空)交替正确。
- **iter-1.8 清洁折叠（决策4，无 swap）**：四类清洁折成**固定占腔事件**（无片、无搬运、无 0/1）：
  - **pre_clean**（route.clean.pre_clean，每 PM 一次，产前）：约束该 PM 首片 `occ_start ≥ dur`；export 铺
    type-9 无片于 `[首片 occ_start − dur, 首片 occ_start]`。
  - **post_clean**（产后）：`Cmax ≥ 末片 occ_end + dur`；export 铺于 `[末片 occ_end, +dur]`。
  - **wac**（StageStep.clean_time/clean_trigger，每 N 片）：按 wid 序每 trigger 片后插一次，
    `occ_start(片 n+1) ≥ occ_end(片 n) + dur`；export 铺于两片间。
  - **dummy_clean**：已由 `synthesize_dummy_routes` 在 IR 前合成为 dummy 晶圆（DummyPort→LL→PM→LL→DummyPort、
    PM 步换清洁 recipe），随 ir.pjobs 正常流转，MILP 无需特殊处理。
  顺带修**多槽 skip 站(loadport)门串行**：LP 单门、由单臂(ATR)访问，sink-place 紧接 source-pick 时两门会撞
  （place_post+pick_pre 恰=2·move）。用 (R) **同站门间隙**（gap=place_post+pick_pre 而非 move）廉价串行，
  不加 0/1（曾试 (Cd) 全槽门簇展开到 LP，O(n²) 致 33 片 dummy 超时，已回退）。
  结果：preclean/postclean/wacclean 均最优(1227,gap0,~12s)、movelist 过校验；Case1/2/3 无回归。
- **iter-2 swap（已实现，加工腔双臂换料）**：在单容量**加工腔**上，相邻两片「出腔 pick 手 == 进腔 place 手」
  且该手双臂(VTR) → 每对设 0/1 `sw`。sw=1：VTR 一趟 `pick(c,w_out)+place(c,w_in)`（swap_dur=pick+place，
  同口径 model_builder.swap_time），进腔 a 链与出腔 r/a 链改条件约束，并放松 (C) 同腔占用序与 (R) 两手活互斥；
  sw=0 退回原子两趟。`a[w,j]` 全改为变量（原 LinExpr）以容纳条件链。check_solution 对 swap 对的腔/手重叠放行。
  - **效果（grid 单工序）**：c2 proc=77 MILP claim 2209→1281、**回放进 C6 实测 2219→1495**（已低于 IL@C6 1535
    —— 坐实"IL 比 MILP 好"是 no-swap 假象）；c1 proc=77 C6 2831→2798。非杠杆例(c6 p10)不变。replay 全可行。
  - **claim 偏乐观 ~17%**：swap_dur 未计门周期/LL 态 setup，MILP claim 低于 C6 实际可达；但**发片序确变好**
    （回放 makespan 降），oracle 喂 IL 标签靠的是发片序，故可接受。
  - **未做**：① LL/LP **多物理槽单臂 combine**（出厂 swap 大头在 LA/LB/LP，本次只建加工腔双臂，故 c2 的真实
    杠杆 LL combine 尚未入模 → claim 与可达仍有缺口）；② `export_movelist` 未画 type-4 swap（数据集存的
    movelist 在 swap 解下会有 VTR 叠层，但无人校验该字段；eval 的 movelist 取自 C6 仿真器已正确）；
    ③ 多工序真实路由(1c2p)swap binary 增多 → LP 界变弱(gap↑)，但 incumbent 不劣（1343→1306）。
