/**
 * 使用文档独立页面入口。
 *
 * 页面只负责初始化 Markdown 文档视图；文档数据仍由本地服务的
 * `/api/documentation` 接口提供，避免复制或缓存用户的本地文档内容。
 */

import { createDocumentationView } from "./documentation_view";

const documentationRoot = document.getElementById("documentationRoot");

if (!documentationRoot) {
  throw new Error("使用文档页面缺少 documentationRoot 容器");
}

void createDocumentationView(documentationRoot).load();
