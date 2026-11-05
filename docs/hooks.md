# 启动 Hook 与安装选择

0.3.1 增加可选的 `SessionStart` 与 `SubagentStart` Hook。只注入本地共享记忆规则，Agent 按当前任务确定分区并按需使用 MCP；脚本不联网、不读取凭据、不抓取历史、不保存事实。策略正文复用 `skills/shared-memory/SKILL.md`。

## 事件

- `SessionStart` 仅匹配 `^(startup|clear|compact)$`：新会话、清空与上下文压缩后注入。脚本也检查事件来源，拒绝 `resume`、`fork` 和未知来源，避免恢复时重复注入整份规则。
- `SubagentStart` 对宿主支持的子 Agent 注入相同规则，不要求父会话曾写状态文件；子任务按自身范围选择记忆。
- 不配置 `UserPromptSubmit`、结束事件或每轮提醒。没有模式文件或后台任务。
- JSON 输出使用 `hookSpecificOutput.hookEventName/additionalContext`。stdin 最多 64 KiB、等待最多 1 秒；配置总超时 3 秒。输入无效或规则不可读时静默退出，不阻塞任务。

## 安装 Agent 的选择流程

1. 识别当前客户端、CLI/IDE 形态、版本、操作系统和实际配置目录，检查宿主能否运行 Node，以及是否支持上述事件与 JSON 上下文输出。HTTP MCP 本身不要求客户端安装 Node/npm。
2. 支持原生插件携带 Hook，且宿主可执行 `node` 时，优先生成并安装原生 Agent 插件；插件自带 Skill 和两个 Hook，MCP 地址与 Token 继续在客户端私密配置中单独设置。
3. 已采用全局规则安装器或没有可用插件入口时，使用独立安装方式。Codex 的 `auto` 会探测本机 CLI 是否公开 Hook 信任能力；CodeBuddy 由 Agent 对照实际版本和官方文档核实后显式选择 `on`。只有配置目录存在不代表支持 Hook。
4. 不支持、运行时不可用或能力不明确时，仅安装 MCP＋Skill，不安装猜测的配置。不自动下载 Node 或修改宿主信任记录。
5. 独立安装与原生插件二选一，避免叠加重复 Hook。安装文件成功、宿主已信任与实际事件已触发分别报告，不混为已启用。

## 独立安装

```sh
# 默认：Codex，探测能力后选择是否添加 Hook
node scripts/install-memory-policy.mjs
# 已确认宿主能力，可显式开关；兼容原有 --codex-home 参数
node scripts/install-memory-policy.mjs --client codex --hooks on
node scripts/install-memory-policy.mjs --client codex --hooks off
# CodeBuddy：仅在核实所用版本支持后执行
node scripts/install-memory-policy.mjs --client codebuddy --hooks on
# 未知客户端：只安装规则和 Skill 到明确目录
node scripts/install-memory-policy.mjs --client generic --home /path/to/config
```

`--home` 指定目标配置目录；默认 Codex 取 `CODEX_HOME` 或 `~/.codex`，CodeBuddy 取 `CODEBUDDY_CONFIG_DIR` 或 `~/.codebuddy`。当前进程有 CodeBuddy 专属环境变量时默认选择 CodeBuddy，否则保留 Codex 默认入口；安装 Agent 必须核对实际客户端，必要时显式传参。

Codex 合并 `hooks.json`，CodeBuddy 合并 `settings.json`，保留其他设置和 Hook。脚本复制到 `hooks/uni-memory-context.cjs`，命令使用当前 Node 的绝对路径；Node 移动后重新安装以更新命令。`off` 移除本项目处理器，保留规则、Skill 和其他 Hook。配置变化前保留原文件备份；配置无效或同名文件归属不明时拒绝修改。CodeBuddy 的个人指令入口须按实际客户端确认，安装器提供的 `AGENTS.md` 不能替代宿主支持性验证。

Codex 须按官方要求在 `/hooks` 或桌面 Settings > Hooks 审阅并信任定义。安装器不绕过信任，也不替用户写信任记录。其他客户端遵循各自机制。

## 原生插件打包

```sh
node scripts/build-agent-plugin.mjs --output /new/path/uni-memory-agent
```

输出 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`skills/shared-memory/` 和 `hooks/`；拒绝覆盖已有目录。按宿主的本地插件或市场流程安装此目录。Hook 用宿主提供的 `PLUGIN_ROOT`、`CODEBUDDY_PLUGIN_ROOT` 或 `CLAUDE_PLUGIN_ROOT` 定位文件。与仅供 ChatGPT OAuth 的 `scripts/build-chatgpt-plugin.mjs` 分开；不向 ChatGPT 包加入本地命令 Hook。

当前已验证脚本、独立安装与原生插件生成产物；CodeBuddy/OpenClaw 实际账号事件和技能加载仍待验收。不承诺所有客户端继承相同的父／子 Agent 上下文或支持相同事件。

## 官方依据

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)：事件、配置合并、插件声明、上下文输出与信任流程。
- [CodeBuddy Hooks](https://www.codebuddy.cn/docs/cli/hooks)：全局 settings、SessionStart/SubagentStart 和事件输出。版本能力以实际安装为准。

恢复事件的上下文插入位置与缓存效果由宿主决定；本项目直接排除 resume，不假设追加或前插。
