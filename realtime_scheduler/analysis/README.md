# 调度结果分析兼容测试库

生产分析层已经迁移到 `realtime_scheduler/backend/analysis.py`。本目录只保留旧
Node 回归测试所需的纯函数兼容实现，不被浏览器生产入口导入，也不应在此新增业务
指标。新的分析规则必须先实现于后端，再通过 `/api/analysis/*` 提供给页面。

## 公共入口

- `movelist_performance.ts`
  - `normalizeMovePayload`：解析 MoveList 数组或带 `MoveList` 字段的结果对象。
  - `analyzeSchedulePerformance`：计算统计窗口、物理资源占用并集、Active Period、
    吞吐、出站间隔波动、加工腔晶圆驻留、机器手非运输驻留、晶圆系统停留和
    真空端队列。
  - `summarizeBottleneckUtilization`：生成结果预览所需的瓶颈摘要。
- `group_performance.ts`
  - `analyzeTestGroupPerformance`：计算逐测试基线对比、胜/平/退化、CPU Time
    分位数、瓶颈频次、吞吐与出站波动等组级统计。

MoveList 的平台侧物理与状态合法性校验以
`realtime_scheduler/move_validation.py` 导出的 `validate_move_list` 为统一实现。
服务端和其他 Python 使用方应直接复用该入口，不在页面中复制校验规则；失败文本
使用稳定的 `MVL-*` 错误码，并保留 MoveID/MoveType 供甘特图定位。

## 指标边界

- 占用率按同一资源在统计窗口内所有活动区间的时间并集计算，重叠动作只计一次。
- 稳态窗口优先采用“首片完工至末片投料”的交叠区间；样本不足时明确标为
  “中段近似”，不会冒充严格稳态。
- 瓶颈是基于平均 Active Period、再以利用率打破平局的“瓶颈候选”，不是完整的
  SEMI E10 OEE 或逐时刻 shifting bottleneck 判定。
- 组级结果同时给出加权总体改善、逐例中位改善和胜/平/退化数，不把不同量纲
  压成一个综合分数。

