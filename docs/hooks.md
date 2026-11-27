# 启动 Hook 与安装选择

0.3.1 起增加可选的启动 Hook。只注入本地共享记忆规则，Agent 按当前任务确定分区并按需使用 MCP；脚本不联网、不读取凭据、不抓取历史、不保存事实。Codex、CodeBuddy 与 Antigravity 各自独立维护，分别只使用对应宿主实际支持的方式。

## 三端差异概览

| 客户端 | 独立安装配置目标 | 支持的启动事件 | Hook 文件格式 | 原生插件打包命令 |
| --- | --- | --- | --- | --- |
| Codex | `hooks.json`（`hooks` 包装） | `SessionStart`、`SubagentStart` | `hooks/hooks.json` + `hooks/uni-memory-context.cjs` | `npm run plugin:build:agent` |
| CodeBuddy | `settings.json`（`hooks` 包装） | `SessionStart`、`SubagentStart` | `hooks/hooks.json` + `hooks/uni-memory-context.cjs` | `npm run plugin:build:agent` |
| Antigravity | `hooks.json`（顶层命名对象） | `SessionStart` | `antigravity/hooks.json` + `antigravity/scripts/uni-memory-context.cjs` | `npm run plugin:build:antigravity` |

## 1. Codex

- **事件与协议**：`SessionStart` 仅匹配 `^(startup|clear|compact)$`，并拒绝 `resume`、`fork` 和未知来源；`SubagentStart` 对子 Agent 注入相同规则。JSON 输出使用 `hookSpecificOutput.hookEventName/additionalContext`。
- **安装**：`node scripts/install-memory-policy.mjs`（默认 `--client codex --hooks auto`，会探测本机 CLI 是否公开 Hook 信任能力；也可显式 `--hooks on|off`）。Windows 使用 PowerShell 调用运算符 `&`。
- **信任与插件**：须在 Codex `/hooks` 或 Settings > Hooks 审阅并信任定义；`npm run plugin:build:agent` 输出 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`skills/shared-memory/` 和 `hooks/`。

## 2. CodeBuddy

- **事件与协议**：与 Codex 共用 `hooks/hooks.json` 和 `hooks/uni-memory-context.cjs`（`SessionStart` + `SubagentStart`，`hookSpecificOutput` 输出）。
- **安装**：由安装 Agent 对照实际版本和官方文档核实后显式启用：`node scripts/install-memory-policy.mjs --client codebuddy --hooks on`（合并到 `settings.json`）。当前进程有 `CODEBUDDY_PLUGIN_ROOT` 或 `CODEBUDDY_CONFIG_DIR` 时默认选择 CodeBuddy。

## 3. Antigravity

- **事件与协议**：仅使用 Antigravity 原生支持的 `SessionStart`（无 `SubagentStart`，无 `matcher` 包装，输入为 camelCase 字段）。输出使用 Antigravity 的 `injectSteps` 格式：

```json
{
  "injectSteps": [
    {
      "systemMessage": {
        "systemMessage": "..."
      }
    }
  ]
}
```

- **文件格式**：`hooks.json` 顶层以命名 Hook 对象为键（`uni-memory-context`），直接包含扁平的 `SessionStart` handler 数组；插件打包时放在插件根目录 `hooks.json`，并使用相对路径 `node ./scripts/uni-memory-context.cjs`（宿主以插件根目录为 `cwd`）。Windows 宿主通过 `cmd /c` 执行命令，不使用 PowerShell `&` 前缀。
- **独立安装**：

```sh
node scripts/install-memory-policy.mjs --client antigravity
# 可选指定目录与 Hook 开关（默认 ~/.gemini/config 或 ANTIGRAVITY_CONFIG_DIR）
node scripts/install-memory-policy.mjs --client antigravity --home /path/to/.gemini/config --hooks on
```

  当在 WSL 下向 Windows `/mnt/<drive>/...` 路径执行 `--hooks auto` 时，自动跳过写入 Linux `node` 路径，仅安装 `AGENTS.md` 与 `skills/shared-memory/SKILL.md`；在宿主原生环境或显式 `--hooks on` 时才写入 `hooks.json`。
- **原生插件打包**：

```sh
npm run plugin:build:antigravity -- --output /new/path/uni-memory-antigravity
# 可选附带 mcp_config.json（默认使用变量 ${UNI_MEMORY_TOKEN}，也可指定 --auth oauth --client-id CLIENT_ID）
npm run plugin:build:antigravity -- --output /new/path/uni-memory-antigravity --mcp-url https://your-server.example.com/mcp
```

  输出包含 `plugin.json`（`$schema: https://antigravity.google/schemas/v1/plugin.json`）、`README.md`、`assets/logo.svg`、`rules/AGENTS.md`、`skills/shared-memory/SKILL.md`，以及可选的 `hooks.json`、`scripts/uni-memory-context.cjs` 和 `mcp_config.json`。独立安装与原生插件二选一，避免叠加重复 Hook。

## 通用安装原则

1. 不支持 Hook、运行时不可用或能力不明确时，仅安装 MCP＋Skill，不安装猜测的配置；不自动下载 Node 或修改宿主信任记录。
2. 独立安装均会在修改 `AGENTS.md`、Hook 配置文件前保留备份；配置结构异常或同名文件归属不明时拒绝修改。
3. 独立安装与原生插件二选一，避免叠加重复 Hook。安装文件成功、宿主已信任与实际事件已触发分别报告，不混为已启用。
4. 与仅供 ChatGPT OAuth 的 `npm run plugin:build`（`scripts/build-chatgpt-plugin.mjs`）分开；不向 ChatGPT 包加入本地命令 Hook。
