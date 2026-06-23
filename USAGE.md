# Skill Gate 使用说明

Skill Gate 用来做一件事：在 Codex 使用外部 Skill 前，先判断是否值得用，再审计它的来源、文件、风险和版本。

## 先准备

```powershell
cd "D:\下载\项目与规则\我的项目\skill-gate"
npm install
npm run build
```

之后命令都用：

```powershell
node dist/src/cli.js <command>
```

如果通过 npm link / 全局安装让 bin 上 PATH，可以改成 `skill-gate <command>`。
从 npm/Git 安装时 `prepare` 会自动 build；直接克隆时仍建议先手动跑一次 `npm run build`。

## 标准流程

### 0. 什么时候会让你选

Skill Gate 遇到会明显影响结果的分叉时，应该先让你选：

- 多个 Skill 都可能合适：让你选用哪个。
- 审计完成后：让你选 `use once` / `install for project` / `view files` / `reject`。
- 风格方向不明确：让你选 UI、写作、PPT、文档等风格。
- HIGH risk：使用前必须再次确认；v1 不执行脚本。
- 任务看起来完成时：先问你删除、保留还是打包临时 session，不会自动清理。

在 Codex App 里，如果当前环境支持选择 UI，它会优先弹出小窗口；否则会在聊天里给 2-3 个编号选项。

### 1. 判断是否需要 Skill

```powershell
node dist/src/cli.js recommend "build a polished React admin dashboard"
```

默认是 Popular 模式：只展示安装量 >= 1000 的候选，最多 3 个。

可选模式：

```powershell
node dist/src/cli.js recommend "build a React app" --mode trusted
node dist/src/cli.js recommend "build a React app" --mode popular
node dist/src/cli.js recommend "build a React app" --mode explorer
```

- `trusted`: >= 10000 installs
- `popular`: >= 1000 installs
- `explorer`: 不设安装量门槛；仍然必须 inspect，use/install 仍然要显式批准

如果任务领域没被关键词 gate 识别，但你确定要搜：

```powershell
node dist/src/cli.js recommend "build a CAD automation workflow" --force --mode explorer
```

### 1.5 拆成多个 agent 的分工计划

```powershell
node dist/src/cli.js delegate "build a React dashboard with API, tests, and README"
```

`delegate` 只输出计划，不会启动多个 agent，不会下载 Skill，不会安装 Skill，不会写文件。

输出会包含：

- `Task Split`
- `Agent Assignments`
- `Skill Plan`
- `Conflict Rules`
- `Reviewer Checklist`
- `Next Commands`

默认规则：

- 一个文件/模块只能有一个 owner agent。
- shared files 只能由 main agent 改。
- 每个 agent 只能用自己 lane 里批准过的 skill。
- reviewer agent 只读，只给 findings，不写修复。

### 2. 审计候选 Skill

```powershell
node dist/src/cli.js inspect vercel-labs/agent-skills@vercel-react-best-practices
```

`source` 可以是本地路径、`owner/repo@skill`、`owner/repo@skill#<40位commit>`、GitHub repo URL，或固定 ref/子目录的 GitHub tree URL，例如：

```powershell
node dist/src/cli.js inspect vercel-labs/agent-skills@vercel-react-best-practices#0123456789abcdef0123456789abcdef01234567
node dist/src/cli.js inspect https://github.com/google-labs-code/stitch-skills/tree/main/plugins/stitch-build/skills/react-components
```

如果要给 Fit 打分，传任务：

```powershell
node dist/src/cli.js inspect vercel-labs/agent-skills@vercel-react-best-practices --task "build a React dashboard"
```

这会把 Skill 下载/复制到隔离目录：

```text
.skill-gate/sessions/<session-id>/
```

并生成：

```text
manifest.json   来源、commit SHA、审批状态、创建文件
audit.json      文件列表、hash、能力摘要、风险等级
skills/<skill>/ 实际审计到的 Skill 文件
```

注意：v1 的审批边界是 **inspect 可以隔离下载，use/install 前必须审批**。

### 3. 选择怎么处理

查看完整文件，不批准使用：

```powershell
node dist/src/cli.js view vercel-labs/agent-skills@vercel-react-best-practices
```

临时使用一次：

```powershell
node dist/src/cli.js use vercel-labs/agent-skills@vercel-react-best-practices --approve
```

安装到当前项目的 pinned copy：

```powershell
node dist/src/cli.js install vercel-labs/agent-skills@vercel-react-best-practices --approve
```

安装位置：

```text
.skill-gate/project-skills/<skill>/
```

拒绝：

```powershell
node dist/src/cli.js reject vercel-labs/agent-skills@vercel-react-best-practices
```

`use` 和 `install` 都会复用已经 `inspect` 过的 pinned session，不会重新 clone 最新远端版本。`use` 是一次性的；第二次临时使用需要重新 `inspect`。

### 4. 查看当前 session

```powershell
node dist/src/cli.js status
```

### 5. 保存 reusable pack

```powershell
node dist/src/cli.js pack react-ui-pack
```

保存位置：

```text
.skill-gate/packs/react-ui-pack/
```

### 6. 清理临时 session

```powershell
node dist/src/cli.js cleanup
node dist/src/cli.js cleanup --approve
```

cleanup 只删除 manifest 记录的 `.skill-gate/sessions/<id>`，不会删除用户已有 Skill，也不会删 pack。没有 `--approve` 时只预览将删除的路径。

## 风险等级

### LOW

只有 `SKILL.md` 和静态 references，没有脚本、网络、密钥、全局写入。

### MEDIUM

包含模板、依赖安装说明、网络说明，但没有自动执行脚本。

### HIGH

包含脚本、嵌套 scripts、install hooks、symlink、shell/PowerShell、外部下载、环境变量/API key、全局 Codex 配置、删除命令、可疑 prompt injection。

v1 规则：HIGH skill 只查看，不自动执行脚本。

## 常见命令速查

```powershell
node dist/src/cli.js recommend "<task>"
node dist/src/cli.js recommend "<task>" --mode trusted
node dist/src/cli.js recommend "<task>" --force --mode explorer
node dist/src/cli.js delegate "<task>"
node dist/src/cli.js inspect <owner/repo@skill[#commit]>
node dist/src/cli.js view <owner/repo@skill>
node dist/src/cli.js use <owner/repo@skill> --approve
node dist/src/cli.js install <owner/repo@skill> --approve
node dist/src/cli.js reject <owner/repo@skill>
node dist/src/cli.js status
node dist/src/cli.js pack <name>
node dist/src/cli.js cleanup
node dist/src/cli.js cleanup --approve
node dist/src/cli.js diff <owner/repo@skill>
```

## 当前限制

- 判断是否需要 Skill 仍是正则 gate，不是真语义边际收益分析。
- 去重只去 exact source duplicate；不会猜测能力覆盖。
- 推荐质量过滤还没检查 publisher、updated、archived、license、compatibility；inspect 决策页会把这些元数据标成未知，不伪造。
- 风险扫描只看 `SKILL.md`、`scripts/` 和 package install hooks 里的危险行为，降低 policy/reference 文字误报；仍然是正则启发式，不是 AST/沙箱。
- 测试是 MVP self-check，不是完整规则矩阵。
