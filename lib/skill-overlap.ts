import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { normalizeCompareText, overlapScore } from "./instinct-quality.js";

export interface ExistingSkillReference {
	name: string;
	description: string;
	filePath: string;
	bodyPreview: string;
}

interface SkillSignals {
	title: string;
	headings: string[];
	actions: string[];
	body: string;
}

export interface SkillOverlapMatch {
	filePath: string;
	score: number;
	titleScore: number;
	headingScore: number;
	actionScore: number;
	bodyScore: number;
}

function extractHeadings(body: string): string[] {
	return body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^#{1,6}\s+/u.test(line))
		.map((line) => line.replace(/^#{1,6}\s+/u, "").trim())
		.filter((line) => line.length > 0);
}

function extractActions(body: string): string[] {
	return body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^([-*]|\d+\.)\s+/u.test(line))
		.map((line) => line.replace(/^([-*]|\d+\.)\s+/u, "").trim())
		.filter((line) => line.length > 0);
}

function buildSkillSignals(markdown: string, fallbackName: string, fallbackDescription: string): SkillSignals {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(markdown);
	const normalizedBody = body.trim();
	const title =
		(typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
			? frontmatter.name.trim()
			: normalizedBody.match(/^#\s+(.+)$/mu)?.[1]?.trim()) ?? fallbackName;

	return {
		title: normalizeCompareText(`${title} ${fallbackDescription}`),
		headings: extractHeadings(normalizedBody).map((item) => normalizeCompareText(item)),
		actions: extractActions(normalizedBody).map((item) => normalizeCompareText(item)),
		body: normalizeCompareText(normalizedBody),
	};
}

export function scoreSkillOverlap(candidateMarkdown: string, existingSkill: ExistingSkillReference): SkillOverlapMatch {
	const candidate = buildSkillSignals(candidateMarkdown, "", "");
	const existing = buildSkillSignals(existingSkill.bodyPreview, existingSkill.name, existingSkill.description);

	const titleScore = overlapScore(candidate.title, existing.title);
	const headingScore = overlapScore(candidate.headings.join(" "), existing.headings.join(" "));
	const actionScore = overlapScore(candidate.actions.join(" "), existing.actions.join(" "));
	const bodyScore = overlapScore(candidate.body, existing.body);

	let score = titleScore * 0.2 + headingScore * 0.25 + actionScore * 0.3 + bodyScore * 0.25;
	if (titleScore >= 0.82 && (headingScore >= 0.45 || actionScore >= 0.45)) {
		score = Math.max(score, 0.82);
	}
	if (bodyScore >= 0.55 && (headingScore >= 0.35 || actionScore >= 0.35)) {
		score = Math.max(score, 0.78);
	}

	return {
		filePath: existingSkill.filePath,
		score,
		titleScore,
		headingScore,
		actionScore,
		bodyScore,
	};
}

export function detectOverlappingSkills(
	candidateMarkdown: string,
	existingSkills: ExistingSkillReference[],
	options?: { limit?: number; threshold?: number },
): SkillOverlapMatch[] {
	const threshold = options?.threshold ?? 0.52;
	const limit = options?.limit ?? 3;
	return existingSkills
		.map((skill) => scoreSkillOverlap(candidateMarkdown, skill))
		.filter((match) => match.score >= threshold)
		.sort((left, right) => right.score - left.score)
		.slice(0, limit);
}
