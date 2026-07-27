# 调度结果分析库

本目录是与页面无关的可复用分析层。它只接收普通对象并返回结构化结果，不读取
DOM、不发起网络请求，也不持有前端状态。

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

MoveList 的物理与状态合法性校验仍以算法仓库
`alg/src/validation/__init__.py` 导出的 `validate_move_list` 为唯一实现。服务端和
其他 Python 使用方应直接复用该入口，不在页面中复制校验规则。

## 指标边界

- 占用率按同一资源在统计窗口内所有活动区间的时间并集计算，重叠动作只计一次。
- 稳态窗口优先采用“首片完工至末片投料”的交叠区间；样本不足时明确标为
  “中段近似”，不会冒充严格稳态。
- 瓶颈是基于平均 Active Period、再以利用率打破平局的“瓶颈候选”，不是完整的
  SEMI E10 OEE 或逐时刻 shifting bottleneck 判定。
- 组级结果同时给出加权总体改善、逐例中位改善和胜/平/退化数，不把不同量纲
  压成一个综合分数。

