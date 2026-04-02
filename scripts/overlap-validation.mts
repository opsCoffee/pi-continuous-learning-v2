import { fileURLToPath } from "node:url";
import { detectOverlappingSkills } from "../lib/skill-overlap.js";

export interface OverlapValidationResult {
	lateBodyOverlap: {
		detected: boolean;
		score: number;
		matchedPath?: string;
	};
	distinctSkill: {
		detected: boolean;
		score: number;
		matchedPath?: string;
	};
}

function assertValidation(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

export async function runOverlapValidation(): Promise<OverlapValidationResult> {
	const existingSkill = {
		name: "repo-release-workflow",
		description: "Release workflow for repository packaging and verification.",
		filePath: "/tmp/repo-release-workflow/SKILL.md",
		bodyText: [
			"---",
			"name: repo-release-workflow",
			"description: Release workflow for repository packaging and verification.",
			"---",
			"",
			"# Repository Release Workflow",
			"",
			"## Context",
			"This skill explains how to prepare a release without regressing package metadata or validation coverage.",
			"",
			"## Preparation",
			"- Verify the package metadata before touching release files.",
			"- Confirm the repository still passes the targeted validation commands.",
			"",
			"## Execution",
			"Update the package version only after checking the unreleased notes, then regenerate the release-facing docs and validate the package scripts before publishing. Keep the release notes concise and ensure the README examples still reflect the actual command surface.",
			"",
			"## Troubleshooting",
			"If the package metadata changed, re-run the validation flow and inspect the generated docs for drift. If the release notes imply behavior that the package scripts do not expose, fix the documentation before attempting another release.",
		].join("\n"),
	};

	const lateBodyCandidate = [
		"---",
		"name: release-readiness-checklist",
		"description: Checklist for validating release readiness.",
		"---",
		"",
		"# Release Readiness Checklist",
		"",
		"## Intro",
		"This checklist focuses on deciding whether a repository is ready to cut a release build.",
		"",
		"## Execution",
		"Update the package version only after checking the unreleased notes, then regenerate the release-facing docs and validate the package scripts before publishing. Keep the release notes concise and ensure the README examples still reflect the actual command surface.",
		"",
		"## Troubleshooting",
		"If the package metadata changed, re-run the validation flow and inspect the generated docs for drift. If the release notes imply behavior that the package scripts do not expose, fix the documentation before attempting another release.",
	].join("\n");

	const distinctCandidate = [
		"---",
		"name: ui-spacing-rules",
		"description: UI spacing rules for dashboard widgets.",
		"---",
		"",
		"# UI Spacing Rules",
		"",
		"## Layout",
		"Prefer a compact spacing scale for dense dashboards and reserve larger gutters for page-level sections only.",
		"",
		"## Components",
		"Widget headers should align to the same baseline, and secondary actions should stay visually grouped with their owning component.",
	].join("\n");

	const lateBodyMatch = detectOverlappingSkills(lateBodyCandidate, [existingSkill], { limit: 1, threshold: 0.52 })[0];
	const distinctMatch = detectOverlappingSkills(distinctCandidate, [existingSkill], { limit: 1, threshold: 0.52 })[0];

	const result: OverlapValidationResult = {
		lateBodyOverlap: {
			detected: Boolean(lateBodyMatch),
			score: lateBodyMatch?.score ?? 0,
			matchedPath: lateBodyMatch?.filePath,
		},
		distinctSkill: {
			detected: Boolean(distinctMatch),
			score: distinctMatch?.score ?? 0,
			matchedPath: distinctMatch?.filePath,
		},
	};

	assertValidation(result.lateBodyOverlap.detected, "late-body overlap sample was not detected");
	assertValidation(result.lateBodyOverlap.score >= 0.84, "late-body overlap score was lower than expected");
	assertValidation(!result.distinctSkill.detected, "distinct skill sample should not be detected as overlap");

	return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void runOverlapValidation()
		.then((result) => {
			console.log(JSON.stringify(result, null, 2));
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
