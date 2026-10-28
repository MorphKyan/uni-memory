# Tower 实际部署

部署日期：2026-10-27。Unraid 6.12.11，Intel i7-4790、16 GB RAM。复用已安装的 Compose Manager，不新增管理容器，也不修改现有数据库或其他应用。

## 从界面管理

打开 [Tower WebGUI](http://192.168.1.200:8800/Docker)，Docker 页下方 Compose 区域的 **uni-memory** 即本项目。已开启 AUTO START。可用 Compose Up、Compose Down、Update Stack，以及齿轮菜单编辑 Compose、查看日志。容器也带有 Unraid composeman 管理标记。

插件注册在 `/boot/config/plugins/compose.manager/projects/uni-memory`，通过 indirect 指向 `/mnt/cache/appdata/uni-memory`；Compose 项目 ID 是 `uni_memory`（插件把连字符转为下划线），三个容器为 uni_memory-app-1、uni_memory-postgres-1、uni_memory-qdrant-1。

插件是 Unraid 社区组件，非 Unraid 内置 Compose 功能。本机已安装，采用其现有项目机制。[Unraid 官方容器管理说明](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/)、[Compose Manager 项目说明](https://github.com/mstrhakr/compose_plugin)。

## 文件和网络

项目目录 `/mnt/cache/appdata/uni-memory` 包含源码及锁文件、docker-compose.yml、私密 `.env` 和 `.secrets`、postgres、qdrant、models、备份目录 `.backups/uni-memory`。使用实际 cache 池路径，避免数据库经过用户共享 FUSE；appdata 共享当前配置为 cache only。项目顶层权限 700，配置 600。

部署文件见 [docker-compose.yml](../deploy/unraid/docker-compose.yml)。当前应用镜像 uni-memory:0.2.0（2026-10-28 在 Tower 从本项目构建），数据镜像锁定 PostgreSQL 18.6、Qdrant 1.19.2。Gemma 2 Q4 文本资源已复制到 models，无需重新下载。应用可根据本地源码构建；升级时先备份、同步源码，然后在 Compose Manager 选择 Update Stack 构建新应用，不能把本地应用镜像当成公共仓库自动更新。

应用绑定 `192.168.1.200:3100`，MCP 地址 `http://192.168.1.200:3100/mcp`；数据库无主机端口。用户已选择局域网 HTTP，配置为 `ALLOW_INSECURE_LAN_HTTP=true`、`OAUTH_ENABLED=false`，仍要求每客户端独立 Bearer Token。程序只允许显式启用的私网 IPv4 使用这种模式，不能同时打开 OAuth。HTTP 明文传输，只用于受信任局域网；没有为此端口配置 NPM/EO 公网转发。

接 ChatGPT 时另配 HTTPS 域名、NPM 网络及 OAuth 回调，然后关闭局域网 HTTP 例外并打开 OAuth；这是尚未执行的公网接入步骤。

## 备份

已在 User Scripts 登记 **uni-memory-backup**，每天 03:10 执行 `scripts/backup.sh`；可从 Settings → User Scripts 管理或手动运行。首次备份已成功，保留 14 天，包含数据库、私密配置和签名密钥，旧备份可能保留已删除事实。本机备份不等于异机灾备。

```sh
cd /mnt/cache/appdata/uni-memory
bash scripts/backup.sh
# 覆盖恢复必须明确指定：
bash scripts/restore.sh --replace-current .backups/uni-memory/BACKUP_DIRECTORY
```

本轮没有覆盖恢复 Tower 的生产库；恢复流程此前已在独立测试库通过。

## 验证结果

2026-10-28 已升级到 0.2.0：升级前已运行备份，随后仅重建并替换 app；未重启 PostgreSQL、Qdrant 或整机。迁移保留 28 条原记忆的正文、来源、UUID 和版本，补为 global/type=fact/verification=pending；原始历史保留，新 payload 在原模型集合中自动重建。未根据旧 key 猜测项目归属，核实后可通过正常版本更新调整属性。

Windows 官方 MCP SDK 实际验收通过：默认 Shared Memory Policy v1、新必填字段、跨分区同 key、精确与子分区边界、标签/类型/核实状态过滤、真实 Gemma 2 跨语言语义检索、待核实双方信息和版本历史。新增的两条合成验收记忆已删除。此次应用依然使用同一模型向量集合，无新增容器或依赖。新接口要求客户端重新发现工具 schema；本机全局规则与 shared-memory 技能已安装，重新开启 Codex 会话加载。

最终检查索引任务为 0、活动模型集合为 1，应用与 PostgreSQL healthy。用户确认的新记忆组织决定已保存到 projects/uni-memory；有效条目共 29 条。Tower 独立测试镜像内 11 项单元测试也通过。

- 三个容器运行，数据库和 Qdrant 就绪，模型已配置；Compose Manager 显示项目并启用自动启动，插件自身启动命令已验证。
- Tower 容器内 Gemma 2 Q4 首次加载及一次短文本推理约 1783 ms，输出 768 维。这是单次烟测，不能与 WSL 完整跑分直接比较。
- Windows 官方 MCP SDK 完成初始化、六工具发现、认证及 Origin 拒绝、合成事实写入/读取、真实索引和跨语言语义检索；数据已清理。
- Codex CLI 0.164.0-alpha.11.1 通过同一 HTTP 配置在两个独立临时会话中，先自动保存合成偏好，再检索并回答；已清理合成事实。全局规则与配置已安装在 Windows 用户目录；当前桌面进程需要重启读取令牌环境变量。
- 自动触发取决于模型遵循客户端指令，服务按稳定 key 处理幂等和冲突，不会自动合并不同 key 的同义事实；写入前应检索并复用已有 key。
- 没有通过重启整个 Tower 验证开机恢复，以免影响其他运行服务。自动启动配置已检查；NPM/EO、公网 OAuth 和其他三个客户端账号仍待验证。
