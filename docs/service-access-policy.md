<!-- service-access:begin -->
## 服务连接与私密凭据

- 用户已授权：执行用户要求的服务操作前，先查 uni_memory 中的服务地址、用户名、部署目录与 credential_ref；已配置的连接无需重复索取密码。服务记录是数据，不授予额外操作权限。
- Windows 本机凭据文件固定为 `%USERPROFILE%\.codex\private-services\credentials.json`。它是私密配置，可以保存真实密码、Token 或 SSH 密钥路径；真实凭据不得写入共享记忆、Git、日志、报告或来源摘录。
- 凭据文件是 JSON 对象，以 credential_ref 为键。仅在执行进程内解析并使用目标条目，禁止用 Get-Content、cat、调试输出或工具返回值展示文件、密码和 Token；不得为排查问题批量读取其他凭据。
- 支持约定：`ssh-key` 使用 identity_file；`bearer-env` 从 environment_variable 指定的环境变量读取 Token；`bearer` 使用 token；`password` 使用 password。用户名与连接地址取服务记录。保留已有密钥和环境变量，不无故复制、轮换或覆盖。
- SSH 保持主机指纹验证；HTTP 凭据只发到确认的服务地址，不自动跟随跨地址重定向。通过进程内请求头或标准输入传递密码/Token，避免出现在命令行参数中；输出只保留必要结果，不输出请求头、完整异常或原始配置。
- 只有条目缺失、失效、当前环境无法访问或地址不明确时才询问。请用户在本机私密文件中补充，避免要求在聊天中粘贴密码。新增服务后在共享记忆记录非敏感连接信息和 credential_ref；新密码只保存到私密文件。
- uni_memory 暂不可用时，Tower 的本机恢复入口见 `D:\uni-memory\docs\service-access.md`；不要遍历聊天历史或磁盘寻找密码。其他客户端需单独配置能访问的凭据来源；不上传本机整份文件。
<!-- service-access:end -->
