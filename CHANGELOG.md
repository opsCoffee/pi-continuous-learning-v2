# Changelog

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
