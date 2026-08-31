# Windows 部署指南

本指南把 CT 调度平台部署到一台常开的 Windows 电脑上，供本机、局域网或
受保护的内网穿透环境访问。

> 平台不提供用户登录或权限管理。默认只监听 `127.0.0.1`；如果需要跨机器
> 访问，请在 VPN、反向代理或内网穿透层配置身份认证和访问控制，不要直接把
> 未受保护的端口暴露到公网。

## 一、前置条件

- Windows 10/11
- Python 3.10 或更高版本
- 完整项目目录及算法依赖

## 二、启动服务

在项目目录打开 PowerShell：

```powershell
python -m realtime_scheduler.backend.main --open
```

默认地址为 `http://127.0.0.1:8765/`，打开后可直接使用。

首次启动会自动迁移旧版工作区数据（如有）并预热算法缓存。

## 三、局域网访问

如需让同一局域网中的其他电脑访问，可监听所有网卡：

```powershell
python -m realtime_scheduler.backend.main --host 0.0.0.0 --port 8765
```

其他电脑通过 `http://部署电脑的IP:8765` 访问。此模式没有应用层登录保护，
仅应在可信网络中使用。

如 Windows 防火墙拦截连接，可放行端口：

```powershell
netsh advfirewall firewall add rule name="CTScheduler-8765" dir=in action=allow protocol=TCP localport=8765
```

删除规则：

```powershell
netsh advfirewall firewall delete rule name="CTScheduler-8765"
```

## 四、开机自启

下面的任务会在开机后启动服务：

```powershell
schtasks /Create /TN "CTScheduler" /TR "cmd /c cd /d D:\milp && python -m realtime_scheduler.backend.main --host 0.0.0.0 --port 8765 > D:\milp\server.log 2>&1" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
```

把 `D:\milp` 替换为实际项目路径。验证与删除命令：

```powershell
schtasks /Query /TN "CTScheduler"
schtasks /Delete /TN "CTScheduler" /F
```

## 五、内网穿透

cpolar 等工具可把 `127.0.0.1:8765` 映射为外部地址。创建 HTTP 隧道时填写：

| 表单项 | 填写内容 |
|---|---|
| 本地地址 | `127.0.0.1` |
| 本地端口 | `8765` |
| 协议 | `http` |

在开放外部访问前，务必使用内网穿透服务自身的认证能力，或在前面增加带认证的
反向代理。调度服务和隧道客户端都必须保持运行。

## 六、常见问题

| 现象 | 处理 |
|---|---|
| 页面显示“本地服务未连接” | 确认服务进程仍在运行，并访问 `http://127.0.0.1:8765/api/health` |
| 打开网址一直转圈 | 检查服务日志、端口、防火墙和隧道状态 |
| 端口被占用 | 改用 `--port 8766`，并同步修改访问地址或隧道配置 |
| 服务未随开机启动 | 用 `schtasks /Query /TN "CTScheduler"` 检查任务，并手动验证启动命令 |
