import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	analyzeEvolution,
	findPromotionCandidates,
	generateEvolvedOutputs,
	importInstincts,
	loadMergedInstincts,
	loadProjectOnlyInstincts,
	parseInstinctExport,
	renderInstinctExport,
	serializeInstinct,
} from "./instincts.js";
import { resolveActiveOrDefaultModel } from "./model-selection.js";
import { createSkillFromRepository } from "./skill-create.js";
import { loadProjectRegistry, writeTextFile } from "./storage.js";
import type { ProjectInfo, SkillCreateMessageDetails, StorageLayout } from "./types.js";

interface ParsedArgs {
	flags: Map<string, string | true>;
	positionals: string[];
}

function parseArgs(input: string): ParsedArgs {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (const char of input.trim()) {
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) {
		tokens.push(current);
	}

	const flags = new Map<string, string | true>();
	const positionals: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const [name, inlineValue] = token.slice(2).split("=", 2);
		if (inlineValue !== undefined) {
			flags.set(name, inlineValue);
			continue;
		}
		const next = tokens[index + 1];
		if (next && !next.startsWith("--")) {
			flags.set(name, next);
			index++;
		} else {
			flags.set(name, true);
		}
	}
	return { flags, positionals };
}

function formatConfidenceBar(confidence: number): string {
	const filled = Math.max(0, Math.min(10, Math.round(confidence * 10)));
	return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function extractAction(content: string): string {
	const match = content.match(/## Action\s+([\s\S]*?)(?:\n## |\n*$)/u);
	const action = match?.[1]?.trim().split("\n")[0];
	return action && action.length > 0 ? action : "No action recorded";
}

function emitReport(pi: ExtensionAPI, customType: string, content: string): void {
	pi.sendMessage(
		{
			customType,
			content,
			display: true,
		},
		{ triggerTurn: false },
	);
}

function currentProjectLabel(project: ProjectInfo): string {
	return `${project.name} (${project.id})`;
}

async function loadImportSource(source: string, cwd: string): Promise<string> {
	if (source.startsWith("http://") || source.startsWith("https://")) {
		const response = await fetch(source);
		if (!response.ok) {
			throw new Error(`Failed to fetch ${source}: ${response.status}`);
		}
		return response.text();
	}
	return readFile(resolve(cwd, source), "utf-8");
}

export function registerContinuousLearningCommands(
	pi: ExtensionAPI,
	getState: () => {
		project: ProjectInfo | null;
		layout: StorageLayout | null;
	},
): void {
	pi.registerCommand("instinct-status", {
		description: "Show learned instincts for the current project and global scope",
		handler: async (_args, _ctx) => {
			const { project, layout } = getState();
			if (!project || !layout) {
				return;
			}
			const instincts = await loadMergedInstincts(layout);
			const projectInstincts = instincts.filter((instinct) => instinct.scopeLabel === "project");
			const globalInstincts = instincts.filter((instinct) => instinct.scopeLabel === "global");
			const lines = [
				`INSTINCT STATUS - ${instincts.length} total`,
				"",
				`Project: ${currentProjectLabel(project)}`,
				`Project instincts: ${projectInstincts.length}`,
				`Global instincts: ${globalInstincts.length}`,
				"",
			];

			for (const [label, group] of [
				[`PROJECT-SCOPED (${project.name})`, projectInstincts],
				["GLOBAL", globalInstincts],
			] as const) {
				if (group.length === 0) {
					continue;
				}
				lines.push(`## ${label}`);
				for (const instinct of group.sort((left, right) => right.confidence - left.confidence)) {
					lines.push(
						`${formatConfidenceBar(instinct.confidence)} ${Math.round(instinct.confidence * 100)}% ${instinct.id} [${instinct.scopeLabel}]`,
					);
					lines.push(`trigger: ${instinct.trigger}`);
					lines.push(`action: ${extractAction(instinct.content)}`);
					lines.push("");
				}
			}
			emitReport(pi, "continuous-learning-status", lines.join("\n"));
		},
	});

	pi.registerCommand("instinct-export", {
		description: "Export instincts to stdout-like report or a file",
		handler: async (args, _ctx) => {
			const { project, layout } = getState();
			if (!project || !layout) {
				return;
			}
			const parsed = parseArgs(args);
			const scope = typeof parsed.flags.get("scope") === "string" ? String(parsed.flags.get("scope")) : "all";
			const domain = typeof parsed.flags.get("domain") === "string" ? String(parsed.flags.get("domain")) : undefined;
			const minConfidenceRaw = parsed.flags.get("min-confidence");
			const minConfidence = typeof minConfidenceRaw === "string" ? Number.parseFloat(minConfidenceRaw) : undefined;
			const output = typeof parsed.flags.get("output") === "string" ? String(parsed.flags.get("output")) : undefined;

			const instincts = await loadMergedInstincts(layout);
			const filtered = instincts.filter((instinct) => {
				if (scope === "project" && instinct.scopeLabel !== "project") {
					return false;
				}
				if (scope === "global" && instinct.scopeLabel !== "global") {
					return false;
				}
				if (domain && instinct.domain !== domain) {
					return false;
				}
				if (minConfidence !== undefined && instinct.confidence < minConfidence) {
					return false;
				}
				return true;
			});

			const rendered = renderInstinctExport(filtered);
			if (output) {
				const outputPath = resolve(_ctx.cwd, output);
				await writeTextFile(outputPath, rendered);
				emitReport(pi, "continuous-learning-export", `Exported ${filtered.length} instincts to ${outputPath}`);
				return;
			}
			emitReport(pi, "continuous-learning-export", rendered);
		},
	});

	pi.registerCommand("instinct-import", {
		description: "Import instincts from a file or URL",
		handler: async (args, ctx) => {
			const { project, layout } = getState();
			if (!project || !layout) {
				return;
			}
			const parsed = parseArgs(args);
			const source = parsed.positionals[0];
			if (!source) {
				ctx.ui.notify("Usage: /instinct-import <file-or-url> [--scope project|global] [--force]", "warning");
				return;
			}
			const scope = parsed.flags.get("scope") === "global" ? "global" : "project";
			const dryRun = parsed.flags.has("dry-run");
			const force = parsed.flags.has("force");
			const minConfidenceRaw = parsed.flags.get("min-confidence");
			const minConfidence = typeof minConfidenceRaw === "string" ? Number.parseFloat(minConfidenceRaw) : undefined;

			const raw = await loadImportSource(source, ctx.cwd);
			const incoming = parseInstinctExport(raw);
			const summary = await importInstincts(layout, project, source, incoming, scope, minConfidence, true);
			if (!force && ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Import instincts?",
					`Add ${summary.added.length}, update ${summary.updated.length}, skip ${summary.skipped.length}`,
				);
				if (!confirmed) {
					ctx.ui.notify("Import cancelled", "info");
					return;
				}
			}
			const applied = await importInstincts(layout, project, source, incoming, scope, minConfidence, dryRun);
			emitReport(
				pi,
				"continuous-learning-import",
				`Import complete for ${currentProjectLabel(project)}\nAdded: ${applied.added.length}\nUpdated: ${applied.updated.length}\nSkipped: ${applied.skipped.length}${dryRun ? "\n[DRY RUN]" : ""}`,
			);
		},
	});

	pi.registerCommand("promote", {
		description: "Promote project instincts to global scope",
		handler: async (args, ctx) => {
			const { layout } = getState();
			if (!layout) {
				return;
			}
			const parsed = parseArgs(args);
			const instinctId = parsed.positionals[0];
			const dryRun = parsed.flags.has("dry-run");
			const force = parsed.flags.has("force");
			let targetCandidates = await findPromotionCandidates(layout);
			if (instinctId) {
				const projectInstincts = await loadProjectOnlyInstincts(layout);
				const specific = projectInstincts.find((instinct) => instinct.id === instinctId);
				targetCandidates = specific
					? [
							{
								id: specific.id,
								entries: [specific],
								averageConfidence: specific.confidence,
							},
						]
					: [];
			}

			if (targetCandidates.length === 0) {
				ctx.ui.notify("No promotion candidates found", "info");
				return;
			}
			if (!force && ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Promote instincts?",
					targetCandidates
						.map((candidate) => `${candidate.id} (${Math.round(candidate.averageConfidence * 100)}%)`)
						.join("\n"),
				);
				if (!confirmed) {
					ctx.ui.notify("Promotion cancelled", "info");
					return;
				}
			}

			if (!dryRun) {
				for (const candidate of targetCandidates) {
					const best = [...candidate.entries].sort((left, right) => right.confidence - left.confidence)[0];
					await writeTextFile(
						join(layout.globalPersonalDir, `${candidate.id}.md`),
						serializeInstinct({
							...best,
							scope: "global",
							projectId: undefined,
							projectName: undefined,
							promotedFrom: best.scopeLabel === "project" ? best.projectId : undefined,
						}),
					);
				}
			}

			emitReport(
				pi,
				"continuous-learning-promote",
				`Promotion candidates: ${targetCandidates.length}${dryRun ? "\n[DRY RUN]" : ""}\n${targetCandidates.map((candidate) => `- ${candidate.id} (${Math.round(candidate.averageConfidence * 100)}%)`).join("\n")}`,
			);
		},
	});

	pi.registerCommand("projects", {
		description: "List known projects and instinct statistics",
		handler: async (_args, _ctx) => {
			const { layout } = getState();
			if (!layout) {
				return;
			}
			const registry = await loadProjectRegistry(layout);
			const lines = ["KNOWN PROJECTS", ""];
			for (const entry of Object.values(registry).sort((left, right) =>
				right.lastSeen.localeCompare(left.lastSeen),
			)) {
				lines.push(`${entry.name} [${entry.id}]`);
				lines.push(`root: ${entry.root}`);
				if (entry.remote) {
					lines.push(`remote: ${entry.remote}`);
				}
				lines.push(`last seen: ${entry.lastSeen}`);
				lines.push("");
			}
			emitReport(pi, "continuous-learning-projects", lines.join("\n"));
		},
	});

	pi.registerCommand("evolve", {
		description: "Analyze instincts and generate evolved skills, prompts, and agent specs",
		handler: async (args, ctx) => {
			const { project, layout } = getState();
			if (!project || !layout) {
				return;
			}
			const parsed = parseArgs(args);
			const generate = parsed.flags.has("generate");
			const instincts = await loadMergedInstincts(layout);
			const analysis = analyzeEvolution(instincts);
			let generated: string[] = [];
			if (generate) {
				generated = await generateEvolvedOutputs(layout, analysis);
				if (ctx.hasUI) {
					await ctx.reload();
				}
			}
			const lines = [
				`EVOLVE ANALYSIS - ${instincts.length} instincts`,
				`Project: ${currentProjectLabel(project)}`,
				"",
				`Skill candidates: ${analysis.skillCandidates.length}`,
				`Prompt candidates: ${analysis.promptCandidates.length}`,
				`Agent candidates: ${analysis.agentCandidates.length}`,
			];
			if (analysis.skillCandidates.length > 0) {
				lines.push("", "## Skill candidates");
				for (const candidate of analysis.skillCandidates.slice(0, 5)) {
					lines.push(
						`- ${candidate.key}: ${candidate.instincts.length} instincts, avg ${Math.round(candidate.averageConfidence * 100)}%`,
					);
				}
			}
			if (generate) {
				lines.push("", `Generated files: ${generated.length}`);
				for (const filePath of generated) {
					lines.push(`- ${filePath}`);
				}
			}
			emitReport(pi, "continuous-learning-evolve", lines.join("\n"));
		},
	});

	pi.registerCommand("skill-create", {
		description:
			"Analyze git history and generate a repository skill; use --instincts to also write repo-analysis instincts",
		handler: async (args, ctx) => {
			const { project, layout } = getState();
			if (!project || !layout) {
				return;
			}

			const parsed = parseArgs(args);
			const commitsRaw = parsed.flags.get("commits");
			const commits = typeof commitsRaw === "string" ? Math.max(1, Number.parseInt(commitsRaw, 10) || 200) : 200;
			const output = typeof parsed.flags.get("output") === "string" ? String(parsed.flags.get("output")) : undefined;
			const includeInstincts = parsed.flags.has("instincts");
			const resolvedModel = await resolveActiveOrDefaultModel(ctx.model, ctx.modelRegistry);
			const model = resolvedModel.model;

			let llm:
				| {
						model: NonNullable<typeof model>;
						apiKey: string;
						headers?: Record<string, string>;
						modelRegistry: typeof ctx.modelRegistry;
				  }
				| undefined;
			if (model) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (auth.ok && auth.apiKey) {
					llm = {
						model,
						apiKey: auth.apiKey,
						headers: auth.headers,
						modelRegistry: ctx.modelRegistry,
					};
				}
			}

			try {
				const result = await createSkillFromRepository({
					cwd: ctx.cwd,
					project,
					layout,
					commits,
					output,
					includeInstincts,
					llm,
				});

				if (ctx.hasUI && (!output || result.skillPath.startsWith(layout.projectEvolvedSkillsDir))) {
					await ctx.reload();
				}

				const details: SkillCreateMessageDetails = {
					repoName: project.name,
					commitCount: result.commitCount,
					generationMode: result.generationMode,
					llmStatus: result.llmStatus,
					modelLabel: llm ? `${llm.model.provider}/${llm.model.id}` : undefined,
					modelSource: resolvedModel.source,
					skillPath: result.skillPath,
					instinctPaths: result.instinctPaths,
					prefixes: result.prefixes,
					representativeFiles: result.representativeFiles,
					quality: result.quality,
				};

				pi.sendMessage({
					customType: "continuous-learning-skill-create",
					content: `${result.summary}${llm ? `\n使用模型: ${llm.model.provider}/${llm.model.id}` : "\n使用模型: none"}${includeInstincts ? `\n--instincts 已启用` : ""}`,
					display: true,
					details: ctx.hasUI ? details : undefined,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`skill-create 失败: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("instinct-prune", {
		description: "Prune obvious duplicate or superseded project instincts generated by repo analysis",
		handler: async (_args, ctx) => {
			const { layout } = getState();
			if (!layout) {
				return;
			}

			const instincts = await loadProjectOnlyInstincts(layout);
			const byId = new Map(instincts.map((instinct) => [instinct.id, instinct]));
			const pruneTargets: string[] = [];

			if (byId.has("detsql-commit-convention") && byId.has("conventional-commit-scopes")) {
				pruneTargets.push("detsql-commit-convention");
			}

			if (pruneTargets.length === 0) {
				ctx.ui.notify("没有发现可安全裁剪的重复 instinct", "info");
				return;
			}

			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm("Prune instincts?", pruneTargets.map((id) => `- ${id}`).join("\n"));
				if (!confirmed) {
					ctx.ui.notify("裁剪已取消", "info");
					return;
				}
			}

			const removed: string[] = [];
			for (const instinctId of pruneTargets) {
				const instinct = byId.get(instinctId);
				if (!instinct) {
					continue;
				}
				await rm(instinct.filePath, { force: true });
				removed.push(instinctId);
			}

			emitReport(
				pi,
				"continuous-learning-instinct-prune",
				`已裁剪 ${removed.length} 个 project instinct\n${removed.map((id) => `- ${id}`).join("\n")}`,
			);
		},
	});
}
