# Changelog

## [Unreleased]

### Added

- Added standalone `/learn-eval` command with save, improve-then-save, absorb, and drop verdicts.
- Added pending instinct staging plus `/prune` and `/prune --dry-run` for TTL-based cleanup.
- Added agentic ECC-style `/skill-create` based on an isolated pi SDK sub-session with restricted native tools.
- Added multi-skill evolution flow that clusters instincts and can emit multiple skills, prompt templates, and agent markdown artifacts.
- Added repeatable observer regression/soak validation script under `scripts/observer-validation.mts`.
- Added repeatable scope and overlap validation scripts under `scripts/scope-validation.mts` and `scripts/overlap-validation.mts`.
- Added `/observer-status` for observer runtime visibility and `/agent-run` as an explicit manual execution entrypoint for evolved agent artifacts.

### Changed

- Changed `/skill-create --instincts` to prefer smaller, more clusterable repo-analysis instincts for later `/evolve --generate` runs.
- Changed observer generation to include active and pending instinct context, reducing near-duplicate learning and improving instinct atomicity.
- Changed observer scheduling to coalesce event bursts, retry after busy/cooldown skips, and prune pending instincts before analysis.
- Changed `/learn-eval` to use verdict-specific interactive reporting and to apply `MEMORY.md` absorb targets directly.
- Changed evolved agent artifacts to be explicitly marked as manual, non-auto-executed markdown outputs.
- Changed promotion candidate scanning to read the current project-local `.pi/continuous-learning-v2` storage layout from the registry instead of the legacy `rootDir/projects` layout.
- Changed `/evolve --generate` to emit project/global outputs into the matching evolved directory instead of always writing to the current project.
- Changed overlap detection in `skill-create` and `learn-eval` to use deeper full-text structure matching across headings, actions, sections, paragraphs, and longer body text instead of only short metadata.
- Changed project detection to fall back to `global` scope outside git projects instead of hashing the current directory into a synthetic project.
- Changed project detection to honor `PI_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` as explicit project root overrides.
- Changed observer model selection so `observer.model` is used as a dedicated fallback before the global default model.
- Changed observer processing to archive analyzed observations while preserving new observations appended during analysis.
- Changed `/prune` to scan pending instincts across all registered projects.
- Changed global fallback project-only instinct loading to reuse global instincts instead of returning an empty set.
- Changed `/skill-create --instincts` so global-scope repo-analysis instincts resolve to the global instinct directory.
- Changed documentation to reflect the current pi-native alignment with ECC semantics and the verified multi-skill evolution workflow.

## [0.0.1] - 2026-04-02

### Added

- Initial standalone release of the Continuous Learning v2 plugin for `pi-coding-agent`
- Observation capture from pi extension events
- Project-scoped and global instinct storage
- Background observer analysis using the active session model or the default model from `~/.pi/agent/settings.json`
- Commands:
  - `/instinct-status`
  - `/instinct-export`
  - `/instinct-import`
  - `/promote`
  - `/projects`
  - `/evolve`
  - `/skill-create`
  - `/instinct-prune`
- ECC-style `/skill-create` flow with:
  - git-history sampling
  - README / build config / representative source and test excerpts
  - quality gate checks for overlap with existing skills, instincts, and `MEMORY.md`
  - one-pass `improve-then-save`
  - `absorb` and `drop` verdict handling
- Custom interactive renderer for `continuous-learning-skill-create` messages

### Changed

- Project-scoped state and generated artifacts now default to the project's `.pi/` directory
- Generated skills default to `<project>/.pi/skills/`
- Generated prompts default to `<project>/.pi/prompts/`
- Generated agents default to `<project>/.pi/agents/`

### Notes

- This release intentionally keeps all logic outside `pi-mono` core and ships as a pure extension package.
