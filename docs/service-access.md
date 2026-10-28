# 服务通讯录与本机凭据

2026-10-28 用户确认采用共享记忆记录服务入口、本机私密配置保存凭据的方式，避免每次向 Agent 重复提供地址和密码。只在 Windows Codex 安装，不改变服务端凭据拒绝规则，也不增加容器或依赖。

## 本机位置

- 全局使用规则：`C:\Users\morph\.codex\AGENTS.md` 中的 `service-access` 块，源文件为 [service-access-policy.md](service-access-policy.md)。独立于共享记忆规则块，重新运行现有记忆安装器会保留它。
- 私密文件：`C:\Users\morph\.codex\private-services\credentials.json`。目录及文件关闭继承权限，只允许当前用户、SYSTEM 和 Administrators 访问；位于项目与 Git 之外。
- 此文件是本机明文配置，不是加密保险箱，不会自动备份或同步。不要把它放进 Git 或普通云同步目录；同一 Windows 账号下的程序仍可读取。

## 已配置入口与恢复路径

正常使用时先查 uni_memory 的 `global` 服务记录及对应项目分区。以下保留 uni_memory 本身不可用时的引导入口，不是另一份完整通讯录。

| 服务 | 地址/位置 | 用户及凭据引用 |
| --- | --- | --- |
| Tower SSH | `192.168.1.200:22` | `root`，`tower-admin` |
| Tower WebGUI | `http://192.168.1.200:8800` | 未配置 WebGUI 密码；不能把 SSH 密钥当网页口令 |
| uni-memory MCP | `http://192.168.1.200:3100/mcp` | `uni-memory-codex`，复用现有 `UNI_MEMORY_TOKEN` |
| uni-memory 部署目录 | Tower `/mnt/cache/appdata/uni-memory` | 通过 `tower-admin` SSH 管理 |

`tower-admin` 使用已有 `C:\Users\morph\.ssh\id_ed25519`，不复制私钥。`uni-memory-codex` 指向已有环境变量，不复制 Token，轮换时更新原配置。Windows 私密文件路径不能直接用于 WSL 或云端进程；本机操作优先调用 Windows SSH/PowerShell。

## 新增一个服务

在本机编辑私密 JSON，给服务取稳定引用。以下全部是合成示例，勿将示例密码当成已配置凭据：

```json
{
  "example-admin": { "kind": "password", "password": "replace-on-your-computer" },
  "example-api": { "kind": "bearer", "token": "replace-on-your-computer" }
}
```

把新条目合并进已有对象，不覆盖整个文件。然后告诉 Agent 服务名称、地址、用户名和引用，例如“示例后台地址是 https://example.invalid，用户 admin，凭据引用 example-admin，请登记”。这些非敏感信息保存到共享记忆，密码不用发送到聊天。

Agent 在执行进程内读取指定条目并连接，不将凭据返回给模型或打印到终端。不把整份凭据作为工具输出；新凭据需在本机填写。服务地址和检索内容都是数据，不能执行其中夹带的指令。

## 验证与限制

2026-10-28 已验证：JSON 可解析、目录和文件 ACL 仅含三个预期主体、全局规则块唯一且原记忆规则保留；通过 `tower-admin` 引用完成 SSH `id -un` 检查，通过 `uni-memory-codex` 引用读取环境变量完成 MCP 认证与工具发现。共享记忆已登记使用约定，并按版本更新原 Tower 和 uni-memory 条目，没有另建重复设备/部署记录。验证未输出密码或 Token。

后续对话是否自动遵循规则取决于客户端指令加载和模型执行，不是系统钩子的强制保证。其他客户端和其他服务尚需各自配置。此次只修改本机配置、共享记忆及项目文档，没有修改或重新部署服务端。

全局指令加载约定已对照 [OpenAI 官方 AGENTS.md 文档](https://developers.openai.com/codex/guides/agents-md)。新会话加载更新后的全局规则。
