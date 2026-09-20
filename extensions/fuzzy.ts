/**
 * Name suggestions for skill_load. A model that guesses "fleece" should be told
 * "fleet" exists rather than just that nothing matched.
 */

/** Lowercase and drop separators, so "review codex auto" matches "review-codex-auto". */
export function normalizeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Levenshtein distance, two-row variant. */
export function editDistance(left: string, right: string): number {
	if (left === right) return 0;
	if (!left.length) return right.length;
	if (!right.length) return left.length;

	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	let current = new Array<number>(right.length + 1);

	for (let i = 1; i <= left.length; i++) {
		current[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
			current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
		}
		[previous, current] = [current, previous];
	}
	return previous[right.length]!;
}

/** How far off a guess may be before it stops being a plausible typo. */
function threshold(length: number): number {
	return Math.max(2, Math.floor(length / 3));
}

export interface Suggestion {
	name: string;
	reason: "case" | "separator" | "contains" | "typo";
}

/**
 * Rank plausible intended names for a miss. Exact-after-normalizing beats
 * containment, which beats a short edit distance.
 */
export function suggestNames(query: string, candidates: string[], limit = 3): Suggestion[] {
	const wanted = normalizeName(query);
	if (!wanted) return [];

	const scored: { name: string; rank: number; distance: number; reason: Suggestion["reason"] }[] = [];
	for (const name of candidates) {
		const candidate = normalizeName(name);
		if (candidate === wanted) {
			// Same letters, so the caller got case or separators wrong.
			scored.push({
				name,
				rank: 0,
				distance: 0,
				// Equal once lowercased means only the case differed; otherwise separators did.
				reason: name.toLowerCase() === query.toLowerCase() ? "case" : "separator",
			});
			continue;
		}
		if (candidate.includes(wanted) || wanted.includes(candidate)) {
			scored.push({ name, rank: 1, distance: Math.abs(candidate.length - wanted.length), reason: "contains" });
			continue;
		}
		const distance = editDistance(wanted, candidate);
		if (distance <= threshold(Math.max(wanted.length, candidate.length))) {
			scored.push({ name, rank: 2, distance, reason: "typo" });
		}
	}

	scored.sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.name.localeCompare(b.name));
	return scored.slice(0, limit).map(({ name, reason }) => ({ name, reason }));
}

/** "did you mean 'fleet'?" / "did you mean 'fleet' or 'reel'?" */
export function didYouMean(suggestions: Suggestion[]): string {
	if (!suggestions.length) return "";
	const names = suggestions.map((s) => `'${s.name}'`);
	const joined = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names.at(-1)!}`;
	return ` Did you mean ${joined}?`;
}
