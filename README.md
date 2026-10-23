<div align="center">
  <img src="icon.svg" alt="Our Free Model for Codex" width="110">

# codex-our-free-model

**免费的前沿模型，直接进 Codex。** 不登录、不注册、不填 API Key。

[English](README_EN.md) | **简体中文**

</div>

---

## 这是什么

一个 Codex 插件。装上之后，包括 DeepSeek V4.1 Flash、Kimi K3 在内的免费模型会出现在 **Codex 自己的模型选择器**里，用起来和其它 provider 没有任何区别。

它做两件事：

1. 在本机跑一个网关，说 Codex 唯一接受的 `responses` 线协议。
2. 把网关注册成 Codex 的 `[model_providers.our-free-model]`，并把模型清单喂给 Codex 的选择器。

免费模型来自 [OpenCode 的 Zen 公共免费池](https://opencode.ai)，直连，不经任何第三方中转。

> **移植说明**：本项目是 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的 Codex 版本。原版是 DSH（DeepSeek Harness）插件；这里保留了与宿主无关的免费车道核心，去掉了 DSH 专属的宿主层（设置页、应用内升级、公告推送、EAC/Kilo/LobsterAI 等账号渠道），改成 Codex 能用的形态。

## 快速开始

```bash
# 1. 安装插件
codex plugin marketplace add bob97989/codex-our-free-model
codex plugin add codex-our-free-model@codex-our-free-model

# 2. 启动网关并写入 Codex 配置
#    （插件已装到本地，直接用插件里的 CLI）
node ~/.codex/plugins/cache/codex-our-free-model/codex-our-free-model/1.1.3/bin/cli.mjs setup

# 3. 用免费模型开一个会话
codex -m mimo-v2.6-flash-free -c model_provider=our-free-model
```

> 没装到默认路径？先用 `codex plugin list --json` 看 `installedPath`，
> 再把上面的路径换成它。

`setup` 会：启动网关 → 实测网关可用 → 把 provider 块写进 `~/.codex/config.toml` → 打印可用模型。

**或者克隆仓库直接用**（不装插件也能跑）：

```bash
git clone https://github.com/bob97989/codex-our-free-model
cd codex-our-free-model
node bin/cli.mjs setup
```

## 侧边栏配置面板

插件安装后会在 Codex 左侧边栏提供 **Our Free Model** 入口。首次打开时如果网关
还没运行，可以直接点「启动并配置网关」，无需再回终端执行 `setup`。

面板包含三块主要功能：

- **模型**：按免费池或账号查看模型，单独开关某个模型，也可以整组隐藏。
- **账号**：添加第三方 API Key 提供商，填写 Base URL 和模型清单，测试连接并自动发现模型。
- **设置**：控制推理总开关、地区限制模型、免费池和外部账号模型。

账号密钥保存在本机 `settings.json`（0600），面板只显示末四位。这里管理的是项目
已有的 aggregate provider 能力，也就是 API Key 账号；DSH 原版的 OAuth/云凭证
登录渠道不在这个 Codex 移植版中。

CC Switch 会改写 `model_provider`、`model_catalog_json` 和默认模型。使用本插件时
请关闭 CC Switch；重新运行 `cofm setup` 或从侧栏点「启动并配置网关」会重新把
Codex 切到 Our Free Model。

想让它长期生效，在 `~/.codex/config.toml` 里加两行：

```toml
model_provider = "our-free-model"
model = "mimo-v2.6-flash-free"
```

## 三个命令

| 命令 | 作用 |
| --- | --- |
| `cofm setup [--port N] [--no-config]` | 启动网关 + 写入 config.toml（`--no-config` 只启动不写配置） |
| `cofm run [--port N]` | 只启动网关，不动配置 |
| `cofm doctor` | 端到端体检：配置块、网关设置、网关可达性、模型数量 |
| `cofm uninstall` | 从 config.toml 移除 provider 块（保留数据目录） |

`cofm` 是 `codex-our-free-model` 的简写，两者等价。

## 两种使用方式

**作为模型 provider（主路径）** —— 免费模型出现在 Codex 的模型选择器里，选中后整个会话都用它。行为和任何其它 provider 一致：流式输出、工具调用、用量统计都是真的。

**作为 MCP 工具（辅助路径）** —— 三个工具，不切换会话模型：

| 工具 | 用途 |
| --- | --- |
| `list_free_models` | 当前可用的模型清单 |
| `ask_free_model` | 问某个免费模型一个问题，拿它的回答 |
| `gateway_status` | 网关是否在跑、在哪、服务多少模型 |

`ask_free_model` 适合「要一个第二意见」「顺手查个事实」这类**自包含的单问**。注意它只发送你给的那段 prompt —— 没有文件、没有对话历史、没有工具。需要读代码或改文件的任务，请在会话里换模型做，不要用它。

## 常见故障

两种失败是正常的，都不是插件的问题：

- **`Free usage limit reached`（HTTP 429）** —— 免费池按出口 IP 计配额，用完了。消息里带重试时间。这是共享池的配额，不是配置错误，等窗口重置即可。
- **`RegionError`（HTTP 403）** —— 这个网络出口被地区策略拒绝。换网络或走代理。

排查顺序：先跑 `cofm doctor`，它会指出到底是配置块、网关进程还是上游的问题。**不要手改 `config.toml` 里的 provider 块** —— 它是标记块（`# >>> our-free-model ... >>>`），`cofm setup` 会整块覆盖，手改会被冲掉。

## 工作原理

```
Codex  ──(responses wire)──>  本机网关 (127.0.0.1:随机端口)
                                 │
                                 ├─ /v1/responses          → 免费车道
                                 ├─ /models/catalog        → 给 Codex 选择器的清单
                                 ├─ /v1/chat/completions   → 其它本地工具
                                 └─ /v1/messages           → Anthropic 客户端
```

三个设计决定值得说明：

**为什么必须写 `config.toml`。** Codex 的插件清单（`plugin.json`）描述 skills、MCP server、hooks，但**不描述 model provider**。provider 只能写在 `config.toml` 里，所以必须有个命令去写它 —— 这就是 `cofm setup` 存在的原因。

**为什么用 /models/catalog。** `model_providers` 支持 `model_catalog_url`，Codex 会从那里拉模型元数据。清单每次都从活跃车道重新生成，所以上游加了新模型，你这里的下拉框就会多出来，不需要升级插件。

**为什么清单带鉴权。** 这份清单描述的是你的模型池，和 `/v1/responses` 一样需要网关密钥。Codex 对 provider 的每个请求都会带 bearer token，包括拉清单，所以对它没有额外成本。

## 数据在哪

默认 `~/.codex/our-free-model/`（`settings.json`、`stats.json`、`catalog.json`）。用 `COFM_HOME` 可覆盖，`CODEX_HOME` 会改变默认的父目录。设置文件权限 0600，包含网关密钥；用量统计只在本机，不上传。

## 已知限制

- **只支持 `responses` 线协议。** Codex 的 `WireApi` 只有这一个变体，`chat` 在解析配置时就被拒绝。
- **图片输入未启用。** 清单里声明为 `text` only；免费车道的图片通路存在但未在 Codex 下验证过。
- **配额是共享的。** 免费池按出口 IP 计费，同一个网络下的多台机器共用一个额度。

## 许可

MIT。免费车道的上游行为、可用性与配额由 OpenCode 决定，与本项目无关。

## 致谢

核心免费车道逻辑、指纹与门禁适配来自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT）。
