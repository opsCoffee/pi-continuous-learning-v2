# Continuous Learning v2 For Pi

Instinct-based continuous learning for `pi-coding-agent`, implemented as a standalone extension package.

English | [简体中文](README.zh-CN.md)

Repository:

`https://github.com/opsCoffee/pi-continuous-learning-v2`

## Scope

This package ports only the `Continuous Learning v2` portion of `everything-claude-code`.

It provides:

- observation capture from pi extension events
- project-scoped and global instinct storage
- background observer analysis while a pi session is running
- pending instinct staging and TTL-based pruning
- instinct management commands
- ECC-aligned `/skill-create`, `/learn-eval`, and `/evolve --generate`
- evolved skills, prompt templates, and agent markdown artifacts

It does not modify `pi-mono` core logic.

## Install

For a standalone GitHub repository:

```bash
pi install https://github.com/opsCoffee/pi-continuous-learning-v2
```

Or:

```bash
pi -e git:github.com/opsCoffee/pi-continuous-learning-v2
```

For a local checkout:

```bash
pi -e ./continuous-learning-v2
```

If you are testing from this monorepo checkout:

```bash
pi -e ./packages/coding-agent/examples/extensions/continuous-learning-v2
```

## Commands

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

## ECC Alignment

This package follows ECC's behavior where it fits `pi` natively:

- `Continuous Learning v2` runs as a pi extension instead of Claude hook scripts
- `/skill-create` stays repo-level and uses an isolated pi SDK sub-session with restricted native tools
- `/skill-create --instincts` produces smaller repo-analysis instincts for later evolution
- `/evolve --generate` is responsible for splitting multi-topic instinct clusters into multiple skills
- `/learn-eval` exists as a standalone command
- observer output prefers atomic, clusterable instincts and stages low-confidence drafts into `pending/`

## Storage

Project-scoped state and generated artifacts default to the current project's `.pi/` directory.

Project-scoped state:

```text
<project>/.pi/continuous-learning-v2/
```

Generated artifacts:

```text
<project>/.pi/skills/
<project>/.pi/prompts/
<project>/.pi/agents/
```

Pending instincts awaiting review:

```text
<project>/.pi/continuous-learning-v2/instincts/pending/
```

Global config and global-scope instincts still live under:

```text
~/.pi/agent/continuous-learning-v2/
```

When pi is running outside a git project, Continuous Learning now falls back to `global` scope instead of inventing a synthetic project from the current directory.

Project detection override:

- `PI_PROJECT_DIR=/path/to/project` forces Continuous Learning to treat that directory as the current project root
- `CLAUDE_PROJECT_DIR` is also honored for compatibility with ECC-style environments

## Observer

Default config is created on first run:

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

Config file path:

```text
~/.pi/agent/continuous-learning-v2/config.json
```

To enable automatic learning, set `observer.enabled` to `true`.

Observer behavior:

- higher-confidence observer instincts are written into active instinct storage
- lower-confidence observer instincts are staged under `instincts/pending/`
- `/prune` removes expired pending instincts with a 30-day default TTL
- observation bursts are coalesced into scheduled analysis runs instead of re-triggering analysis on every event
- busy or cooldown observer runs are retried later using pi-native scheduling instead of shell signals
- observer prompts include existing active and pending instincts to reduce near-duplicate learning
- observer output is filtered toward atomic, reusable rules that are easier to evolve into skills

Observer and `skill-create` model selection follow this order:

1. current active session model
2. `~/.pi/agent/settings.json` default model (`defaultProvider` + `defaultModel`)

Observer-specific model selection follows:

1. current active session model
2. `observer.model` when configured as `provider/id`
3. `~/.pi/agent/settings.json` default model

```bash
/observer-status
```

`/observer-status` reports:

- whether observer is enabled or currently running
- whether an analysis run is already scheduled
- total observations and not-yet-analyzed observations
- pending instinct count
- last attempt / completion / result / error
- current config thresholds

## Skill Create

```bash
/skill-create
/skill-create --commits 100
/skill-create --output ./custom-skills
/skill-create --instincts
```

`/skill-create` analyzes local git history and generates a repository skill.

Without `--output`, the generated skill defaults to the project's `.pi/skills/`.

With `--instincts`, it also writes repo-analysis instincts into the current project's instinct store.

The generation flow uses:

- an isolated pi SDK sub-session that mirrors ECC's `/skill-create` workflow
- restricted native tools for git-history inspection, file discovery, grep, read, and artifact saving
- transcript synthesis as a recovery path when the sub-session does not save final artifacts directly
- a `learn-eval`-style quality gate that checks overlap with existing skills, existing instincts, and `MEMORY.md` before saving
- overlap checks now combine existing skill title, headings, bullet actions, section bodies, paragraphs, and longer body text instead of relying only on skill metadata
- a generic local fallback summarizer when the active or default model cannot produce usable artifacts

`/skill-create` may return these quality verdicts:

- `save`
- `improve-then-save`
- `absorb`
- `drop`

Verdict behavior:

- `save`: writes the skill and optional instincts
- `improve-then-save`: performs one automatic revision pass, then re-evaluates before saving
- `absorb`: does not write a new skill and returns an absorb target plus appendable content suggestion
- `drop`: does not write a new skill

`/skill-create --instincts` is optimized for later `/evolve --generate` runs. The generated repo-analysis instincts are intentionally smaller and more clusterable than the repo-level skill.

## Learn Eval

```bash
/learn-eval
/learn-eval --apply
```

`/learn-eval` reviews the current session path, extracts the single highest-value reusable pattern, applies a learn-eval style quality gate, and decides:

- whether to save, improve, absorb, or drop
- whether the pattern belongs in project scope or global scope

By default it reports the draft and verdict. In interactive mode it asks for confirmation before saving or absorbing. In non-interactive mode, use `--apply` or `--force` to write the result.

Interactive `learn-eval` results use a dedicated custom renderer with verdict-specific sections for checklist, absorb content, improvements, and the draft skill.

When the verdict is `absorb` and the target is `MEMORY.md`, the plugin now appends the learned pattern to the resolved project or global MEMORY file instead of only reporting a suggestion.
Local overlap checks now use deeper full-text structure matching, so absorb/drop decisions are less likely to miss semantically similar skills whose overlap appears later in the file body.

## Evolve

```bash
/evolve
/evolve --generate
```

`/evolve --generate` clusters related instincts and can emit multiple outputs from the same project:

- multiple skills when the instinct set spans different themes
- prompt templates that become native slash commands in pi
- agent markdown artifacts for later consumption

This matches ECC's division of labor more closely:

- `/skill-create`: one repo-level skill
- `/evolve --generate`: multiple evolved skills from instinct clusters

Scope behavior:

- project-only clusters generate into `<project>/.pi/skills|prompts|agents`
- global-only clusters generate into `~/.pi/agent/continuous-learning-v2/evolved/...`

```bash
/agent-run <agent-name-or-path> <task...>
```

`/agent-run` is the explicit manual entrypoint for evolved agent artifacts.

It:

- resolves an agent from `.pi/agents/`, global evolved agents, or an explicit path
- creates an isolated pi SDK session with the agent artifact as the run-specific system prompt
- executes the provided task and returns the final assistant output

This preserves the "manual artifact only" contract while still giving the generated agent files a first-class execution path.

## Prune

```bash
/prune
/prune --dry-run
```

`/prune` removes expired pending instincts only. It does not touch active project or global instincts.

`/instinct-prune` remains available as a separate de-duplication command for active project instincts.

## Validation Snapshot

Recent real-project validation covered:

- `codeql-scanner`: `/skill-create --instincts` followed by `/evolve --generate`
- generated multi-skill outputs such as `tests` and `workspace-manifests`
- real observer validation with active/pending split, resulting in three active atomic instincts and zero pending drafts for the sampled session
- repeatable observer validation script:
  - `npx tsx scripts/observer-validation.mts --mode regression`
  - `npx tsx scripts/observer-validation.mts --mode soak --rounds 3`
- live command validation:
  - `/observer-status`
  - `/agent-run /tmp/ecc-manual-agent.md say hello`
  - `/promote --dry-run` with two project-local copies of the same instinct now reports one promotion candidate
  - `/evolve --generate` with global-only instincts now emits files under `~/.pi/agent/continuous-learning-v2/evolved/...`

The current soak baseline is:

- round 1: learned `3`
- round 2: learned `0`
- round 3: learned `0`

This confirms the observer no longer keeps learning paraphrased duplicates across repeated similar sessions.

Package scripts:

```bash
npm run validate:observer
npm run validate:observer:soak
```

## Notes

- The observer runs inside the active pi process. It does not spawn a detached daemon.
- Evolved commands are generated as pi prompt templates, which makes them native slash commands in pi.
- Evolved agents are generated as markdown artifacts only. They are explicitly marked as manual artifacts and are not auto-executed.
- `continuous-learning-skill-create` messages have a custom renderer in interactive mode.
- `continuous-learning-learn-eval` messages also have a custom renderer in interactive mode.
- Root-level `npm run check` in `pi-mono` is currently blocked by existing `packages/web-ui` issues. Plugin validation is done with submodule-local checks and targeted real-session tests.
