"""差分约束图"""

from typing import Dict, List, Tuple

def _bellman_ford_longest(n: int, edges: List[Tuple[int, int, float]]) -> Tuple[List[float], bool]:
    dist = [0.0] * n          # 初始所有 dist 为零
    # 近 DAG：通常几趟就稳。最多 n 趟；第 n 趟仍能松弛 ⇒ 正环。
    for it in range(n):
        changed = False
        # 每条边 (a, b, w) 表示一条约束 dist[b] ≥ dist[a] + w
        for a, b, w in edges:                 # a→b 权 w：尝试用「a 的时刻 + w」去抬高 b 的时刻下界
            nb = dist[a] + w
            if nb > dist[b] + 1e-9:
                dist[b] = nb
                changed = True
        if not changed:                        # 这一轮没有任何点被抬高 ⇒ 已收敛，是最长路的最终解
            return dist, True
    # 跑满 n 趟还在变 → 正环
    for a, b, w in edges:
        if dist[a] + w > dist[b] + 1e-9:
            return dist, False
    return dist, True


# --------------------------------------------------------------------------- #
# 节点编号：每片每 stage 有 a[j]（放入/到站时刻）与 r[j]（pick 起始，j<K）
# --------------------------------------------------------------------------- #
class _Nodes:
    def __init__(self, wafers):
        self.id: Dict[Tuple[int, str, int], int] = {}      # (wid, 'a'/'r', j) -> 节点编号，供建边时查
        self.label: List[Tuple[int, str, int]] = []        # 节点编号 -> (wid, 'a'/'r', j)，id 的反向表
        for w in wafers:
            K = len(w.stages) - 1
            for j in range(K + 1):
                self._add(w.wid, "a", j)                    # a 节点：0..K，比 r 多一个（终点只到不走）
            for j in range(K):
                self._add(w.wid, "r", j)                    # r 节点：0..K-1
        # 源点哨兵：固定为 0（无入边，Bellman-Ford 恒不被抬高），供清洁 pre 的绝对下界建边用
        self.source = len(self.label)
        self.label.append((-1, "src", 0))

    def _add(self, wid: int, kind: str, j: int) -> None:
        key = (wid, kind, j)
        if key not in self.id:
            # 新节点的编号 = 当前已分配节点数（label 长度），保证编号从 0 开始连续、与 label 下标一一对应
            self.id[key] = len(self.label)
            self.label.append(key)

    def a(self, wid: int, j: int) -> int:
        """晶圆 wid 到达/被放入 stage j 的节点编号。"""
        return self.id[(wid, "a", j)]

    def r(self, wid: int, j: int) -> int:
        """晶圆 wid 在 stage j 被机器手 pick 走（起始离站）的节点编号（j < K）。"""
        return self.id[(wid, "r", j)]

    def __len__(self) -> int:
        return len(self.label)                              # 图的总节点数，供 dist 数组开辟大小用
