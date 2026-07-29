/**
 * Node 回归测试入口。
 *
 * 浏览器生产入口只构建 ``config_editor.ts``，不会载入旧的客户端分析实现。
 * 为了让现有回放测试继续覆盖稳定的纯函数，本入口在 Node 测试构建中额外导出
 * 兼容分析函数；新的业务代码必须使用服务端 `/api/analysis/*` 契约。
 */

export { buildWorkspaceSnapshot, createVisualizationWorkspace, normalizeMovePayload } from "./workspace_visualizer";
export {
  analyzeSchedulePerformance,
  displayedPerformanceResources,
  summarizeBottleneckUtilization,
} from "../../analysis/movelist_performance";
export { buildScheduleAnalysisContext } from "../../analysis/schedule_context";
