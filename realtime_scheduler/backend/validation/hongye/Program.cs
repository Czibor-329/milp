// HongYe 增量校验进程入口。
//
// 进程通过 stdin/stdout 使用一行一个 JSON 的协议。事件保存在当前进程内存中，
// 收到 AlgOutput 后用 SchStateLib 对当前事件前缀执行 module-parallel 主校验。

using System;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SchStateLib;

namespace HongYeValidator
{
    internal static class Program
    {
        private const string AdvanceMode = "module-parallel";

        /// <summary>运行逐行 JSON 协议，直到调用方关闭输入或发送 close。</summary>
        private static int Main()
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            var events = new JArray();
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                JObject response;
                try
                {
                    JObject request = JObject.Parse(line);
                    string command = (string)request["command"] ?? string.Empty;
                    if (string.Equals(command, "close", StringComparison.OrdinalIgnoreCase))
                    {
                        return 0;
                    }

                    if (string.Equals(command, "reset", StringComparison.OrdinalIgnoreCase))
                    {
                        events.Clear();
                        response = new JObject();
                        response["ok"] = true;
                    }
                    else if (string.Equals(command, "event", StringComparison.OrdinalIgnoreCase))
                    {
                        response = AddEvent(events, request["event"] as JObject);
                    }
                    else
                    {
                        throw new InvalidOperationException("不支持的 command=" + command);
                    }
                }
                catch (Exception error)
                {
                    response = new JObject();
                    response["ok"] = false;
                    response["error"] = error.GetType().Name + ": " + error.Message;
                }

                Console.WriteLine(response.ToString(Formatting.None));
            }

            return 0;
        }

        /// <summary>追加一条事件；AlgOutput 到达时校验当前完整事件前缀。</summary>
        private static JObject AddEvent(JArray events, JObject entry)
        {
            if (entry == null)
            {
                throw new InvalidOperationException("event 必须是 JSON 对象");
            }

            events.Add(entry.DeepClone());
            string describe = ((string)entry["Describe"] ?? string.Empty).Trim();
            if (!string.Equals(describe, "AlgOutput", StringComparison.OrdinalIgnoreCase))
            {
                var accepted = new JObject();
                accepted["ok"] = true;
                accepted["validated"] = false;
                return accepted;
            }

            LogDrivenReplay.Result replay = LogDrivenReplay.Run(events, true, AdvanceMode);
            JObject planCheck = replay.PlanChecks
                .LastOrDefault(item =>
                    string.Equals((string)item["source"], "AlgOutput.FullMoveList", StringComparison.OrdinalIgnoreCase)
                    && string.Equals((string)item["advance"], AdvanceMode, StringComparison.OrdinalIgnoreCase));
            if (planCheck == null)
            {
                throw new InvalidOperationException("AlgOutput 未产生 module-parallel 校验结果");
            }

            int errors = (int?)planCheck["errors"] ?? 0;
            var validation = new JObject();
            validation["success"] = errors == 0;
            validation["errors"] = errors;
            validation["warnings"] = (int?)planCheck["warnings"] ?? 0;
            validation["durationMismatches"] = (int?)planCheck["duration_mismatches"] ?? 0;
            validation["issues"] = CloneOrEmpty(planCheck["issues"]);
            validation["warningIssues"] = CloneOrEmpty(planCheck["warning_issues"]);
            validation["durationIssues"] = CloneOrEmpty(planCheck["duration_issues"]);
            validation["advance"] = AdvanceMode;

            var response = new JObject();
            response["ok"] = true;
            response["validated"] = true;
            response["validation"] = validation;
            return response;
        }

        /// <summary>复制结果数组；旧包缺少字段时返回空数组。</summary>
        private static JToken CloneOrEmpty(JToken token)
        {
            return token == null ? new JArray() : token.DeepClone();
        }
    }
}
