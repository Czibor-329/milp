/**
 * 调度终端的 JSON API 客户端。
 *
 * 统一处理 HTTP 状态和后端 error 字段，让页面交互只处理业务结果。
 */

/** 请求 JSON 接口，并把失败响应转换为带业务消息的异常。 */
export async function requestJson(
  url: string,
  options: RequestInit = {},
): Promise<Record<string, any>> {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `服务返回 ${response.status}`);
  }
  return result;
}
