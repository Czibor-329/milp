"""差分约束图基础设施：最长路 Bellman-Ford + 节点编号。"""

from __future__ import annotations

from typing import Dict, List, Tuple

from ._common import EPS


# --------------------------------------------------------------------------- #
# Bellman-Ford（最长路版）：dist[b] = max(dist[b], dist[a] + w)
#   feasible 时返回每个节点的最早时刻；存在正环（无法满足的上下界）返回 ok=False。
# --------------------------------------------------------------------------- #
def _bellman_ford_longest(n: int, edges: List[Tuple[int, int, float]]
                          ) -> Tuple[List[float], bool]:
    dist = [0.0] * n          # 所有时刻 ≥ 0（隐含源点 → 各节点权 0）
    # 近 DAG：通常几趟就稳。最多 n 趟；第 n 趟仍能松弛 ⇒ 正环。
    for it in range(n):
        changed = False
        for a, b, w in edges:
            nb = dist[a] + w
            if nb > dist[b] + EPS:
                dist[b] = nb
                changed = True
        if not changed:
            return dist, True
    # 跑满 n 趟还在变 → 正环
    for a, b, w in edges:
        if dist[a] + w > dist[b] + EPS:
            return dist, False
    return dist, True


# --------------------------------------------------------------------------- #
# 节点编号：每片每 stage 有 a[j]（放入/到站时刻）与 r[j]（pick 起始，j<K）
# --------------------------------------------------------------------------- #
class _Nodes:
    def __init__(self, wafers):
        self.id: Dict[Tuple[int, str, int], int] = {}
        self.label: List[Tuple[int, str, int]] = []
        for w in wafers:
            K = len(w.stages) - 1
            for j in range(K + 1):
                self._add(w.wid, "a", j)
            for j in range(K):
                self._add(w.wid, "r", j)

    def _add(self, wid: int, kind: str, j: int) -> None:
        key = (wid, kind, j)
        if key not in self.id:
            self.id[key] = len(self.label)
            self.label.append(key)

    def a(self, wid: int, j: int) -> int:
        return self.id[(wid, "a", j)]

    def r(self, wid: int, j: int) -> int:
        return self.id[(wid, "r", j)]

    def __len__(self) -> int:
        return len(self.label)
