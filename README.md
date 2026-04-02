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
- instinct management commands
- evolved skills and prompt templates

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
- `/instinct-prune`

## Storage

Project-scoped state and generated artifacts now default to the current project's `.pi/` directory.

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
- a `learn-eval`-style quality gate that checks overlap with existing skills, existing instincts, and MEMORY.md before saving
- a generic local fallback summarizer when the active/default model cannot produce usable artifacts

`/skill-create` may return these quality verdicts:

- `save`
- `improve-then-save`
- `absorb`
- `drop`

Verdict behavior:

- `save`: writes the skill and optional instincts
- `improve-then-save`: performs one automatic revision pass, then re-evaluates before saving
- `absorb`: does not write a new skill; returns absorb target and appendable content suggestion
- `drop`: does not write a new skill

## Notes

- The observer runs inside the active pi process. It does not spawn a detached daemon.
- Evolved commands are generated as pi prompt templates, which makes them native slash commands in pi.
- Evolved agents are generated as markdown artifacts only. They are not auto-executed.
- `continuous-learning-skill-create` messages have a custom renderer in interactive mode.
