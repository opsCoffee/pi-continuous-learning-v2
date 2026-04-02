# Pi 的 Continuous Learning v2

面向 `pi-coding-agent` 的持续学习插件，实现为一个独立扩展包。

仓库地址：

`https://github.com/opsCoffee/pi-continuous-learning-v2`

## 简介

本插件移植了 `everything-claude-code` 中的 `Continuous Learning v2` 核心能力，并按 `pi` 的扩展机制重新实现。

它提供：

- 基于 `pi` 扩展事件的 observation 采集
- project scope / global scope 的 instinct 存储
- 会话运行期间的后台 observer 分析
- pending instinct 暂存与 TTL 清理
- instinct 管理命令
- 对齐 ECC 语义的 `/skill-create`、`/learn-eval`、`/evolve --generate`
- evolved skill / prompt / agent 产物

它不会修改 `pi-mono` core。

## 安装

直接从 GitHub 安装：

```bash
pi install https://github.com/opsCoffee/pi-continuous-learning-v2
```

或：

```bash
pi -e git:github.com/opsCoffee/pi-continuous-learning-v2
```

本地仓库调试：

```bash
pi -e ./pi-continuous-learning-v2
```

如果你正在 `pi-mono` 中调试：

```bash
pi -e ./packages/coding-agent/examples/extensions/continuous-learning-v2
```

## 命令

- `/instinct-status`
- `/instinct-export`
- `/instinct-import`
- `/promote`
- `/projects`
- `/evolve`
- `/observer-status`
- `/agent-run`
- `/skill-create`
- `/learn-eval`
- `/prune`
- `/instinct-prune`

## 与 ECC 的对齐方式

本插件优先对齐功能和结果质量，而不是强求 Claude Code 架构 1:1 复刻：

- `Continuous Learning v2` 作为 `pi` 扩展运行，而不是 Claude hook 脚本
- `/skill-create` 保持“单个 repo-level skill”的定位
- `/skill-create --instincts` 产出更原子、便于后续聚类的 repo-analysis instincts
- `/evolve --generate` 负责把多主题 instinct clusters 拆成多个 skill
- `/learn-eval` 作为独立命令存在
- observer 更偏向产出可复用、可聚类的 instinct，并把低置信度结果放进 `pending/`

## 存储位置

项目级状态和产物默认写到当前项目的 `.pi/` 目录。

项目级状态：

```text
<project>/.pi/continuous-learning-v2/
```

生成产物：

```text
<project>/.pi/skills/
<project>/.pi/prompts/
<project>/.pi/agents/
```

待审核的 pending instincts：

```text
<project>/.pi/continuous-learning-v2/instincts/pending/
```

全局配置和 global-scope instincts 仍保留在：

```text
~/.pi/agent/continuous-learning-v2/
```

## Observer

首次运行时会自动生成默认配置：

```json
{
  "version": "2.1",
  "observer": {
    "enabled": false,
    "runIntervalMinutes": 5,
    "minObservationsToAnalyze": 20,
    "maxRecentObservations": 200
  }
}
```

配置文件路径：

```text
~/.pi/agent/continuous-learning-v2/config.json
```

如需开启自动学习，将 `observer.enabled` 设为 `true`。

Observer 和 `/skill-create` 的模型选择顺序如下：

1. 当前会话活跃模型
2. `~/.pi/agent/settings.json` 中的默认模型（`defaultProvider` + `defaultModel`）

```bash
/observer-status
```

`/observer-status` 会汇总：

- observer 是否启用、是否正在运行
- 是否已有待执行的调度任务
- observation 总数与尚未分析的 observation 数量
- pending instinct 数量
- 最近一次 attempt / completion / result / error
- 当前配置阈值

Observer 当前行为：

- 高置信度 instinct 直接写入 active instinct 存储
- 低置信度 instinct 先进入 `pending/`
- `/prune` 只清理过期 pending instincts，默认 TTL 为 30 天
- observation 突发不会每次都直接触发分析，而是会合并成延后调度的 observer 运行
- 如果 observer 因 busy / cooldown 被跳过，会通过 `pi` 进程内调度稍后重试，而不是依赖 shell signal
- observer 在生成时会参考已有 active/pending instincts，减少近义重复
- 输出目标偏向原子、可聚类、可后续 evolve 的规则

## /skill-create

```bash
/skill-create
/skill-create --commits 100
/skill-create --output ./custom-skills
/skill-create --instincts
```

`/skill-create` 会分析本地 git 历史并生成仓库级 skill。

如果不传 `--output`，默认生成到：

```text
<project>/.pi/skills/
```

如果带 `--instincts`，还会把 repo-analysis instincts 写入当前项目的 instinct 存储。

### 当前分析链路

- 通过隔离的 pi SDK 子会话，按 ECC `commands/skill-create.md` 的方式做 agentic repo analysis
- 使用受限原生工具读取 git history、候选源码、测试和构建文档
- 如果子会话未直接保存工件，会基于探索 transcript 做一次合成兜底
- 在生成前执行 quality gate，检查：
  - 现有 skills 重叠
  - 现有 instincts 重叠
  - `MEMORY.md` 重叠
- 当活跃模型或默认模型无法给出有效结果时，回退到本地 fallback summarizer

### 可能的质量判定

- `save`
- `improve-then-save`
- `absorb`
- `drop`

判定含义：

- `save`：直接写入 skill 和可选 instincts
- `improve-then-save`：先自动修订一轮，再重新评估后写入
- `absorb`：不新建 skill，返回建议吸收目标和可追加内容
- `drop`：不写入 skill

`/skill-create --instincts` 的输出会刻意保持更原子，目的是让后续 `/evolve --generate` 能拆出多个 skill，而不是把所有规则都塞进单个 instinct。

## /learn-eval

```bash
/learn-eval
/learn-eval --apply
```

`/learn-eval` 会读取当前 session path，对本轮会话里最值得沉淀的单个模式做独立评估，并给出：

- `save`
- `improve-then-save`
- `absorb`
- `drop`

默认只报告结果；交互模式下会确认后再写入；非交互模式使用 `--apply` 或 `--force` 才会真正落盘。

交互模式下，`/learn-eval` 现在有专用自定义渲染，会按 verdict 展示 checklist、改进项、吸收内容和 draft skill。

当 verdict 为 `absorb` 且目标是 `MEMORY.md` 时，插件会按 project/global scope 解析实际 MEMORY 路径，并直接把 learned pattern 追加进去，而不是只给建议文本。

## /evolve

```bash
/evolve
/evolve --generate
```

`/evolve --generate` 会对 instinct 做聚类，并可一次生成多个产物：

- 多个 skill
- prompt templates（在 `pi` 中表现为原生 slash commands）
- agent markdown 产物

这也是当前实现与 ECC 最接近的地方：

- `/skill-create`：生成一个 repo-level skill
- `/evolve --generate`：把多主题 instinct clusters 演化成多个 skills

```bash
/agent-run <agent-name-or-path> <task...>
```

`/agent-run` 是 evolved agent 的显式手动运行入口。

它会：

- 从项目 `.pi/agents/`、全局 evolved agents，或显式路径解析 agent 文件
- 用该 agent artifact 作为本次运行的 system prompt，启动一个隔离的 pi SDK session
- 执行你提供的 task，并返回最终 assistant 输出

这样既保留了“manual artifact only”的语义，也让生成出来的 agent 文件有明确可用的执行入口。

## /prune

```bash
/prune
/prune --dry-run
```

`/prune` 只清理过期的 pending instincts，不会影响 active instincts。  
`/instinct-prune` 则继续专门处理 active project instincts 的保守去重。

## 展示

`continuous-learning-skill-create` 在交互模式下有自定义渲染，会显示：

- generation mode
- llm status
- model 与 model source
- verdict
- quality gate checklist
- overlap / dropped instincts / absorb target / improvements

## 当前验证情况

最近一轮真实验证覆盖了：

- `codeql-scanner` 上的 `/skill-create --instincts`
- `codeql-scanner` 上的 `/evolve --generate`
- observer 的真实 session 验证
- 可重复执行的 observer 验证脚本：
  - `npx tsx scripts/observer-validation.mts --mode regression`
  - `npx tsx scripts/observer-validation.mts --mode soak --rounds 3`
- 实际命令验证：
  - `/observer-status`
  - `/agent-run /tmp/ecc-manual-agent.md say hello`

其中 `/evolve --generate` 已经在真实项目中生成多个 skill，例如：

- `tests`
- `workspace-manifests`

observer 真实验证中，active instincts 收敛为 3 条更原子的规则，pending 为 0，说明当前自动学习结果已经比早期版本更少重复、更适合后续演化。

当前 soak 基线结果为：

- 第 1 轮：`learned = 3`
- 第 2 轮：`learned = 0`
- 第 3 轮：`learned = 0`

这说明在重复相似会话下，observer 不会继续累积近义重复 instinct。

包内脚本：

```bash
npm run validate:observer
npm run validate:observer:soak
```

## 说明

- observer 运行在当前 `pi` 进程内，不会启动独立 daemon
- evolved commands 通过 `pi` prompt template 暴露
- evolved agents 目前只生成 markdown 产物，并在 frontmatter 中明确标记为 manual artifact，不会自动执行
- `continuous-learning-learn-eval` 现在也有交互模式下的自定义渲染
- `pi-mono` 根级 `npm run check` 目前仍受仓库现有 `packages/web-ui` 问题阻塞；插件验证以子模块自身检查和真实会话验证为主
