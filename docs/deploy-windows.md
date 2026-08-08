# Windows 部署指南：让用户通过公网网址访问调度平台

本指南把 CT 调度平台部署到一台常开的 Windows 电脑上，并通过
**内网穿透（cpolar）** 生成一个公网网址，让调度员在任意地点用
浏览器登录后即可进行调度。

## 总体架构

```
用户浏览器 ──访问──> https://xxxx.cpolar.cn ──cpolar 隧道──> Windows 电脑:8765 ──> 调度系统(server.py + 算法)
```

需要在这台 Windows 电脑上安装两样东西：

1. **调度服务**（本仓库，Python 3.10+，零第三方依赖）
2. **cpolar 客户端**（内网穿透工具，免费）

## 一、前置条件

- Windows 10/11 电脑，**尽量不关机**（计划任务可开机自启）
- 已安装 Python 3.10 或更高版本（安装时勾选 **Add python.exe to PATH**）
- 项目完整拷贝：`milp/` 整个目录（含 `alg/` 算法目录与 `data/` 数据）
- 算法依赖已按算法仓库说明安装好

> 首次部署数据与算法的准备步骤见仓库根目录 `README.md` 的「首次部署」。

## 二、首次启动与账号初始化

在项目目录打开命令行（PowerShell），执行：

```powershell
python realtime_scheduler\server.py
```

首次启动会自动完成：

- 把旧的单文件工作区数据迁移为拆分目录（如有）
- **创建默认管理员账号 `admin`，初始密码 `admin123`**（控制台会提示）

启动成功后浏览器打开 `http://127.0.0.1:8765/` 会跳转到登录页，
用 `admin / admin123` 登录。

> ⚠️ 正式上线前**必须修改默认密码**（见下节账号管理）。

## 三、账号管理（用户名 + 密码）

账号保存在 `realtime_scheduler\data\users.json`，密码为加盐哈希，
**不会保存明文**。所有命令都在项目目录下执行：

```powershell
# 新建账号（交互式输入密码，至少 8 位）
python realtime_scheduler\server.py --add-user 张三

# 重置某账号密码
python realtime_scheduler\server.py --add-user 张三

# 删除账号
python realtime_scheduler\server.py --remove-user 张三

# 查看全部账号
python realtime_scheduler\server.py --list-users
```

**修改默认密码**：用 `--add-user admin` 重新设置密码即可。

建议为每个调度员建独立账号，方便日后追溯；删除默认的 admin 或
改掉它的密码，避免共享账号。

## 四、让服务对外监听

调度服务默认只监听本机（127.0.0.1）。cpolar 可以直接映射本机端口，
所以这一步**可以不做**；但为了日后排查方便，推荐显式监听所有网卡：

```powershell
python realtime_scheduler\server.py --host 0.0.0.0 --port 8765
```

此时同网段的其他电脑也能通过 `http://这台电脑的IP:8765` 访问。

## 五、开机自启（任务计划程序）

让电脑重启后服务自动运行，无需人工登录启动：

```powershell
schtasks /Create /TN "CTScheduler" /TR "cmd /c cd /d D:\milp && python realtime_scheduler\server.py --host 0.0.0.0 --port 8765 > D:\milp\server.log 2>&1" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
```

- 把 `D:\milp` 换成你的实际项目路径
- 验证：`schtasks /Query /TN "CTScheduler"`；删除：`schtasks /Delete /TN "CTScheduler" /F`

> 若用 `--host 0.0.0.0`，Windows 防火墙会弹出"允许访问"提示，
> 必须点**允许**（专用网络即可），否则外部访问不通。

## 六、防火墙放行端口（可选）

如果监听的是 `0.0.0.0`，需要放行 8765 端口：

```powershell
netsh advfirewall firewall add rule name="CTScheduler-8765" dir=in action=allow protocol=TCP localport=8765
```

删除规则：`netsh advfirewall firewall delete rule name="CTScheduler-8765"`

> 使用 cpolar 内网穿透时，请求从本机发出，不经过防火墙入站，
> 可以不放行 8765；上面的规则只在"局域网直连"场景需要。

## 七、cpolar 内网穿透，生成公网网址

这一节是纯操作，全程不需要写代码，跟着做即可。整体目标：
在常开的那台 Windows 电脑上装 cpolar，让它把调度服务（8765 端口）变成
一个公网网址。

### 7.1 注册账号

1. 浏览器打开 [cpolar 官网](https://www.cpolar.com)，点右上角「注册」；
2. 用邮箱注册，设置密码；
3. 去邮箱点开 cpolar 发来的**验证链接**（不验证可能无法建隧道）。

### 7.2 下载并安装客户端

1. 官网页面上找到「下载」，选 **Windows 版**，下载安装包（`.exe`）；
2. 双击安装包，一路「下一步」完成安装；
3. 打开 cpolar 程序，用刚才注册的账号登录。

### 7.3 创建隧道

1. 登录后，在 cpolar 主界面左侧菜单找到「**隧道管理**」（部分版本叫
   「隧道列表」），点击「**创建隧道**」；
2. 在弹出的表单里填写 4 项：

   | 表单项 | 填写内容 |
   |---|---|
   | 隧道名称 | `scheduler`（随意，自己能认出来即可） |
   | 协议 | `http` |
   | 本地地址 | `127.0.0.1` |
   | 本地端口 | `8765` |

3. 点击「创建」/「确定」。

### 7.4 拿到公网网址并验证

1. 回到隧道列表，看到名为 scheduler 的隧道状态为「**在线**」；
2. 复制它旁边显示的「**公网地址**」，形如 `https://xxxxxxxx.cpolar.cn`；
3. **在浏览器里打开这个公网网址**：能看到调度系统的**登录页**就说明整条
   链路已通（公网 → cpolar → 你的调度服务）；
4. 把这个网址发给调度员，他们在任意电脑打开 → 登录页 → 登录 → 调度。

> ⚠️ 三个要点：
>
> 1. **两个程序都要保持运行**：调度服务的命令行窗口和 cpolar 客户端都不能
>    关；cpolar 可以最小化到系统托盘。
> 2. **免费版网址会变**：每次重启 cpolar，公网地址都会换新，变了要重新
>    发给用户。想固定网址可购买 cpolar 固定域名套餐（一年几十到一百多元），
>    或在部署机设置 cpolar 开机自启（安装后通常自带开机启动选项），减少
>    网址变化的频率。
> 3. **先启动调度服务再建隧道**：确认 `http://127.0.0.1:8765/` 能打开登录页
>    之后，再去 cpolar 里创建隧道。

## 八、安全建议

- **立即修改默认密码** `admin/admin123`；
- 给每个用户独立账号，不要共用；
- 会话有效期 12 小时，超时需重新登录；
- 如果使用 cpolar 免费版，网址每次变化本身也降低了被扫描的风险；
- 长期对外提供服务，建议升级 cpolar 付费版（支持固定域名 + HTTPS），
  或迁移到云服务器 + 域名 + HTTPS（本仓库代码无需改动）。

## 九、常见问题

| 现象 | 处理 |
|---|---|
| 打开网址一直转圈/无法访问 | 确认服务在跑（`http://127.0.0.1:8765/` 能打开登录页）；确认 cpolar 隧道状态为在线 |
| 登录提示"用户名或密码错误" | 用 `--list-users` 确认账号存在；密码输错或已被重置 |
| 提示"未登录或会话已过期" | 重新登录即可（会话 12 小时过期） |
| 忘记密码 | 在部署机上执行 `python realtime_scheduler\server.py --add-user 用户名` 重置 |
| 端口被占用 | 换端口启动：`--port 8766`，同时把 cpolar 隧道的本地端口改成 8766 |
| 服务没随开机启动 | 用 `schtasks /Query /TN "CTScheduler"` 确认任务存在；手动运行一次验证命令本身可启动 |
