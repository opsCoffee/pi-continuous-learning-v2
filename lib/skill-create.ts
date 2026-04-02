import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { complete, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { getAgentDir, loadSkills, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { loadProjectOnlyInstincts, serializeInstinct } from "./instincts.js";
import { writeTextFile } from "./storage.js";
import type { ProjectInfo, SkillCreateQualityReport, StorageLayout } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_COMMIT_SAMPLES = 8;
const MAX_SOURCE_FILES = 4;
const MAX_TEST_FILES = 3;
const MAX_DOC_FILES = 2;
const MAX_FILE_CHARS = 2800;
const MAX_README_CHARS = 5000;

const NOISE_PREFIXES = [
	".agent/",
	".git/",
	".pi/",
	"docs/superpowers/plans/",
	"docs/plans/",
	"target/",
	"node_modules/",
];

const NOISE_FILE_NAMES = new Set(["commit.log", "prompt.md", "gemini.md"]);

const SKILL_CREATE_SYSTEM_PROMPT = `You generate high-quality repository skills for a coding agent.

You will receive repository metadata, commit history summaries, and representative file excerpts.

Return exactly two sections:

<skill_markdown>
...full SKILL.md content including frontmatter...
</skill_markdown>

<instincts_json>
[
  {
    "id": "kebab-case-id",
    "title": "Short title",
    "trigger": "when ...",
    "confidence": 0.75,
    "domain": "git",
    "scope": "project",
    "action": "One concrete sentence",
    "evidence": ["short bullet", "short bullet"]
  }
]
</instincts_json>

<quality_json>
{
  "verdict": "save | improve-then-save | absorb | drop",
  "rationale": "1-2 sentence rationale",
  "checklist": [
    "skills overlap: ...",
    "memory overlap: ...",
    "append vs new file: ...",
    "reusability: ..."
  ],
  "absorbTarget": "optional existing skill path or MEMORY.md",
  "improvements": ["optional improvement", "optional improvement"]
}
</quality_json>

Rules:
- Focus on actual repository conventions, not meta noise
- Ignore .agent, scratch logs, temporary planning docs, and generated clutter unless they directly shape implementation
- Use evidence from README, build config, representative source files, tests, and repeated commit patterns
- skillMarkdown must be a valid SKILL.md with YAML frontmatter including name and description
- The skill should teach practical repository-specific behavior, not generic best practices
- Prefer concise, high-signal sections over long summaries
- If confidence is low, reduce the number of instincts instead of inventing weak ones

Internal quality gate checklist:
- Check overlap against the provided existing skills list before creating a new skill
- Check overlap against the provided existing instincts list before creating new instincts
- Confirm the result is reusable and not a one-off fix
- If overlap exists, absorb/update instead of duplicating
- Prefer Save, but if the draft is weak or redundant, improve it once internally or drop low-value instincts before output`;

interface CommitEntry {
	hash: string;
	subject: string;
	date: string;
	files: string[];
}

interface FileCount {
	path: string;
	count: number;
}

interface FileExcerpt {
	path: string;
	content: string;
}

interface SkillCreateLlmContext {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
}

export interface SkillCreateOptions {
	cwd: string;
	project: ProjectInfo;
	layout: StorageLayout;
	commits: number;
	output?: string;
	includeInstincts: boolean;
	llm?: SkillCreateLlmContext;
}

export interface SkillCreateResult {
	skillPath: string;
	instinctPaths: string[];
	summary: string;
	generationMode: "LLM" | "fallback";
	llmStatus: string;
	quality: SkillCreateQualityReport;
	commitCount: number;
	prefixes: string[];
	representativeFiles: string[];
}

interface LlmInstinctDraft {
	id: string;
	title: string;
	trigger: string;
	confidence: number;
	domain: string;
	scope: "project" | "global";
	action: string;
	evidence: string[];
}

interface LlmSkillCreateResult {
	skillMarkdown: string;
	instincts: LlmInstinctDraft[];
	quality?: Partial<SkillCreateQualityReport>;
}

interface ExistingSkillSummary {
	name: string;
	description: string;
	filePath: string;
}

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		timeout: 20000,
		maxBuffer: 8 * 1024 * 1024,
	});
	return stdout.trim();
}

function isNoisePath(path: string): boolean {
	if (NOISE_FILE_NAMES.has(basename(path))) {
		return true;
	}
	return NOISE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isInterestingSourceFile(path: string): boolean {
	return path.startsWith("src/main/") && (path.endsWith(".java") || path.endsWith(".kt"));
}

function isInterestingTestFile(path: string): boolean {
	return path.startsWith("src/test/") && (path.endsWith(".java") || path.endsWith(".kt"));
}

function isInterestingDocFile(path: string): boolean {
	if (isNoisePath(path)) {
		return false;
	}
	return path === "README.md" || path === "CHANGELOG.md" || path === "pom.xml" || path === "docs/README.md";
}

async function collectGitHistory(repoRoot: string, commits: number): Promise<CommitEntry[]> {
	const output = await git(
		[
			"-C",
			repoRoot,
			"log",
			"--name-only",
			"-n",
			String(commits),
			"--pretty=format:__COMMIT__%n%H|%s|%ad",
			"--date=short",
		],
		repoRoot,
	);
	const lines = output.split("\n");
	const entries: CommitEntry[] = [];
	let current: CommitEntry | null = null;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === "__COMMIT__") {
			if (current) {
				entries.push(current);
			}
			current = null;
			continue;
		}
		if (!current) {
			if (!line.includes("|")) {
				continue;
			}
			const [hash, subject, date] = line.split("|", 3);
			current = {
				hash,
				subject,
				date,
				files: [],
			};
			continue;
		}
		if (line.length > 0 && !isNoisePath(line)) {
			current.files.push(line);
		}
	}

	if (current) {
		entries.push(current);
	}
	return entries;
}

function summarizeCommitPrefixes(entries: CommitEntry[]): Array<{ prefix: string; count: number }> {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		const match = entry.subject.match(/^([a-z]+)(\([^)]+\))?!?:/u);
		if (!match) {
			continue;
		}
		const prefix = match[1];
		counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([prefix, count]) => ({ prefix, count }))
		.sort((left, right) => right.count - left.count)
		.slice(0, 10);
}

function countFiles(entries: CommitEntry[], predicate: (path: string) => boolean): FileCount[] {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		for (const path of entry.files) {
			if (!predicate(path)) {
				continue;
			}
			counts.set(path, (counts.get(path) ?? 0) + 1);
		}
	}
	return Array.from(counts.entries())
		.map(([path, count]) => ({ path, count }))
		.sort((left, right) => right.count - left.count);
}

async function readExcerpt(repoRoot: string, relativePath: string, maxChars: number): Promise<FileExcerpt | null> {
	try {
		const absolutePath = join(repoRoot, relativePath);
		const content = await readFile(absolutePath, "utf-8");
		return {
			path: relativePath,
			content: content.slice(0, maxChars),
		};
	} catch {
		return null;
	}
}

async function readRepresentativeFiles(
	repoRoot: string,
	files: FileCount[],
	limit: number,
	maxChars: number,
): Promise<FileExcerpt[]> {
	const excerpts: FileExcerpt[] = [];
	for (const file of prioritizeFiles(files).slice(0, limit)) {
		const excerpt = await readExcerpt(repoRoot, file.path, maxChars);
		if (excerpt) {
			excerpts.push(excerpt);
		}
	}
	return excerpts;
}

function prioritizeFiles(files: FileCount[]): FileCount[] {
	const score = (path: string): number => {
		let total = 0;
		if (path.includes("/core/")) total += 20;
		if (path.includes("/scan/")) total += 18;
		if (path.includes("/config/")) total += 16;
		if (path.includes("/ui/")) total += 12;
		if (path.includes("DetSql.java")) total += 30;
		if (path.includes("ScannerService.java")) total += 28;
		if (path.includes("ConfigManager.java")) total += 24;
		if (path.includes("DetSqlUI.java")) total += 18;
		if (path.includes("Logger")) total += 10;
		if (path.includes("IntegrationTest")) total += 16;
		if (path.includes("Test.java")) total += 10;
		return total;
	};

	return [...files].sort((left, right) => {
		const scoreDelta = score(right.path) - score(left.path);
		if (scoreDelta !== 0) {
			return scoreDelta;
		}
		return right.count - left.count;
	});
}

function buildCommitSamples(entries: CommitEntry[]): string[] {
	return entries.slice(0, MAX_COMMIT_SAMPLES).map((entry) => {
		const files = entry.files.slice(0, 12);
		return [`${entry.date} ${entry.subject}`, ...files.map((file) => `  - ${file}`)].join("\n");
	});
}

function buildPrompt(
	project: ProjectInfo,
	readme: string,
	pom: string,
	prefixes: Array<{ prefix: string; count: number }>,
	commitSamples: string[],
	sourceExcerpts: FileExcerpt[],
	testExcerpts: FileExcerpt[],
	docExcerpts: FileExcerpt[],
	existingSkills: ExistingSkillSummary[],
	existingInstincts: Array<{ id: string; title: string; trigger: string; domain: string }>,
	projectMemory: string,
	globalMemory: string,
): string {
	const sections: string[] = [];

	sections.push(`Repository: ${project.name}`);
	sections.push(`Project ID: ${project.id}`);
	if (project.remote) {
		sections.push(`Remote: ${project.remote}`);
	}

	sections.push("\n[README]");
	sections.push(readme || "(missing)");

	sections.push("\n[BUILD CONFIG]");
	sections.push(pom || "(missing)");

	sections.push("\n[COMMIT PREFIX SUMMARY]");
	sections.push(
		prefixes.length > 0
			? prefixes.map((item) => `- ${item.prefix}: ${item.count}`).join("\n")
			: "(no stable commit prefix summary)",
	);

	sections.push("\n[RECENT COMMIT SAMPLES]");
	sections.push(commitSamples.join("\n\n"));

	const appendExcerpts = (title: string, excerpts: FileExcerpt[]) => {
		sections.push(`\n[${title}]`);
		if (excerpts.length === 0) {
			sections.push("(none)");
			return;
		}
		for (const excerpt of excerpts) {
			sections.push(`FILE: ${excerpt.path}`);
			sections.push("```");
			sections.push(excerpt.content);
			sections.push("```");
		}
	};

	appendExcerpts("REPRESENTATIVE SOURCE FILES", sourceExcerpts);
	appendExcerpts("REPRESENTATIVE TEST FILES", testExcerpts);
	appendExcerpts("REPRESENTATIVE DOC FILES", docExcerpts);

	sections.push("\n[EXISTING SKILLS]");
	sections.push(
		existingSkills.length > 0
			? existingSkills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`).join("\n")
			: "(none)",
	);

	sections.push("\n[EXISTING INSTINCTS]");
	sections.push(
		existingInstincts.length > 0
			? existingInstincts.map((instinct) => `- ${instinct.id}: ${instinct.trigger} [${instinct.domain}]`).join("\n")
			: "(none)",
	);

	sections.push("\n[PROJECT MEMORY]");
	sections.push(projectMemory || "(missing)");

	sections.push("\n[GLOBAL MEMORY]");
	sections.push(globalMemory || "(missing)");

	sections.push(`
[TASK]
Generate:
1. a repository-specific SKILL.md that teaches the coding agent how to work in this repo
2. up to 3 high-signal project-scoped instincts derived from repository evidence

The skill should emphasize:
- actual architecture and module boundaries
- build/test/release workflow
- coding and testing conventions
- repository-specific safety rules

Do not focus on meta planning files or agent scratch artifacts.`);

	return sections.join("\n");
}

function extractJsonPayload(text: string): string | null {
	const fenced = text.match(/```json\s*([\s\S]*?)```/u)?.[1];
	if (fenced) {
		return fenced.trim();
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) {
		return text.slice(start, end + 1);
	}
	return null;
}

function extractTaggedSection(text: string, tag: string): string | null {
	const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "u"));
	return match?.[1]?.trim() ?? null;
}

function parseQualityVerdict(value: unknown): SkillCreateQualityReport["verdict"] | undefined {
	return value === "save" || value === "improve-then-save" || value === "absorb" || value === "drop"
		? value
		: undefined;
}

function validateQualityReport(value: unknown): Partial<SkillCreateQualityReport> | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const verdict = parseQualityVerdict(record.verdict);
	if (!verdict) {
		return undefined;
	}
	return {
		verdict,
		rationale: typeof record.rationale === "string" ? record.rationale.trim() : "",
		checklist: Array.isArray(record.checklist)
			? record.checklist.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			: [],
		absorbTarget:
			typeof record.absorbTarget === "string" && record.absorbTarget.trim().length > 0
				? record.absorbTarget.trim()
				: undefined,
		improvements: Array.isArray(record.improvements)
			? record.improvements.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			: [],
	};
}

function normalizeSkillMarkdown(markdown: string, project: ProjectInfo): string {
	let raw = markdown.trim();
	raw = raw.replace(/^<skill_markdown>\s*/u, "").replace(/\s*<\/skill_markdown>\s*$/u, "");
	const instinctsSectionIndex = raw.indexOf("<instincts_json>");
	if (instinctsSectionIndex >= 0) {
		raw = raw.slice(0, instinctsSectionIndex).trim();
	}
	if (!raw) {
		return "";
	}
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
	const skillName = `${project.name.toLowerCase()}-patterns`.replace(/[^a-z0-9-]+/gu, "-");
	const description =
		typeof frontmatter.description === "string" && frontmatter.description.trim().length > 0
			? frontmatter.description.trim()
			: `Coding patterns extracted from ${project.name}`;
	const lines = [
		"---",
		`name: ${skillName}`,
		`description: ${description}`,
		"version: 1.0.0",
		"source: local-git-analysis",
		"---",
		"",
		body.trim(),
	];
	return lines.join("\n");
}

function validateInstinctDraft(value: unknown): LlmInstinctDraft | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.trigger !== "string" || typeof record.action !== "string") {
		return null;
	}
	return {
		id: record.id.trim(),
		title:
			typeof record.title === "string" && record.title.trim().length > 0 ? record.title.trim() : record.id.trim(),
		trigger: record.trigger.trim(),
		confidence:
			typeof record.confidence === "number"
				? record.confidence
				: Number.parseFloat(String(record.confidence ?? "0.6")),
		domain: typeof record.domain === "string" && record.domain.trim().length > 0 ? record.domain.trim() : "general",
		scope: record.scope === "global" ? "global" : "project",
		action: record.action.trim(),
		evidence: Array.isArray(record.evidence)
			? record.evidence
					.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
					.slice(0, 5)
			: [],
	};
}

function parseLlmResult(text: string, project: ProjectInfo): LlmSkillCreateResult | null {
	const taggedSkill = extractTaggedSection(text, "skill_markdown");
	const taggedInstincts = extractTaggedSection(text, "instincts_json");
	const taggedQuality = extractTaggedSection(text, "quality_json");

	if (taggedSkill) {
		let instincts: LlmInstinctDraft[] = [];
		let quality: Partial<SkillCreateQualityReport> | undefined;
		if (taggedInstincts) {
			try {
				const parsed = JSON.parse(taggedInstincts) as unknown[];
				instincts = parsed.map(validateInstinctDraft).filter((draft): draft is LlmInstinctDraft => Boolean(draft));
			} catch {}
		}
		if (taggedQuality) {
			try {
				quality = validateQualityReport(JSON.parse(taggedQuality));
			} catch {}
		}
		return {
			skillMarkdown: normalizeSkillMarkdown(taggedSkill, project),
			instincts,
			quality,
		};
	}

	const payload = extractJsonPayload(text);
	if (payload) {
		try {
			const parsed = JSON.parse(payload) as {
				skillMarkdown?: unknown;
				instincts?: unknown[];
			};
			if (typeof parsed.skillMarkdown === "string" && parsed.skillMarkdown.trim().length > 0) {
				const instincts = Array.isArray(parsed.instincts)
					? parsed.instincts
							.map(validateInstinctDraft)
							.filter((draft): draft is LlmInstinctDraft => Boolean(draft))
					: [];
				return {
					skillMarkdown: normalizeSkillMarkdown(parsed.skillMarkdown, project),
					instincts,
					quality: validateQualityReport((parsed as Record<string, unknown>).quality),
				};
			}
		} catch {}
	}

	if (text.includes("---") && text.includes("# ")) {
		return {
			skillMarkdown: normalizeSkillMarkdown(text, project),
			instincts: [],
		};
	}
	return null;
}

function buildFallbackSkillMarkdown(
	project: ProjectInfo,
	prefixes: Array<{ prefix: string; count: number }>,
	sourceFiles: FileCount[],
	testFiles: FileCount[],
	entries: CommitEntry[],
	readme: string,
	pom: string,
): string {
	const skillName = `${project.name.toLowerCase()}-patterns`.replace(/[^a-z0-9-]+/gu, "-");
	const architectureLines = summarizeArchitecture(sourceFiles);
	const workflowLines = summarizeWorkflows(entries);
	const testingLines = summarizeTestingPatterns(testFiles);
	const buildLines = summarizeBuildConventions(readme, pom);
	return [
		"---",
		`name: ${skillName}`,
		`description: Coding patterns extracted from ${project.name}`,
		"version: 1.0.0",
		"source: local-git-analysis",
		"---",
		"",
		`# ${project.name} Patterns`,
		"",
		"## Commit Conventions",
		...(prefixes.length > 0
			? prefixes.map((item) => `- \`${item.prefix}:\` 提交前缀高频出现 ${item.count} 次`)
			: ["- 未检测到稳定的提交前缀约定。"]),
		"",
		"## Build And Runtime",
		...buildLines,
		"",
		"## Code Architecture",
		...architectureLines,
		"",
		"## Workflows",
		...workflowLines,
		"",
		"## Testing Patterns",
		...testingLines,
	].join("\n");
}

function summarizeBuildConventions(readme: string, pom: string): string[] {
	const lines: string[] = [];
	if (pom.includes("<java.version>17</java.version>")) {
		lines.push("- 构建与运行环境基于 Java 17。");
	}
	if (pom.includes("<artifactId>maven-shade-plugin</artifactId>")) {
		lines.push("- 使用 Maven Shade 产出单一可分发 JAR。");
	}
	if (pom.includes("<artifactId>jacoco-maven-plugin</artifactId>")) {
		lines.push("- 通过 JaCoCo 维护覆盖率门槛。");
	}
	if (pom.includes("<artifactId>dependency-check-maven</artifactId>")) {
		lines.push("- 依赖安全扫描通过 OWASP Dependency-Check 按需执行。");
	}
	if (pom.includes("montoya-api") || readme.includes("Montoya API")) {
		lines.push("- Burp 扩展开发统一基于 Montoya API，而非旧 Extender API。");
	}
	if (lines.length === 0) {
		lines.push("- 构建约定需以仓库当前 build 配置为准。");
	}
	return lines;
}

function summarizeArchitecture(sourceFiles: FileCount[]): string[] {
	const moduleDescriptions = new Map<string, string>([
		["core", "扩展生命周期、调度、归档、回调安全与主流程协调"],
		["scan", "扫描入口、插入点与扫描服务编排"],
		["injection", "各类注入策略及策略管理"],
		["config", "配置模型、Schema、默认值与设置面板工厂"],
		["ui", "Burp 面板、标签页、绑定与界面辅助"],
		["util", "字符串、响应分析、签名与通用工具"],
		["events", "事件总线与异步事件传播"],
		["logging", "统一日志与日志级别控制"],
		["model", "表格模型与归档模型"],
	]);

	const modules = new Map<string, number>();
	for (const file of sourceFiles) {
		const match = file.path.match(/^src\/main\/java\/DetSql\/([^/]+)\//u);
		if (!match) {
			continue;
		}
		const moduleName = match[1];
		modules.set(moduleName, (modules.get(moduleName) ?? 0) + file.count);
	}

	const lines = Array.from(modules.entries())
		.sort((left, right) => right[1] - left[1])
		.slice(0, 8)
		.map(([moduleName]) => {
			const description = moduleDescriptions.get(moduleName) ?? "仓库中的一个稳定模块边界";
			return `- \`${moduleName}/\`：${description}。`;
		});

	return lines.length > 0 ? lines : ["- 暂未提炼出稳定源码结构。"];
}

function summarizeWorkflows(entries: CommitEntry[]): string[] {
	let scanAndTest = 0;
	let configAndUi = 0;
	let docsAndAgent = 0;

	for (const entry of entries) {
		const hasScan = entry.files.some((file) => file.startsWith("src/main/java/DetSql/scan/"));
		const hasCore = entry.files.some((file) => file.startsWith("src/main/java/DetSql/core/"));
		const hasConfig = entry.files.some((file) => file.startsWith("src/main/java/DetSql/config/"));
		const hasUi = entry.files.some((file) => file.startsWith("src/main/java/DetSql/ui/"));
		const hasTests = entry.files.some((file) => file.startsWith("src/test/java/"));
		const hasAgent = entry.files.some((file) => file.startsWith(".agent/"));
		const hasDocs = entry.files.some(
			(file) => file.startsWith("docs/") || file === "README.md" || file === "CHANGELOG.md",
		);

		if ((hasScan || hasCore) && hasTests) {
			scanAndTest++;
		}
		if (hasConfig && hasUi) {
			configAndUi++;
		}
		if (hasDocs && hasAgent) {
			docsAndAgent++;
		}
	}

	const lines: string[] = [];
	if (scanAndTest >= 2) {
		lines.push("- 修改扫描核心或主流程时，通常会同步补充集成测试/回归测试。");
	}
	if (configAndUi >= 2) {
		lines.push("- 调整配置模型时，通常会同时更新设置面板或 UI 行为。");
	}
	if (docsAndAgent >= 2) {
		lines.push("- 较大改动往往伴随 `.agent/` 记录与文档更新。");
	}
	return lines.length > 0 ? lines : ["- 暂未发现稳定的提交级工作流。"];
}

function summarizeTestingPatterns(testFiles: FileCount[]): string[] {
	const hasIntegration = testFiles.some((file) => file.path.includes("IntegrationTest"));
	const hasConcurrency = testFiles.some(
		(file) => file.path.includes("Concurrency") || file.path.includes("Backpressure"),
	);
	const hasConfig = testFiles.some((file) => file.path.includes("/config/"));
	const hasUi = testFiles.some((file) => file.path.includes("/ui/"));
	const lines: string[] = [];

	if (hasIntegration) {
		lines.push("- 测试不仅覆盖单元测试，还大量使用 `*IntegrationTest` 验证流程级行为。");
	}
	if (hasConcurrency) {
		lines.push("- 并发、背压和事件时序是重点回归面，相关测试命名明确。");
	}
	if (hasConfig) {
		lines.push("- 配置兼容、保存与加载路径有独立测试覆盖。");
	}
	if (hasUi) {
		lines.push("- UI 行为和设置面板也有专门测试，而不是只测核心逻辑。");
	}
	if (lines.length === 0) {
		lines.push("- 暂未提炼出稳定测试结构。");
	}
	return lines;
}

function buildFallbackInstincts(
	project: ProjectInfo,
	prefixes: Array<{ prefix: string; count: number }>,
	testFiles: FileCount[],
): LlmInstinctDraft[] {
	const repoSlug = project.name.toLowerCase().replace(/[^a-z0-9-]+/gu, "-");
	const instincts: LlmInstinctDraft[] = [];

	if (prefixes.length > 0) {
		instincts.push({
			id: `${repoSlug}-commit-convention`,
			title: "Use Repository Commit Convention",
			trigger: "when writing a commit message",
			confidence: 0.8,
			domain: "git",
			scope: "project",
			action: "优先沿用仓库中高频出现的约定式提交前缀。",
			evidence: prefixes.slice(0, 4).map((item) => `提交前缀 ${item.prefix}: 出现 ${item.count} 次`),
		});
	}

	if (testFiles.length > 0) {
		instincts.push({
			id: `${repoSlug}-test-conventions`,
			title: "Follow Repository Test Conventions",
			trigger: "when adding or modifying tests",
			confidence: 0.7,
			domain: "testing",
			scope: "project",
			action: "测试文件优先沿用仓库现有目录结构和命名风格。",
			evidence: testFiles.slice(0, 4).map((file) => `高频测试文件 ${file.path}（${file.count} 次）`),
		});
	}

	return instincts;
}

function normalizeForCompare(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/gu, " ")
		.trim();
}

function tokenize(value: string): Set<string> {
	return new Set(
		normalizeForCompare(value)
			.split(/\s+/u)
			.filter((token) => token.length > 1),
	);
}

function overlapScore(left: string, right: string): number {
	const leftTokens = tokenize(left);
	const rightTokens = tokenize(right);
	if (leftTokens.size === 0 || rightTokens.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) {
			intersection++;
		}
	}
	return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function dedupeInstinctDrafts(
	drafts: LlmInstinctDraft[],
	existingInstincts: Array<{ id: string; title: string; trigger: string; domain: string }>,
): { drafts: LlmInstinctDraft[]; droppedIds: string[] } {
	const sorted = [...drafts].sort(
		(left, right) => right.confidence - left.confidence || right.action.length - left.action.length,
	);
	const kept: LlmInstinctDraft[] = [];
	const droppedIds: string[] = [];

	for (const draft of sorted) {
		if (draft.confidence < 0.65) {
			droppedIds.push(draft.id);
			continue;
		}

		const genericAction = normalizeForCompare(draft.action);
		const genericTitle = normalizeForCompare(draft.title);
		const hasOverlapWithExisting = existingInstincts.some((existing) => {
			if (existing.id === draft.id) {
				return true;
			}
			if (existing.domain !== draft.domain) {
				return false;
			}
			return (
				overlapScore(existing.trigger, draft.trigger) >= 0.6 ||
				overlapScore(existing.title, draft.title) >= 0.6 ||
				overlapScore(existing.trigger, genericAction) >= 0.6 ||
				overlapScore(existing.title, genericAction) >= 0.6
			);
		});
		if (hasOverlapWithExisting) {
			droppedIds.push(draft.id);
			continue;
		}

		const hasOverlapWithKept = kept.some((existing) => {
			if (existing.domain !== draft.domain) {
				return false;
			}
			return (
				overlapScore(existing.trigger, draft.trigger) >= 0.6 ||
				overlapScore(existing.title, draft.title) >= 0.6 ||
				overlapScore(existing.action, genericAction) >= 0.65 ||
				overlapScore(existing.action, genericTitle) >= 0.65
			);
		});
		if (hasOverlapWithKept) {
			droppedIds.push(draft.id);
			continue;
		}

		kept.push(draft);
	}

	return {
		drafts: kept.slice(0, 3),
		droppedIds,
	};
}

async function loadExistingSkills(projectRoot: string, outputSkillPath: string): Promise<ExistingSkillSummary[]> {
	const skills = loadSkills({ cwd: projectRoot }).skills;
	return skills
		.filter((skill) => skill.filePath !== outputSkillPath)
		.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
		}));
}

async function readOptionalText(filePath: string, maxChars: number): Promise<string> {
	try {
		const content = await readFile(filePath, "utf-8");
		return content.slice(0, maxChars);
	} catch {
		return "";
	}
}

function buildQualityReport(
	skillMarkdown: string,
	existingSkills: ExistingSkillSummary[],
	droppedInstinctIds: string[],
	projectMemory: string,
	globalMemory: string,
	llmQuality?: Partial<SkillCreateQualityReport>,
): SkillCreateQualityReport {
	const headingCount = (skillMarkdown.match(/^## /gmu) ?? []).length;
	const overlapSkills = existingSkills
		.filter((skill) => overlapScore(skillMarkdown, `${skill.name} ${skill.description}`) >= 0.35)
		.map((skill) => skill.filePath)
		.slice(0, 3);
	const memoryOverlap =
		(projectMemory.length > 0 && overlapScore(skillMarkdown, projectMemory) >= 0.35) ||
		(globalMemory.length > 0 && overlapScore(skillMarkdown, globalMemory) >= 0.35);

	const checklist = [
		overlapSkills.length === 0 ? "与现有 skills 无明显重叠" : `与 ${overlapSkills.length} 个现有 skill 存在主题重叠`,
		memoryOverlap ? "与 MEMORY.md 存在主题重叠" : "与 MEMORY.md 无明显重叠",
		headingCount >= 3 ? "结构化章节足够" : "章节偏少，结构可能过薄",
		droppedInstinctIds.length === 0
			? "未发现重复 instinct"
			: `已丢弃 ${droppedInstinctIds.length} 个重复/泛化 instinct`,
	];

	let verdict: SkillCreateQualityReport["verdict"] = "save";
	let rationale = "技能内容具备可重用性，且没有发现需要吸收进已有 skill 的强重叠。";
	let absorbTarget: string | undefined = llmQuality?.absorbTarget;
	let improvements: string[] | undefined = llmQuality?.improvements;
	if (llmQuality?.verdict) {
		verdict = llmQuality.verdict;
		rationale = llmQuality.rationale?.trim() || rationale;
	} else if (overlapSkills.length > 0) {
		verdict = "absorb";
		rationale = "检测到与现有 skill 存在主题重叠，后续应考虑吸收或合并。";
		absorbTarget = overlapSkills[0];
	} else if (memoryOverlap) {
		verdict = "absorb";
		rationale = "检测到与 MEMORY.md 存在明显重叠，更适合吸收到现有记忆而非重复落 skill。";
		absorbTarget = "MEMORY.md";
	} else if (headingCount < 3) {
		verdict = "improve-then-save";
		rationale = "技能结构偏薄，但仍具有可保存价值。";
		improvements = ["补充更多具体的模块边界、命令和测试约束"];
	}

	return {
		verdict,
		rationale,
		checklist,
		overlapSkills,
		droppedInstinctIds,
		absorbTarget,
		improvements,
	};
}

function stripFrontmatter(raw: string): string {
	return raw.replace(/^---[\s\S]*?---\s*/u, "").trim();
}

function buildAbsorbContent(skillMarkdown: string, absorbTarget: string | undefined): string {
	const body = stripFrontmatter(skillMarkdown);
	const title = absorbTarget ?? "existing skill";
	return [
		`# Suggested Additions For ${title}`,
		"",
		"```diff",
		"@@ append @@",
		...body.split("\n").map((line) => `+ ${line}`),
		"```",
	].join("\n");
}

async function improveSkillWithLlm(
	project: ProjectInfo,
	llm: SkillCreateLlmContext,
	skillMarkdown: string,
	improvements: string[],
): Promise<{ skillMarkdown: string | null; status: string }> {
	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					"Revise this repository skill once using the following improvements.",
					"",
					"Return only:",
					"<skill_markdown>",
					"...full revised SKILL.md...",
					"</skill_markdown>",
					"",
					"Improvements:",
					...improvements.map((item) => `- ${item}`),
					"",
					"Current draft:",
					"<skill_markdown>",
					skillMarkdown,
					"</skill_markdown>",
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	};

	try {
		const response = await complete(
			llm.model,
			{
				systemPrompt:
					"You revise repository skills. Preserve valid frontmatter and improve specificity, actionability, and scope fit. Return only the requested <skill_markdown> block.",
				messages: [userMessage],
			},
			{
				apiKey: llm.apiKey,
				headers: llm.headers,
				maxTokens: 4096,
				signal: AbortSignal.timeout(60000),
			},
		);
		const text = response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		const revisedBlock = extractTaggedSection(text, "skill_markdown");
		return {
			skillMarkdown: revisedBlock ? normalizeSkillMarkdown(revisedBlock, project) : null,
			status: revisedBlock ? "success" : "parse-failed",
		};
	} catch (error) {
		return {
			skillMarkdown: null,
			status: `error:${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function serializeInstinctDraft(project: ProjectInfo, instinct: LlmInstinctDraft): string {
	return serializeInstinct({
		id: instinct.id,
		title: instinct.title,
		trigger: instinct.trigger,
		confidence: instinct.confidence,
		domain: instinct.domain,
		source: "local-repo-analysis",
		scope: instinct.scope,
		projectId: instinct.scope === "project" ? project.id : undefined,
		projectName: instinct.scope === "project" ? project.name : undefined,
		content: [
			`# ${instinct.title}`,
			"",
			"## Action",
			instinct.action,
			"",
			"## Evidence",
			...(instinct.evidence.length > 0
				? instinct.evidence.map((line) => `- ${line}`)
				: ["- Derived from repository analysis"]),
		].join("\n"),
		created: new Date().toISOString(),
		updated: new Date().toISOString(),
	});
}

function resolveSkillOutputPath(project: ProjectInfo, layout: StorageLayout, output?: string): string {
	const skillDirName = `${project.name.toLowerCase().replace(/[^a-z0-9-]+/gu, "-")}-patterns`;
	if (!output) {
		return join(layout.projectEvolvedSkillsDir, skillDirName, "SKILL.md");
	}
	const resolvedOutput = resolve(output);
	if (extname(resolvedOutput).toLowerCase() === ".md") {
		return resolvedOutput;
	}
	return join(resolvedOutput, skillDirName, "SKILL.md");
}

async function generateWithLlm(
	project: ProjectInfo,
	llm: SkillCreateLlmContext,
	prompt: string,
): Promise<{ result: LlmSkillCreateResult | null; status: string }> {
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};
	try {
		const response = await complete(
			llm.model,
			{
				systemPrompt: SKILL_CREATE_SYSTEM_PROMPT,
				messages: [userMessage],
			},
			{
				apiKey: llm.apiKey,
				headers: llm.headers,
				maxTokens: 4096,
				signal: AbortSignal.timeout(60000),
			},
		);
		const text = response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		const parsed = parseLlmResult(text, project);
		return {
			result: parsed,
			status: parsed ? "success" : "parse-failed",
		};
	} catch (error) {
		return {
			result: null,
			status: `error:${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export async function createSkillFromRepository(options: SkillCreateOptions): Promise<SkillCreateResult> {
	const repoRoot = await git(["-C", options.project.root, "rev-parse", "--show-toplevel"], options.cwd);
	const entries = await collectGitHistory(repoRoot, options.commits);
	if (entries.length === 0) {
		throw new Error("没有可分析的 git 提交记录");
	}

	const prefixes = summarizeCommitPrefixes(entries);
	const sourceFiles = countFiles(entries, isInterestingSourceFile);
	const testFiles = countFiles(entries, isInterestingTestFile);
	const docFiles = countFiles(entries, isInterestingDocFile);

	const readmeExcerpt = (await readExcerpt(repoRoot, "README.md", MAX_README_CHARS))?.content ?? "";
	const pomExcerpt = (await readExcerpt(repoRoot, "pom.xml", MAX_FILE_CHARS))?.content ?? "";
	const sourceExcerpts = await readRepresentativeFiles(repoRoot, sourceFiles, MAX_SOURCE_FILES, MAX_FILE_CHARS);
	const testExcerpts = await readRepresentativeFiles(repoRoot, testFiles, MAX_TEST_FILES, MAX_FILE_CHARS);
	const docExcerpts = await readRepresentativeFiles(repoRoot, docFiles, MAX_DOC_FILES, MAX_FILE_CHARS);
	const commitSamples = buildCommitSamples(entries).slice(0, MAX_COMMIT_SAMPLES);
	const skillPath = resolveSkillOutputPath(options.project, options.layout, options.output);
	const existingSkills = await loadExistingSkills(repoRoot, skillPath);
	const existingInstincts = await loadProjectOnlyInstincts(options.layout);
	const projectMemory = (
		(await readOptionalText(join(repoRoot, ".pi", "MEMORY.md"), 4000)) ||
		(await readOptionalText(join(repoRoot, "MEMORY.md"), 4000))
	).trim();
	const globalMemory = (await readOptionalText(join(getAgentDir(), "MEMORY.md"), 4000)).trim();

	let llmResult: LlmSkillCreateResult | null = null;
	let llmStatus = "not-used";
	if (options.llm) {
		const prompt = buildPrompt(
			options.project,
			readmeExcerpt,
			pomExcerpt,
			prefixes,
			commitSamples,
			sourceExcerpts,
			testExcerpts,
			docExcerpts,
			existingSkills,
			existingInstincts.map((instinct) => ({
				id: instinct.id,
				title: instinct.title,
				trigger: instinct.trigger,
				domain: instinct.domain,
			})),
			projectMemory,
			globalMemory,
		);
		const llmGeneration = await generateWithLlm(options.project, options.llm, prompt);
		llmResult = llmGeneration.result;
		llmStatus = llmGeneration.status;
	}

	const skillMarkdown =
		llmResult?.skillMarkdown && llmResult.skillMarkdown.trim().length > 0
			? llmResult.skillMarkdown
			: buildFallbackSkillMarkdown(
					options.project,
					prefixes,
					sourceFiles,
					testFiles,
					entries,
					readmeExcerpt,
					pomExcerpt,
				);

	const instinctDrafts =
		llmResult?.instincts && llmResult.instincts.length > 0
			? llmResult.instincts
			: buildFallbackInstincts(options.project, prefixes, testFiles);
	const dedupedInstincts = dedupeInstinctDrafts(
		instinctDrafts,
		existingInstincts.map((instinct) => ({
			id: instinct.id,
			title: instinct.title,
			trigger: instinct.trigger,
			domain: instinct.domain,
		})),
	);
	const quality = buildQualityReport(
		skillMarkdown,
		existingSkills,
		dedupedInstincts.droppedIds,
		projectMemory,
		globalMemory,
		llmResult?.quality,
	);

	let finalSkillMarkdown = skillMarkdown;
	let finalQuality = quality;
	let finalLlmStatus = llmStatus;
	if (
		quality.verdict === "improve-then-save" &&
		options.llm &&
		quality.improvements &&
		quality.improvements.length > 0
	) {
		const improved = await improveSkillWithLlm(options.project, options.llm, skillMarkdown, quality.improvements);
		if (improved.skillMarkdown) {
			finalSkillMarkdown = improved.skillMarkdown;
			finalLlmStatus = `${llmStatus}; revise:${improved.status}`;
			finalQuality = {
				...buildQualityReport(
					finalSkillMarkdown,
					existingSkills,
					dedupedInstincts.droppedIds,
					projectMemory,
					globalMemory,
				),
				revised: true,
			};
		} else {
			finalLlmStatus = `${llmStatus}; revise:${improved.status}`;
		}
	}

	if (finalQuality.verdict === "drop") {
		return {
			skillPath,
			instinctPaths: [],
			summary: [
				`分析仓库: ${options.project.name}`,
				`提交数: ${entries.length}`,
				"生成方式: skipped",
				`LLM状态: ${finalLlmStatus}`,
				`质量判定: ${finalQuality.verdict}`,
				`原因: ${finalQuality.rationale}`,
			].join("\n"),
			generationMode: llmResult ? "LLM" : "fallback",
			llmStatus: finalLlmStatus,
			quality: finalQuality,
			commitCount: entries.length,
			prefixes: prefixes.map((item) => `${item.prefix}(${item.count})`),
			representativeFiles: sourceExcerpts.map((file) => file.path),
		};
	}

	if (finalQuality.verdict === "absorb") {
		const absorbContent = buildAbsorbContent(finalSkillMarkdown, finalQuality.absorbTarget);
		return {
			skillPath,
			instinctPaths: [],
			summary: [
				`分析仓库: ${options.project.name}`,
				`提交数: ${entries.length}`,
				"生成方式: skipped",
				`LLM状态: ${finalLlmStatus}`,
				`质量判定: ${finalQuality.verdict}`,
				`吸收目标: ${finalQuality.absorbTarget ?? "existing skill"}`,
				`原因: ${finalQuality.rationale}`,
			].join("\n"),
			generationMode: llmResult ? "LLM" : "fallback",
			llmStatus: finalLlmStatus,
			quality: {
				...finalQuality,
				absorbContent,
			},
			commitCount: entries.length,
			prefixes: prefixes.map((item) => `${item.prefix}(${item.count})`),
			representativeFiles: sourceExcerpts.map((file) => file.path),
		};
	}

	await writeTextFile(skillPath, finalSkillMarkdown);

	const instinctPaths: string[] = [];
	if (options.includeInstincts) {
		for (const instinct of dedupedInstincts.drafts) {
			const filePath = join(options.layout.projectPersonalDir, `${instinct.id}.md`);
			await writeTextFile(filePath, serializeInstinctDraft(options.project, instinct));
			instinctPaths.push(filePath);
		}
	}

	const summaryLines = [
		`分析仓库: ${options.project.name}`,
		`提交数: ${entries.length}`,
		`技能文件: ${skillPath}`,
		`生成方式: ${llmResult ? "LLM" : "fallback"}`,
		`LLM状态: ${finalLlmStatus}`,
		`质量判定: ${finalQuality.verdict}`,
	];
	if (prefixes.length > 0) {
		summaryLines.push(`提交前缀: ${prefixes.map((item) => `${item.prefix}(${item.count})`).join(", ")}`);
	}
	if (sourceExcerpts.length > 0) {
		summaryLines.push(`代表性源码: ${sourceExcerpts.map((file) => file.path).join(", ")}`);
	}
	if (instinctPaths.length > 0) {
		summaryLines.push(`生成 instinct: ${instinctPaths.length}`);
	}
	if (finalQuality.droppedInstinctIds.length > 0) {
		summaryLines.push(`已丢弃 instinct: ${finalQuality.droppedInstinctIds.join(", ")}`);
	}
	if (finalQuality.revised) {
		summaryLines.push("已执行一次 improve-then-save 自动修订");
	}

	return {
		skillPath,
		instinctPaths,
		summary: summaryLines.join("\n"),
		generationMode: llmResult ? "LLM" : "fallback",
		llmStatus: finalLlmStatus,
		quality: finalQuality,
		commitCount: entries.length,
		prefixes: prefixes.map((item) => `${item.prefix}(${item.count})`),
		representativeFiles: sourceExcerpts.map((file) => file.path),
	};
}
