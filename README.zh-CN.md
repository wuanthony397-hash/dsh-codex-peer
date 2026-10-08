# dsh-codex-peer

[![CI](https://github.com/wuanthony397-hash/dsh-codex-peer/actions/workflows/ci.yml/badge.svg)](https://github.com/wuanthony397-hash/dsh-codex-peer/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/wuanthony397-hash/dsh-codex-peer?sort=semver&label=release)](https://github.com/wuanthony397-hash/dsh-codex-peer/releases) [![License](https://img.shields.io/github/license/wuanthony397-hash/dsh-codex-peer?label=license)](https://github.com/wuanthony397-hash/dsh-codex-peer/blob/main/LICENSE)

让 DeepSeek Harness（DSH）的 agent 与**本机 OpenAI Codex CLI** 以「同伴」方式协作。

Codex 和 DSH 各自保留自己的会话、工具、技能、沙箱与模型，没有集成在一起。
两个 agent 通过普通工具调用和共享工作树里的文件交接工作，就像同一个仓库上的两个人：
一个先做一遍，另一个审查。也可以一个出计划，另一个执行。

```
你：让 Codex 把重试逻辑实现出来，然后审查它写的东西
DSH：codex_plan(goal: "加重试逻辑")              → 分工被记录成共享工作清单
     codex_ask(mode: "implement", prompt: "…")   → Codex 改代码并汇报
     codex_review(target: "working-tree")        → 让 Codex 攻击自己的 diff
     （或者由 DSH agent 自己审查同一份 diff）
```

> **与 OpenAI、DeepSeek 均无从属关系。** 本插件不包含这两个项目的任何代码：它调用的是你自己安装的
> Codex CLI，使用的是 DeepSeek Harness 对外发布的插件 API。“Codex” 是 OpenAI 的商标，DeepSeek
> Harness 是 DeepSeek 的项目。你需要自行安装并登录 Codex CLI，怎么使用由你负责。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `codex_ask` | 在会话工作目录里跑一轮 Codex，返回它的最终消息。`mode: ask \| plan \| implement` 决定它是回答、出计划还是直接改盘；`continueFromLast` / `resumeThreadId` 可续接之前的 Codex 线程。 |
| `codex_review` | 跑一轮**只读** Codex，要求它的答案是一份结构化审查（结论 + 按严重度排序、带文件与行号的发现项），由 `codex exec --output-schema` 约束输出。 |
| `codex_status` | 报告 Codex 可执行文件在哪里被找到、按需探测版本、当前有效配置、共享工作清单（`tasks.summary` 与未完成任务），以及最近的运行与可续接线程。 |
| `codex_plan` | 商定并记录一个目标在本 agent（`dsh`）与 Codex 同伴之间如何分工，形成双方共读的共享工作清单。必填 `goal`；分工已定时用 `tasks` 传入。批准这次调用即批准该计划。 |
| `codex_task` | 推进该清单：`action: list \| show \| claim \| update \| record-evidence \| set-budget \| run`。`action: run` 是挂在任务上的普通同伴运行 —— 任务超出 Codex 预算时被拒绝，计入该任务，续接该任务的 Codex 线程，结果记为证据。 |

每次运行与工作清单写在哪里，见[输出与留档](#输出与留档)。

## 前置条件

- DSH `>= 0.2.0-rc.2`（peer 依赖 `@deepseek-ai/dsh` 与 `@deepseek-ai/schemastery ^3.18.1`），Node `>= 20`。
- 已安装并登录的 Codex CLI。
- 零运行时依赖，且只做 host 端：Harness 自己注入所需包，本插件不声明任何 dependencies，也没有
  任何客户端 bundle 注册。

### 如何找到 Codex CLI

Codex 桌面版不会把自己放进 `PATH`，因此按以下顺序探测，取第一个存在的：

1. 本插件配置里的 `codexPath`；
2. Codex `config.toml` 里的 `CODEX_CLI_PATH`（桌面版会写这一项）；
3. `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`（版本目录新的优先）；
4. `%APPDATA%\npm\codex.cmd`；
5. `PATH` 上的 `codex` / `codex.exe` / `codex.cmd` / `codex.bat`。

`codex_status` 会打印命中的路径、来源，以及被排除的候选。若调用报
`codex CLI not found`，那份输出就说明了究竟找过哪些位置。

## 安装

本插件**没有发布到 npm**，所以 `dsh plugin add dsh-codex-peer` 只有在市场上架后才会生效。上架请求
已经提交给精选列表
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)；收录之前，请从
GitHub 或用 Release 压缩包安装。两种方式都会带上 `dsh.bundle`，DSH 会把它登记到
`dsh.profile.bundles`；bundle 在启动时组装，因此**需要重启（或重载 profile）**工具才会出现。

```bash
# 市场收录后，可在市场里点安装，或这样装
dsh plugin --profile <profile> add dsh-codex-peer

# 从 GitHub 安装，锁定到某个发布 tag（现在就能用）
dsh plugin --profile <profile> add github:wuanthony397-hash/dsh-codex-peer#v0.3.2

# 或从 GitHub 安装，跟随默认分支
dsh plugin --profile <profile> add github:wuanthony397-hash/dsh-codex-peer

# 或用你下载下来的 Release 压缩包 —— 可离线安装，但请把文件留在原处：
# profile 记录的是这个路径，移动或删除它会让下次安装失败
dsh plugin --profile <profile> add /path/to/dsh-codex-peer-0.3.2.tgz

# 或从本地克隆目录安装，适合自己改插件的时候
dsh plugin --profile <profile> add /absolute/path/to/dsh-codex-peer
```

Release 压缩包在 <https://github.com/wuanthony397-hash/dsh-codex-peer/releases>。

## 快速上手

### 安装、重启、验证

1. 按上面任意一种方式装好，然后**重启 DSH**，五个工具只在重启后出现（bundle 在启动时组装）。
2. 检查环境：对 agent 说一句「看一下 codex 的状态」，它会调用 `codex_status`，打印 Codex 可执行
   文件的位置、生效配置和当前工作清单。

然后用大白话说明你要什么，描述想怎么协作。agent 会挑配方，你不需要点名模式。

### 六种模式

每种模式最终都落到一次工具调用上。`codex_plan` 必填 `goal`；分工已定时用 `tasks` 传入（每项必填
`title`，可带 `owner`、`acceptance`、`scope`、`tags`、`why`），`budget`、`replace`、`mirror`、`cwd`
控制其余行为；`mode` 是同一份工作清单上的配方。

#### `assigned` —— 你指定谁做什么

你已经知道怎么分工，只需要把它写下来。例如，你可以说：「这个你俩分工：Codex 做重试逻辑，你做测试。」

agent 会调用 `codex_plan`，`mode: "assigned"`，带上 `goal`，以及每块工作一条 `tasks`
记录。每条含 `owner`（`dsh` 或 `codex`）、`acceptance`，可选 `scope`、`tags`、`why`。这份分工
不需要协商，所以可以给 `propose: "none"`，跳过 Codex 的批评。

你会拿到已记录的工作清单，含任务 id、负责人和验收标准，每个任务一行摘要。
`codex_task action: list` 随时能再打印同一份清单。

#### `self-organizing` —— 两个 agent 按能力自己商量

分工并不显然，你希望两个 agent 在开工前都表态。例如，你可以说：「你俩自己商量怎么把 X 做出来。」

agent 会调用 `codex_plan`，`mode: "self-organizing"`。默认 `propose: "dsh"` 时，本 agent
先起草分工，把草案交给 Codex 在一份 JSON schema 下批评，把批评里的风险并入备注，然后落成清单。
`propose: "codex"` 让 Codex 先起草；`propose: "none"` 跳过批评，直接按草案记录。
你会拿到已记录的工作清单；只要跑过批评，还会看到 Codex 的批评摘要与逐条风险。

#### `pipeline` —— 分阶段推进

工作本来就有先后顺序，你希望每个阶段都能单独被审查。例如，你可以说：「按流水线来：计划 → 实现 → 审查 → 修复。」

agent 会调用 `codex_plan`，`mode: "pipeline"`，建出四个阶段任务：`Plan:`（codex）、
`Implement:`（codex）、`Review:`（codex）、`Fix and verify:`（dsh）。每个都有负责人和验收标准。

你会拿到按顺序排好的四个任务，每个都能单独用 `codex_task action: run` 跑，于是每个阶段
都留下自己的证据。

#### `adversarial` —— 一方攻击另一方

你想要一版初稿，外加一次独立的拆台尝试。例如，你可以说：「让 Codex 先写一版，然后你来攻击它。」

agent 会调用 `codex_plan`，`mode: "adversarial"`，`producer: "codex"`，建出一条由 Codex
负责的产出任务和一条由本 agent 负责的攻击任务。`producer` 决定谁先写；默认是 `dsh`，也就是默认
由 Codex 来攻击。
你会拿到两条任务，一条产出、一条攻击。攻击方的发现项记录为攻击任务的证据。

#### `blind` —— 各自独立做，再比较

你不想让一种思路先入为主地影响另一种。例如，你可以说：「你俩各自独立做一份，然后比较。」

agent 会调用 `codex_plan`，`mode: "blind"`，建出两份独立尝试（`Independent attempt (dsh)`
与 `Independent attempt (codex)`），再加一条由本 agent 负责的 `Compare and pick` 任务。

你会拿到两份互不知情的尝试，以及一条以比较结果作为证据的决策任务。

#### `consult` —— 只问一个问题，不建清单

想听一个意见、无需分工时可以用它。例如，你可以说：「就问 Codex 一句 X 怎么看。」

agent 会调用 `codex_ask`，把你这句话作为 prompt。若你想要的是对某份 diff 的结构化结论，
则改用 `codex_review`。工作清单里不记录任何东西。
你会拿到 Codex 的回答，或带着按严重度排序发现项的审查结论，以及这次运行的留档。

### 日常操作

| 你说 | agent 调用 |
| --- | --- |
| 「看一下工作清单」/「看一下第二条」 | `codex_task action: list`，或单条任务用 `action: show, taskId: "2"` |
| 「第二条交给 Codex」 | `codex_task action: claim, taskId: "2", owner: "codex"` |
| 「跑第二条的 Codex 部分」 | `codex_task action: run, taskId: "2"` |
| 「第二条做完了，凭据是测试通过」 | `codex_task action: record-evidence, taskId: "2", status: "done", evidence: { … }` |
| 「给第二条加点预算」 | `codex_task action: set-budget, taskId: "2", budget: { … }` |

### 三条规则

- 建清单时会审批一次。`approvePerTask` 默认为 `true`，因此这份清单覆盖的任务之后不再逐次询问；
  设为 `false` 则恢复逐次询问。
- 每个任务都带 Codex 预算（默认 5 次运行、200 万 token），预算用尽后，挂在任务上的运行会被拒绝
  并说明原因。可以用 `codex_task action: set-budget` 提高。
- **没有证据不能标记完成。** 证据还没到手时，把任务标为 `unverified`，并写明缺什么。

每个工具和配置项都在下面有说明。开始用时不必先读完，agent 会调用工具。

## 工作原理

### 共享工作清单

清单存在状态目录里：`tasks.json`（当前状态）加 `tasks.ndjson`（每次变更的追加式历史，因此
「谁在何时指派了什么」事后仍可回答）。双方都读它，`codex_task` 推进它：

| `action` | 作用 |
| --- | --- |
| `list` / `show` | 读取整个清单或单个任务。 |
| `claim` | 认领任务，指定 owner。 |
| `update` | 修改 `status`、`owner`、`acceptance`、`scope`、`tags` 或 `blockedBy`。 |
| `record-evidence` | 附上证明该任务的证据，可同时设置状态。 |
| `set-budget` | 提高或降低该任务的 Codex 预算。 |
| `run` | 跑该任务的 Codex 一侧（见下）。 |

任务状态恰好是 `todo`、`doing`、`blocked`、`done`、`unverified`。没有至少一条证据，任务不能
被标为 `done`；标为 `unverified` 必须附一条说明缺什么的 note。证据种类为 `command`、`artifact`、
`review`、`note`。

`action: run` 是挂在任务上的普通同伴运行：任务超出 Codex 预算时被拒绝，计入该任务，续接该任务
的 Codex 线程，结果记为证据。

把 `planFile` 设为仓库相对路径（如 `.codex-peer/PLAN.md`）即可写出工作清单的 markdown 镜像。
留空则不写文件，因为状态目录里的 `tasks.json` 始终是唯一事实来源。

### 预算

每个任务都带 `budget: {maxRuns, maxTokens}` 与 `spent: {runs, tokens}`。任务范围内的运行，包括
`codex_task action:run`，或任何挂在任务上的运行，在预算用尽后都会被拒绝，报错点明是哪个
上限，并指向 `codex_task action:set-budget`。默认值为 `maxCodexRunsPerTask: 5`、
`maxCodexTokensPerTask: 2000000`（`0` 表示不设 token 上限）。

### 审批与沙箱

启动 Codex 等于启动第二个能写同一个工作树的 agent，而这个子进程**不受 Harness 沙箱包裹**。
交给 `codex exec` 的 `-s/--sandbox` 是唯一约束，所以插件默认先问：

- `codex_plan` 一定会先问一次（除非 `requireApproval: never`），因为批准它才让 Codex 能在这些
  任务范围内写盘。`approvePerTask: true`（默认）时，已批准任务中会写盘的 Codex 运行不再逐次
  询问；`approvePerTask: false` 则恢复逐次询问。
- `requireApproval: mutating`（默认）对任何可能写盘的运行提问：`mode: implement`、
  `sandbox: workspace-write`、`sandbox: danger-full-access`，但 `approvePerTask` 下已被批准任务
  覆盖的运行除外。
- `codex_review` 固定 `read-only`，在 `mutating` 下不会触发审批。
- 审批走 Harness 的审批服务，且是 fail-closed：没有可用的审批者时直接拒绝，而不是照跑。

Codex 自己需要写它的 home（`~/.codex`：状态、日志、`auth.json`）。若调用报
`failed to initialize in-process app-server client: 拒绝访问 (os error 5)` 或
`could not create PATH aliases`，说明当前限制下 Codex 的 home 不可写。为该命令放宽沙箱，
或把 `codexHome` 指到可写目录（此时需要复制一份 `auth.json`，并注意 Codex 会轮换 refresh token）。

### 后台运行

Harness 的 job 服务加载后（base bundle 自带），每次运行都会成为由调用 agent 拥有的 job：

- `background: true` 立即返回 job 句柄；
- 前台调用超过 `callTimeoutMs` 会被**提升**为后台而不是被杀，工具结果里会给出 job id；
- `job_output` 可读取插件喂给 job 的进度（线程开始、每条命令与退出码、文件变更、token 用量），
  `job_kill` 取消运行并终止 Codex 进程树。

没有 job 服务时工具依然可用；`background: true` 会带着原因被拒绝，而不是悄悄换个行为。

### 一次运行如何拼起来

1. 提示词是一份协作契约，而不只是你的原话：说明共享工作树、说明**没有人类会回答问题**（因此
   Codex 必须自行假设并继续）、改动限制在请求范围内、最终消息必须自洽（改了什么、证据、未决问题）。
   `promptPreamble` 可替换该契约。
2. 提示词走 **stdin**（`codex exec … -`），不走命令行。Windows 命令行上限约 32k 字符，交接提示
   很容易超过。
3. `codex exec resume` 既不接受 `-s/--sandbox` 也不接受 `-C/--cd`，因此续跑用
   `-c sandbox_mode="…"` 固定沙箱，工作目录由子进程的 cwd 决定。
4. 进程监管优选 Harness 的子进程接缝（`ctx.subprocess`）：环境清理、整棵进程范围的
   SIGTERM→宽限→SIGKILL 终止阶梯，以及服务销毁时不留下孤儿 `codex.exe`。没有该接缝时退回
   `node:child_process`，Windows 上用 `taskkill /T`、其他平台杀进程组；回退会记在运行结果里。
5. 事件流被增量折叠：线程 id、逐项进度（命令、文件变更、待办、MCP 与联网搜索项）、最终回答、
   token 用量与所有错误。

## 输出与留档

每次运行都留两份：一份写在你能读到的地方，一份是插件读取的记录。

### 工作目录：你读的那份

插件把可读镜像写在该次运行的工作目录下，路径是 `<cwd>/<workspaceDir>/`，默认
`<cwd>/.codex-peer/`：

```
<cwd>/.codex-peer/
├── README.md                # 这个目录是什么，以及删掉也没关系
├── worklist.md              # 共享工作清单的可读镜像
├── LATEST.md                # 最新一次运行的留档，一个文件就能看到刚刚发生了什么
└── runs/<runId>/
    ├── transcript.md        # 完整可读留档：拼好的请求、每条命令及其退出码、
    │                        # 改动的文件、最终回答、token 与耗时
    ├── prompt.md            # 原样交给 Codex stdin 的文本
    ├── events.jsonl         # 原始 `codex exec --json` 事件流
    ├── stderr.txt           # Codex 诊断（令牌刷新告警、传输回退等）
    ├── answer.md            # Codex 写出的最终消息（-o）
    └── meta.json            # 结果记录：状态、退出码、用量、命令、文件变更、备注
```

这个目录就是你用来看协作过程的地方：`worklist.md` 是清单当前的样子，`LATEST.md` 是刚结束的那次
运行，`runs/<runId>/transcript.md` 是任意一次运行的完整记录。它删掉也没关系，插件会重新写；它还
会自动忽略自己——目录里的 `.gitignore` 就是 `*`，`git` 不会把这里的文件算进来，想提交某一次留档就
点名：`git add -f .codex-peer/LATEST.md`。把 `workspaceDir` 设为 `''` 可以完全关掉这份镜像。

### 状态目录：插件读的那份

状态目录是 `$DSH_HOME/codex-peer`，未设置 `DSH_HOME` 时即 `~/.dsh/codex-peer`（Windows 上是
`%USERPROFILE%\.dsh\codex-peer`）。它是唯一事实来源：

```
$DSH_HOME/codex-peer/
├── runs.ndjson              # 每次运行一条 JSON：状态、模式、沙箱、用量、线程、标签
├── threads.json             # 工作目录 → 最近的 Codex 线程 id（continueFromLast 读它）
├── tasks.json               # 共享工作清单：当前状态
├── tasks.ndjson             # 工作清单每次变更的追加式历史
└── runs/<runId>/
    ├── prompt.md            # 原样交给 Codex stdin 的文本
    ├── events.jsonl         # 原始 `codex exec --json` 事件流
    ├── stderr.txt           # Codex 诊断（令牌刷新告警、传输回退等）
    ├── answer.md            # Codex 写出的最终消息（-o）
    ├── meta.json            # 结果记录：状态、退出码、用量、命令、文件变更、备注
    └── output-schema.json   # 仅 schema 约束的运行（如 codex_review）才有
```

不会自动清理：在意体积时自行删除旧的 `runs/<runId>`。配置的 `planFile` 镜像写在仓库里，
不写在这个目录。

工作目录里的副本供人阅读，可以删除，也可以在 git 里忽略。
插件读取状态目录里的记录：运行索引、线程记忆，以及继续推进工作所需的清单。

## 配置

所有配置都在 profile 的 `cordis.patch.yml` 里。工具里没有硬编码的路径、模型或策略。
同 id 的 patch 行会**整体替换**该 id 的 `config`，所以要写全：

```yaml
- insert:
    - id: codex-peer
      name: 'dsh-codex-peer'
      config:
        defaultMode: implement
        requireApproval: mutating
        model: ''                 # 空 = 用 Codex 自己 config.toml 里的默认模型
        runTimeoutMs: 3600000
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `codexPath` | `''` | 显式指定 Codex 可执行文件，优先级最高的探测候选。 |
| `codexHome` | `''` | 传给子进程的 `CODEX_HOME`（Codex 自己的状态根，含 `auth.json`）。空 = 继承。 |
| `stateDir` | `''` | 运行留档与账本所在目录。空 = `$DSH_HOME/codex-peer`。 |
| `model` | `''` | `codex exec -m` 覆盖。空 = Codex 自己配置的默认模型。 |
| `defaultMode` | `ask` | `codex_ask` 未给 `mode` 时使用的模式。 |
| `defaultSandbox` | `''` | 调用未给 `sandbox` 时使用的沙箱；空则按模式推导（implement → `workspace-write`，其余 `read-only`）。 |
| `requireApproval` | `mutating` | `mutating`：可能写盘的运行先问用户；`always`：每次同伴调用都问；`never`：不设闸口。`codex_plan` 调用除 `never` 外总会先问一次。 |
| `callTimeoutMs` | `600000` | 前台调用等待多久后转成后台任务。 |
| `runTimeoutMs` | `1800000` | 单次 Codex 运行的硬上限，到点终止整棵进程树。 |
| `maxAnswerBytes` | `120000` | 返回给模型的回答预算；完整消息仍留在 `answer.md`。 |
| `progressKeepLines` | `400` | 内存里保留多少行进度，供 `job_output` 与失败说明使用。 |
| `terminateGraceMs` | `5000` | 终止宽限（托管接缝的 SIGTERM→SIGKILL 窗口；直接启动时为树杀窗口）。 |
| `extraArgs` | `[]` | 追加到每次 `codex exec` 的额外参数。 |
| `promptPreamble` | `''` | 替换内置的同伴契约前言（每次提示词都会前置）。 |
| `planFile` | `''` | 工作清单 markdown 镜像的可选仓库相对路径，例如 `.codex-peer/PLAN.md`。留空则不写文件，因为状态目录里的 `tasks.json` 始终是唯一事实来源。 |
| `routingRules` | 内置路由表 | `{when, owner, reason}` 数组；`when` 是小写词或短语，匹配任务的标题、标签与 scope，先匹配者胜。 |
| `defaultOwner` | `dsh` | 没有路由规则匹配时的 owner。 |
| `maxCodexRunsPerTask` | `5` | 一个任务在被拒绝前可花的 Codex 运行次数。可用 `codex_task action:set-budget` 按任务调整。 |
| `maxCodexTokensPerTask` | `2000000` | 一个任务在被拒绝前可花的 Codex token 数；`0` 表示不设 token 上限。 |
| `approvePerTask` | `true` | 为 `true` 时，批准一次计划即覆盖该任务内会写盘的 Codex 运行，不再逐次询问；`false` 则恢复逐次询问。 |
| `workspaceDir` **（新增）** | `.codex-peer` | 可读镜像写到哪里：相对于该次运行工作目录的路径（见[输出与留档](#输出与留档)）。**留空字符串则完全关闭工作目录镜像。** |

路由表就是普通数据（`routingRules`）：每条 `{when, owner, reason}` 用小写词或短语匹配任务的
标题、标签与 scope，先匹配者胜。内置规则把 bulk/rename/migrate/review/audit/second-opinion/
survey/summarize/draft 交给 `codex`，把 debug/interactive/plugin/install/verify/integration/
decision 交给 `dsh`，每条都带一行理由。没有规则匹配时由 `defaultOwner`（默认 `dsh`）接手。

## 工具返回值形状

每个工具返回一个 JSON 对象（对模型渲染成文本）：

```jsonc
// codex_ask，已结束
{ "status": "completed", "runId": "codex-20261008-101010-abcd", "mode": "implement",
  "sandbox": "workspace-write", "launcher": "subprocess", "threadId": "01a1…",
  "usage": { "inputTokens": 22406, "cachedInputTokens": 13184, "outputTokens": 7, "totalTokens": 22413 },
  "answer": "…", "commands": [{ "command": "npm test", "exitCode": 0 }],
  "fileChanges": ["update lib/a.js"], "notes": [], "artifacts": { "events": "…", "answer": "…" } }

// codex_ask，仍在运行（被提升或后台启动）
{ "status": "running", "kind": "promoted", "jobId": "…", "progressTail": "…", "artifacts": { … } }

// codex_review
{ "status": "completed", "structured": true,
  "review": { "verdict": "concerns", "summary": "…",
              "findings": [{ "severity": "major", "title": "…", "file": "lib/a.js", "line": 12,
                             "detail": "…", "suggestion": "…" }] },
  "run": { "runId": "…", "answerPath": "…", "usage": { … }, "notes": [] } }
```

`codex_review` 用严格 schema 约束 Codex（`verdict` ∈ `pass|concerns|fail`；`findings[]` 的
`severity` ∈ `blocker|major|minor|nit`）。如果 Codex 的答案不合形状，工具返回原文并标记
`structured: false`，而不是假装解析成功。

## 排查

| 现象 | 原因与处理 |
| --- | --- |
| 报 `codex CLI not found` 并列出候选 | Codex 不在探测位置上。在配置里设 `codexPath`；`codex_status` 会显示找过哪些路径。 |
| 启动时报 `os error 5` / `拒绝访问` | Codex 无法写自己的 home。为该命令放宽沙箱，或把 `codexHome` 指到可写目录（需 `auth.json`）。 |
| stderr 出现 `Failed to refresh token: 403 … unsupported_country_region_territory` | 当前地区被拒刷新令牌。令牌未过期前仍可用，过期后需重新登录 Codex。 |
| 调用返回 `status: "running"` | 运行超过 `callTimeoutMs`，已转为 job：用 `job_output` 读取，用 `job_kill` 停止。 |
| `status: "timeout"` | 运行超过 `runTimeoutMs`，进程树已被终止。提高上限或缩小请求范围。 |
| 报 `background Codex runs need the job service` | profile 没有 job 服务。加载 `@deepseek-ai/dsh-tool-jobs`（base bundle 自带），或去掉 `background: true`。 |

## 开发

```
index.js            插件入口：配置、账本、工具、审批闸口、可选接缝
lib/config.js       schemastery 配置契约与「模式 → 沙箱」推导
lib/locate.js       Codex 探测与版本探测
lib/argv.js         提示词组装（同伴契约 + 模式）与 codex 参数向量
lib/events.js       JSONL 事件折叠、支持偏移读取的进度日志、用量归一化
lib/review.js       审查 JSON schema、提示词，以及宽松的答案归一化
lib/runner.js       规划一次运行、执行、流式读取并记录结果
lib/execute.js      经由 job 服务选择前台/后台
lib/launch.js       托管子进程接缝 + 直接 spawn 回退
lib/ledger.js       运行索引、线程记忆、原子化留档写入
lib/gate.js         tools/pre-execute 审批策略
lib/tools.js        `codex_ask`、`codex_review`、`codex_status` 及其文本渲染器
lib/tasks.js        共享工作清单：id、状态、证据、预算、历史
lib/plan.js         六种模式、路由表与计划 JSON schema
lib/planning-tools.js  `codex_plan` 与 `codex_task`
test/unit.test.js   55 个离线测试
```

```bash
npm test                      # node test/unit.test.js —— 55 个测试全部离线，不启动 Codex
node --test test/             # 同样的测试，走测试运行器（需要能创建子进程）
node test/run-as-linux.mjs    # 同样的测试，让 process.platform 假装是 Linux
```

`npm test` 跑 55 个离线测试。`node test/run-as-linux.mjs` 用同一套测试，只把 `process.platform`
假装成 Linux，因为 Windows CI 与 Linux CI 两条腿走的是不同分支（`normalizeCwd` 的大小写折叠、
`taskkill` 与 `process.kill`、detached spawn）。它是开发辅助脚本，不是测试。

测试从不启动 Codex：`executeRun` 接收注入的 `spawnImpl` 来重放一段真实抓取的
`codex exec --json` 事件流，「可执行文件在哪」则由测试自己创建的文件回答。

## 许可证

MIT
