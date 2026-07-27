import type { BottleneckCandidate, SchedulePerformance } from "./movelist_performance";

export type DiagnosticConfidence = "strong" | "moderate" | "exploratory";

export interface DiagnosticEvidence {
  label: string;
  value: string;
  interpretation: string;
}

export interface CounterfactualExperiment {
  id: string;
  label: string;
  change: string;
  expectedSignal: string;
}

export interface ScheduleDiagnostic {
  title: string;
  confidence: DiagnosticConfidence;
  finding: string;
  evidence: DiagnosticEvidence[];
  nextExperiment: CounterfactualExperiment;
  limitation: string;
}

function percent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}

function seconds(value: number): string {
  return `${Math.max(0, value).toFixed(2)} s`;
}

function candidateDiagnostic(
  candidate: BottleneckCandidate,
  performance: SchedulePerformance,
): ScheduleDiagnostic {
  const confidence: DiagnosticConfidence = candidate.confidence === "high"
    ? "strong"
    : candidate.confidence === "medium" ? "moderate" : "exploratory";
  if (candidate.kind === "process-group") {
    return {
      title: "优先验证工艺容量是否限制节拍",
      confidence,
      finding: `${candidate.label} 是当前最可能的容量约束；先验证加工时长变化是否会同步改变总体完工时间。`,
      evidence: [
        {
          label: "容量利用率",
          value: percent(candidate.utilization),
          interpretation: "同组并行腔室在统计窗口内的平均忙碌程度。",
        },
        {
          label: "加工后驻留",
          value: seconds(performance.processChamberDwellTime.meanSeconds),
          interpretation: "若同时偏高，说明腔室释放还可能被下游搬运阻塞。",
        },
      ],
      nextExperiment: {
        id: "processing-time-compare",
        label: "对比加工时长变化",
        change: "复制当前测试，小幅调整加工与清洁时长后重新运行并对比。",
        expectedSignal: "若瓶颈判断成立，makespan 会敏感上升，且该资源仍保持主要候选。",
      },
      limitation: "这是由执行轨迹重建的因果假设，不是算法内部候选动作打分。",
    };
  }
  if (candidate.kind === "robot") {
    return {
      title: "优先验证搬运资源是否造成排队",
      confidence,
      finding: `${candidate.label} 的占用与连续忙碌证据最强，可能限制工艺腔及时上下片。`,
      evidence: [
        {
          label: "容量利用率",
          value: percent(candidate.utilization),
          interpretation: "传输动作占据该机器人可服务窗口的比例。",
        },
        {
          label: "手上驻留",
          value: seconds(performance.robotWaferDwellTime.meanSeconds),
          interpretation: "晶圆被取出后等待放置的平均时间，已剔除显式运输区间。",
        },
      ],
      nextExperiment: {
        id: "release-sequence-review",
        label: "对比搬运优先级",
        change: "复制当前测试，仅调整释放或派工优先级后重新运行。",
        expectedSignal: "若搬运次序是主因，机器手驻留和总体完工时间应同步下降。",
      },
      limitation: "当前只能观察已执行动作，无法宣称算法当时没有评估其他可行动作。",
    };
  }
  return {
    title: "优先验证真空交接是否限制流量",
    confidence,
    finding: `${candidate.label} 在抽充气与交接阶段形成较高容量占用，可能放大真空端等待。`,
    evidence: [
      {
        label: "容量利用率",
        value: percent(candidate.utilization),
        interpretation: "LoadLock 组在统计窗口内处理交接工作的平均占用。",
      },
      {
        label: "连续性",
        value: percent(candidate.continuity),
        interpretation: "反映 LoadLock 容量活动是否持续，越高表示空闲断点越少。",
      },
    ],
    nextExperiment: {
      id: "loadlock-policy-compare",
      label: "对比 LoadLock 管理策略",
      change: "保持测试组不变，仅切换 LoadLock 管理器后重新运行。",
      expectedSignal: "若交接策略是主因，真空等待与 makespan 应同时变化。",
    },
    limitation: "LoadLock 占用可能是上游释放或下游加工拥塞的结果，需要配对实验区分。",
  };
}

/** 将轨迹证据转成可证伪的诊断假设和下一步实验。 */
export function diagnoseSchedule(performance: SchedulePerformance): ScheduleDiagnostic[] {
  const diagnostics = performance.bottleneckCandidates
    .slice(0, 2)
    .map(candidate => candidateDiagnostic(candidate, performance));
  if (performance.departureIntervalCv >= 0.25) {
    diagnostics.push({
      title: "出站节拍波动需要单独验证",
      confidence: performance.completedWaferCount >= 8 ? "moderate" : "exploratory",
      finding: `出站间隔 CV 为 ${performance.departureIntervalCv.toFixed(2)}，均值无法代表局部拥塞或饥饿。`,
      evidence: [
        {
          label: "出站间隔 CV",
          value: performance.departureIntervalCv.toFixed(2),
          interpretation: "越高表示相邻晶圆完成间隔越不均匀。",
        },
        {
          label: "完整晶圆样本",
          value: `${performance.completedWaferCount} 片`,
          interpretation: "样本越少，波动判断越应视作探索性线索。",
        },
      ],
      nextExperiment: {
        id: "load-level-compare",
        label: "补齐负载梯度测试",
        change: "复制当前测试，分别降低与提高晶圆规模，再对比节拍 CV 与吞吐。",
        expectedSignal: "若波动来自容量临界点，中高负载用例的 CV 会持续升高。",
      },
      limitation: "CV 只描述波动，不直接说明调度策略或设备容量谁是根因。",
    });
  }
  return diagnostics;
}
