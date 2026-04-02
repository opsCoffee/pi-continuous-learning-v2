const TRIGGER_STOP_WORDS = new Set([
	"when",
	"creating",
	"writing",
	"adding",
	"implementing",
	"testing",
	"handling",
	"modifying",
	"changing",
	"updating",
	"working",
	"using",
	"doing",
	"with",
	"for",
	"the",
	"a",
	"an",
	"to",
	"or",
	"and",
]);

export interface ComparableInstinct {
	id: string;
	title?: string;
	trigger: string;
	action?: string;
	confidence?: number;
	domain?: string;
}

export function normalizeCompareText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[`*_>#-]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function tokenize(value: string): Set<string> {
	return new Set(
		normalizeCompareText(value)
			.split(" ")
			.filter((token) => token.length >= 3),
	);
}

export function overlapScore(left: string, right: string): number {
	const leftTokens = tokenize(left);
	const rightTokens = tokenize(right);
	if (leftTokens.size === 0 || rightTokens.size === 0) {
		return 0;
	}
	let overlap = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) {
			overlap++;
		}
	}
	return overlap / Math.min(leftTokens.size, rightTokens.size);
}

export function normalizeTriggerClusterKey(trigger: string, domain: string): string {
	const normalized = trigger
		.trim()
		.replace(/\s+/gu, " ")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, " ")
		.split(" ")
		.filter((part) => part.length > 0 && !TRIGGER_STOP_WORDS.has(part))
		.join(" ");
	return normalized.length > 0 ? normalized : `${domain} ${trigger.trim().toLowerCase()}`;
}

export function renderWhenClause(trigger: string): string {
	return trigger
		.trim()
		.replace(/\s+/gu, " ")
		.replace(/^when\s+/iu, "");
}

export function extractInstinctAction(content: string, fallback: string = ""): string {
	const match = content.match(/## Action\s+([\s\S]*?)(?:\n## |\n*$)/u);
	const action = match?.[1]?.trim().split("\n")[0];
	return action && action.length > 0 ? action : fallback;
}

function isNearDuplicate(left: ComparableInstinct, right: ComparableInstinct): boolean {
	const triggerScore = overlapScore(left.trigger, right.trigger);
	const actionScore = overlapScore(left.action ?? "", right.action ?? "");
	const overallScore = overlapScore(
		`${left.title ?? ""} ${left.trigger} ${left.action ?? ""}`,
		`${right.title ?? ""} ${right.trigger} ${right.action ?? ""}`,
	);
	if (triggerScore >= 0.8 && actionScore < 0.45) {
		return false;
	}
	return overallScore >= 0.72 || (triggerScore >= 0.8 && actionScore >= 0.55);
}

export function dedupeComparableInstincts<T extends ComparableInstinct>(
	drafts: T[],
	existing: ComparableInstinct[] = [],
	limit: number = Number.POSITIVE_INFINITY,
): { kept: T[]; droppedIds: string[] } {
	const kept: T[] = [];
	const droppedIds: string[] = [];
	const sorted = [...drafts].sort((left, right) => (right.confidence ?? 0.5) - (left.confidence ?? 0.5));

	for (const draft of sorted) {
		const overlapsExisting = existing.some(
			(instinct) => instinct.id !== draft.id && isNearDuplicate(instinct, draft),
		);
		if (overlapsExisting) {
			droppedIds.push(draft.id);
			continue;
		}
		const overlapsKept = kept.some((instinct) => instinct.id !== draft.id && isNearDuplicate(instinct, draft));
		if (overlapsKept) {
			droppedIds.push(draft.id);
			continue;
		}
		if (kept.length >= limit) {
			droppedIds.push(draft.id);
			continue;
		}
		kept.push(draft);
	}

	return { kept, droppedIds };
}
