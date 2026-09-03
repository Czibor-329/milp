/**
 * Node 回归测试入口。
 *
 * 浏览器生产入口只构建 ``config_editor.ts``。本入口仅导出回放和渲染测试需要的
 * 前端视图函数；MoveList 指标与测试组统计必须由服务端 `/api/analysis/*` 提供。
 */

export {
  alignOriginalDecisionTraceToMoves,
  buildWorkspaceSnapshot,
  createVisualizationWorkspace,
  decisionAtTime,
  decisionBoundaryTimes,
  decisionSpaceSignature,
  detectTerminalPlaybackDeadlock,
  detectDeviceTopologyLayout,
  detectTopologyLayout,
  groupedBottleneckResources,
  normalizeDecisionTrace,
  normalizeMovePayload,
  primitiveDecisionBoundaryTimes,
  renderEquipmentTopology,
  renderSchedulePerformance,
  renderThroughputChart,
  renderWaferResidenceChart,
  snapshotWithFullDeviceModules,
} from "./workspace_visualizer";
