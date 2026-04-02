# Changelog

## [Unreleased]

### Added

- Added standalone `/learn-eval` command with save, improve-then-save, absorb, and drop verdicts.
- Added pending instinct staging plus `/prune` and `/prune --dry-run` for TTL-based cleanup.
- Added agentic ECC-style `/skill-create` based on an isolated pi SDK sub-session with restricted native tools.
- Added multi-skill evolution flow that clusters instincts and can emit multiple skills, prompt templates, and agent markdown artifacts.
- Added repeatable observer regression/soak validation script under `scripts/observer-validation.mts`.

### Changed

- Changed `/skill-create --instincts` to prefer smaller, more clusterable repo-analysis instincts for later `/evolve --generate` runs.
- Changed observer generation to include active and pending instinct context, reducing near-duplicate learning and improving instinct atomicity.
- Changed observer scheduling to coalesce event bursts, retry after busy/cooldown skips, and prune pending instincts before analysis.
- Changed `/learn-eval` to use verdict-specific interactive reporting and to apply `MEMORY.md` absorb targets directly.
- Changed evolved agent artifacts to be explicitly marked as manual, non-auto-executed markdown outputs.
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
