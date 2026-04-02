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
- observer prompts include existing active and pending instincts to reduce near-duplicate learning
- observer output is filtered toward atomic, reusable rules that are easier to evolve into skills

Observer and `skill-create` model selection follow this order:

1. current active session model
2. `~/.pi/agent/settings.json` default model (`defaultProvider` + `defaultModel`)

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

## Notes

- The observer runs inside the active pi process. It does not spawn a detached daemon.
- Evolved commands are generated as pi prompt templates, which makes them native slash commands in pi.
- Evolved agents are generated as markdown artifacts only. They are not auto-executed.
- `continuous-learning-skill-create` messages have a custom renderer in interactive mode.
- Root-level `npm run check` in `pi-mono` is currently blocked by existing `packages/web-ui` issues. Plugin validation is done with submodule-local checks and targeted real-session tests.
