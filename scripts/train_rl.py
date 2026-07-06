"""RL 微调 BC 策略：self-critical REINFORCE，无死锁拐杖(banker-free)、遇死锁/超驻留即截断。

动机：纯 BC 逐候选打分只学「专家被选中率」，对 2job 的全局交错决策力有未逮（表达力上限
0.723），且部署靠 banker + 64 采样 + 启发式地板兜底才可行。RL 直接优化真正指标——rollout 的
makespan gap——并让策略【自己】学会不死锁（不再依赖 banker 拐杖）。

环境 = decode_orders_choosing(banker=False)：每步策略在候选 (hop,腔) 上按 softmax(分/temp) 抽动作，
直接提交（无安全掩码）。走到某步无候选 = 死锁 → 截断，按已放片比例给渐进负奖励；走到底再
solve_timing 精确评估，超驻留(qtime 不可行)同样按截断罚。

奖励（越小 gap 越高奖）：
  · 可行完成： r = -clip(gap, -0.5, 1.0)                  gap=(mk-mk_milp)/mk_milp，∈[-1.0, +0.5]
  · 死锁/不可行： r = -1.5 - (1 - progress)               progress=已放片/总片，∈[-2.5, -1.5]
  失败奖上界(-1.5) < 完成奖下界(-1.0) ⇒ 任何完成都严格优于任何截断；progress 给「多放几片」的梯度。

self-critical 基线：同实例 greedy(argmax, banker-free) 的奖励 b 作基线，优势 A=r_sample-b。
好处：greedy 已近最优的实例（多为 1job）优势≤0 ⇒ 只压低比 greedy 差的采样、把概率拉回 greedy
动作 ⇒ 保持不回归；greedy 会死锁的硬 2job 则被 progress/完成奖拉着学出可行且更短的序。

用法（须带 torch 的 venv）：
  C:/Users/khand/Desktop/CT/venv/Scripts/python.exe scripts/train_rl.py \
      --init results/models/bc_policy.pt --out results/models/bc_policy_rl.pt \
      --subsets train/2job train/1stage train/2stage train/3stage \
      --epochs 40 --samples 6 --batch 8 --lr 1e-4 --temp 1.0
"""

import argparse
import glob
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import load_alg_entries, parse_task
from src.paths import input_data_path, MODELS_DIR
from src.marathon_gen import expand_topo_pms, PM_POOL_6
from src.model import Durations
from src.features import step_features
from src.policy import CandidateScorer, Policy
from src.timing import start_schedule_by_policy
from src.timing._common import _DecodeDeadlock
from src.timing.sequencing import decode_orders_choosing
from src.timing.solve import solve_timing

BASE_TOPO = "s1-1c1p-preclean"
_ROOT = Path(__file__).resolve().parents[1]
_DATASET = _ROOT / "dataset"

GAP_CLIP_LO, GAP_CLIP_HI = -0.5, 1.0    # 完成奖 = -clip(gap, lo, hi) ∈ [-hi, -lo]
FAIL_BASE = -1.5                         # 失败(截断)奖基 + progress 项 ∈ [FAIL_BASE-1, FAIL_BASE]


# --------------------------------------------------------------------------- #
# rollout：banker-free 解码，chooser 抽/贪 动作并记录 (step_feats, chosen_idx)
# --------------------------------------------------------------------------- #
class _RLChooser:
    """记录每步候选特征与所选局部 idx；sample=True 按 softmax(分/temp) 抽，False 取 argmax。
    banker=False 下 decode 直接提交 order[0]，故把所选 idx 放首位即为提交动作（记录=动作，1:1）。"""

    def __init__(self, model, mean, std, rng, temp, sample):
        self.model, self.mean, self.std = model, mean, std
        self.rng, self.temp, self.sample = rng, temp, sample
        self.traj = []      # [(feats[n_cand,F] float32, chosen_idx)]

    def __call__(self, state, cands):
        feats = step_features(state, cands).astype(np.float32)   # 原始特征 [n_cand, F]
        x = (feats - self.mean) / self.std
        with torch.no_grad():
            logits = self.model.net(torch.from_numpy(x)).squeeze(-1).numpy()
        if self.sample:
            z = logits / self.temp
            z -= z.max()
            p = np.exp(z); p /= p.sum()
            idx = int(self.rng.choice(len(cands), p=p))
        else:
            idx = int(np.argmax(logits))
        self.traj.append((feats, idx))
        order = [idx] + [i for i in range(len(cands)) if i != idx]
        return order


def _rollout(model, mean, std, ir, tm, mk_milp, *, rng, temp, sample):
    """一次 banker-free rollout → (traj, reward, feasible, makespan)。
    死锁 → 截断，reward 按 progress 罚；完成再 solve_timing，不可行(超驻留)同样按截断罚。"""
    ch = _RLChooser(model, mean, std, rng, temp, sample)
    total = sum(len(w.stages) - 1 for w in ir.wafers)
    try:
        wf, orders = decode_orders_choosing(ir, tm, ir.wafers, chooser=ch,
                                            reserve=False, banker=False)
    except _DecodeDeadlock:
        progress = len(ch.traj) / max(total, 1)
        return ch.traj, FAIL_BASE - (1.0 - progress), False, float("nan")
    r = solve_timing(ir, wf, orders=orders)
    if not getattr(r, "feasible", False):
        progress = len(ch.traj) / max(total, 1)          # 放满但超驻留 ⇒ progress≈1、罚≈FAIL_BASE
        return ch.traj, FAIL_BASE - (1.0 - progress), False, float("nan")
    gap = (r.makespan - mk_milp) / mk_milp
    reward = -float(np.clip(gap, GAP_CLIP_LO, GAP_CLIP_HI))
    return ch.traj, reward, True, r.makespan


# --------------------------------------------------------------------------- #
# 数据集加载
# --------------------------------------------------------------------------- #
def _load_instances(ai, subsets, limit):
    insts = []
    for sub in subsets:
        files = sorted(glob.glob(str(_DATASET / sub / "inst_*.json")))
        if limit > 0:
            files = files[:limit]
        for f in files:
            d = json.load(open(f, encoding="utf-8"))
            res = d.get("result", {})
            mk = res.get("makespan")
            if not (isinstance(mk, (int, float)) and mk == mk and res.get("schedule")):
                continue
            try:
                ir = parse_task(ai, d["update_params"])
            except Exception:                            # noqa: BLE001
                continue
            insts.append((os.path.basename(f)[:-5], ir, Durations(ir), float(mk)))
    return insts


# --------------------------------------------------------------------------- #
# 训练
# --------------------------------------------------------------------------- #
def _traj_logprob(model, mean_t, std_t, traj, temp):
    """重算一条轨迹的 sum_t log softmax(分/temp)[chosen]（带梯度）。逐步小前向即可（候选数很小）。"""
    lp = torch.zeros((), dtype=torch.float32)
    for feats, idx in traj:
        x = (torch.from_numpy(feats) - mean_t) / std_t
        logits = model.net(x).squeeze(-1) / temp
        lp = lp + torch.log_softmax(logits, dim=0)[idx]
    return lp


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", type=str, default=str(MODELS_DIR / "bc_policy.pt"))
    ap.add_argument("--out", type=str, default=str(MODELS_DIR / "bc_policy_rl.pt"))
    ap.add_argument("--subsets", nargs="+",
                    default=["train/2job", "train/1stage", "train/2stage", "train/3stage"])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--samples", type=int, default=6, help="每实例采样轨迹数(self-critical 的探索序)")
    ap.add_argument("--batch", type=int, default=8, help="每次更新的实例数")
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--temp", type=float, default=0.5, help="采样温度(baseline greedy 不受影响)")
    ap.add_argument("--eval-every", type=int, default=5, help="每几个 epoch 做一次部署口径评估选 checkpoint")
    ap.add_argument("--eval-samples", type=int, default=16, help="部署口径评估的 n_samples")
    ap.add_argument("--bc-anchor", type=float, default=0.0,
                    help="行为锚定系数 β：每次更新叠加 β·CE(专家标签)，防 RL 遗忘 BC 已学好的决策(抗回归)")
    ap.add_argument("--bc-labels", type=str,
                    default=str(_ROOT / "dataset" / "train_artifacts" / "bc_labels.npz"))
    ap.add_argument("--bc-batch", type=int, default=512, help="每次更新的 BC 锚定 step 数")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)

    ai, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai = expand_topo_pms(ai, PM_POOL_6)
    insts = _load_instances(ai, args.subsets, args.limit)
    print(f"实例 {len(insts)} 个（{args.subsets}）")

    ckpt = torch.load(args.init, map_location="cpu", weights_only=False)
    F = int(ckpt["feat_dim"]); H = int(ckpt["hidden"])
    model = CandidateScorer(F, H)
    model.load_state_dict(ckpt["state"])
    mean = np.asarray(ckpt["mean"], dtype=np.float32)
    std = np.asarray(ckpt["std"], dtype=np.float32)
    mean_t = torch.from_numpy(mean); std_t = torch.from_numpy(std)

    opt = torch.optim.Adam(model.parameters(), lr=args.lr)

    # 行为锚定：读专家标签(标准化后)，每次更新叠加 β·CE，把策略拉回 BC 已学好的决策，抗 RL 遗忘。
    anc = None
    if args.bc_anchor > 0:
        z = np.load(args.bc_labels)
        af = (z["feats"].astype(np.float32) - mean) / std      # 与推理同口径标准化
        af = af * (z["mask"].astype(np.float32)[:, :, None])   # padding 行保持 0
        anc = (torch.from_numpy(af), torch.from_numpy(z["mask"].astype(np.float32)),
               torch.from_numpy(z["expert"].astype(np.int64)))
        print(f"[anchor] β={args.bc_anchor} 专家标签 {anc[0].shape[0]} steps")
    ce = torch.nn.CrossEntropyLoss()

    def eval_greedy():
        """每 epoch 廉价监控：banker-free greedy 的 (可行率, 可行例平均 gap%)。策略是否自足可行。"""
        model.eval()
        feas = 0; gaps = []
        for _, ir, tm, mk in insts:
            _, _, ok, m = _rollout(model, mean, std, ir, tm, mk,
                                   rng=rng, temp=args.temp, sample=False)
            if ok:
                feas += 1; gaps.append((m - mk) / mk * 100.0)
        g = (sum(gaps) / len(gaps)) if gaps else float("nan")
        return feas, len(insts), g

    def eval_deploy():
        """部署口径(纯 BC，无启发式地板)：start_schedule_by_policy(fallback=False) 的可行率 + gap均。
        用它选 checkpoint——直接对齐真正部署的 banker+采样解码，而非训练用的 banker-free 代理。"""
        model.eval()
        pol = Policy(model, mean, std)
        feas = 0; gaps = []
        for _, ir, _tm, mk in insts:
            r = start_schedule_by_policy(ir, pol, n_samples=args.eval_samples,
                                         fallback=False, seed=args.seed)
            if r is not None and getattr(r, "feasible", False) and r.makespan == r.makespan:
                feas += 1; gaps.append((r.makespan - mk) / mk * 100.0)
        g = (sum(gaps) / len(gaps)) if gaps else float("nan")
        return feas, len(insts), g

    gf, gn, gg = eval_greedy()
    df, dn, dg = eval_deploy()
    print(f"[init] banker-free greedy 可行 {gf}/{gn} gap均 {gg:+.2f}%  | "
          f"部署(纯BC,{args.eval_samples}采样) 可行 {df}/{dn} gap均 {dg:+.2f}%")
    _save(model, ckpt, args.out)                     # 先存 init 作 best 基准
    best_metric = (df, -dg if dg == dg else -1e9)

    order = list(range(len(insts)))
    for ep in range(1, args.epochs + 1):
        model.train()
        rng.shuffle(order)
        ep_reward = []; ep_adv = []
        for b in range(0, len(order), args.batch):
            batch = [insts[i] for i in order[b:b + args.batch]]
            loss = torch.zeros((), dtype=torch.float32)
            n_terms = 0
            for _, ir, tm, mk in batch:
                # self-critical 基线：greedy(argmax) rollout 奖励
                _, b_reward, _, _ = _rollout(model, mean, std, ir, tm, mk,
                                             rng=rng, temp=args.temp, sample=False)
                for _s in range(args.samples):
                    traj, r, _ok, _m = _rollout(model, mean, std, ir, tm, mk,
                                                rng=rng, temp=args.temp, sample=True)
                    adv = r - b_reward
                    ep_reward.append(r); ep_adv.append(adv)
                    if not traj or abs(adv) < 1e-9:
                        continue
                    lp = _traj_logprob(model, mean_t, std_t, traj, args.temp)
                    loss = loss - adv * lp
                    n_terms += 1
            if n_terms > 0:
                loss = loss / n_terms
            if anc is not None:                          # 行为锚定 CE（抗遗忘）
                af, am, ae = anc
                bi = torch.from_numpy(rng.choice(af.shape[0], size=min(args.bc_batch, af.shape[0]),
                                                 replace=False))
                loss = loss + args.bc_anchor * ce(model(af[bi], am[bi]), ae[bi])
            if n_terms == 0 and anc is None:
                continue
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()

        gf, gn, gg = eval_greedy()                   # 廉价监控
        tag = ""
        if ep % args.eval_every == 0 or ep == args.epochs:
            df, dn, dg = eval_deploy()               # 部署口径选 checkpoint
            metric = (df, -dg if dg == dg else -1e9)
            if metric > best_metric:
                best_metric = metric
                _save(model, ckpt, args.out)
                tag = "  ← saved(best)"
            print(f"ep {ep:>3}: rewardμ {np.mean(ep_reward):+.3f} advμ {np.mean(ep_adv):+.3f}  "
                  f"bf-greedy {gf}/{gn} {gg:+.2f}%  部署 {df}/{dn} {dg:+.2f}%{tag}")
        else:
            print(f"ep {ep:>3}: rewardμ {np.mean(ep_reward):+.3f} advμ {np.mean(ep_adv):+.3f}  "
                  f"bf-greedy {gf}/{gn} {gg:+.2f}%")

    print(f"best 部署: 可行 {best_metric[0]}/{len(insts)}  gap均 {-best_metric[1]:+.2f}%  → {args.out}")


def _save(model, ckpt, out):
    torch.save({"state": {k: v.clone() for k, v in model.state_dict().items()},
                "feat_dim": ckpt["feat_dim"], "hidden": ckpt["hidden"],
                "mean": ckpt["mean"], "std": ckpt["std"]}, out)
    return out


if __name__ == "__main__":
    main()
