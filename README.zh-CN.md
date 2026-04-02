# Pi 的 Continuous Learning v2

面向 `pi-coding-agent` 的持续学习插件，实现为一个独立扩展包。

中文仓库地址：

`https://github.com/opsCoffee/pi-continuous-learning-v2`

## 简介

本插件移植了 `everything-claude-code` 中的 `Continuous Learning v2` 核心能力，并按 `pi` 的扩展机制重新实现。

它提供：

- 基于 `pi` 扩展事件的 observation 采集
- project scope / global scope 的 instinct 存储
- 会话运行期间的后台 observer 分析
- instinct 管理命令
- evolved skill / prompt 产物

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
- `/skill-create`
- `/instinct-prune`

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

- 参考 ECC `commands/skill-create.md` 的 git-history 分析步骤
- 读取 README / build config / 代表性源码 / 代表性测试样本
- 在生成前执行 quality gate，检查：
  - 现有 skills 重叠
  - 现有 instincts 重叠
  - `MEMORY.md` 重叠
- 当活跃模型或默认模型无法给出有效结构化结果时，回退到本地 fallback 生成

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

## 展示

`continuous-learning-skill-create` 在交互模式下有自定义渲染，会显示：

- generation mode
- llm status
- model 与 model source
- verdict
- quality gate checklist
- overlap / dropped instincts / absorb target / improvements

## 说明

- observer 运行在当前 `pi` 进程内，不会启动独立 daemon
- evolved commands 通过 `pi` prompt template 暴露
- evolved agents 目前只生成 markdown 产物，不会自动执行
