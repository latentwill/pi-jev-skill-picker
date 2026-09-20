/**
 * Deterministic lexical ranking. This is the baseline the Jev ranking is
 * measured against, and the fallback when TypeSafe is unreachable or unkeyed.
 */

import type { SkillEntry } from "./jev.ts";

const STOP_WORDS = new Set([
	"a", "an", "and", "for", "from", "how", "in", "of", "on", "or", "the", "to", "use", "with",
]);

function normalized(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function queryTerms(query: string): string[] {
	return [
		...new Set(
			normalized(query)
				.split(/\s+/)
				.filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
		),
	];
}

export function scoreSkill(skill: SkillEntry, query: string, terms: string[]): number {
	const name = normalized(skill.name);
	const description = normalized(skill.description);
	const phrase = normalized(query);
	const nameWords = new Set(name.split(" "));
	const descriptionWords = new Set(description.split(" "));
	let score = 0;

	if (name === phrase) score += 1000;
	else if (phrase && name.includes(phrase)) score += 300;
	if (phrase && description.includes(phrase)) score += 150;

	let matchedTerms = 0;
	for (const term of terms) {
		let matched = false;
		if (nameWords.has(term)) {
			score += 60;
			matched = true;
		} else if (name.includes(term)) {
			score += 30;
			matched = true;
		}

		if (descriptionWords.has(term)) {
			score += 12;
			matched = true;
		} else if (description.includes(term)) {
			score += 5;
			matched = true;
		}

		if (matched) matchedTerms++;
	}

	if (terms.length && matchedTerms === terms.length) score += 40;
	return score;
}

export function lexicalMatches(
	skills: SkillEntry[],
	query: string,
	limit: number,
): { skill: SkillEntry; score: number }[] {
	const terms = queryTerms(query);
	return skills
		.map((skill) => ({ skill, score: scoreSkill(skill, query, terms) }))
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
		.slice(0, limit);
}
