import assert from "node:assert/strict";
import { test } from "node:test";

import { didYouMean, editDistance, normalizeName, suggestNames } from "../extensions/fuzzy.ts";

/** A slice of the real catalog, including deliberately similar names. */
const CATALOG = [
	"fleet", "reel", "sec", "qb", "dbase", "dejavu", "shipwatch",
	"review-codex-auto", "review-codex-herdr", "review-claude-auto",
	"quality-code", "handoff", "pi-processes", "infra-map", "papercuts",
];

test("editDistance measures ordinary typos", () => {
	assert.equal(editDistance("fleet", "fleet"), 0);
	assert.equal(editDistance("fleece", "fleet"), 2);
	assert.equal(editDistance("", "fleet"), 5);
	assert.equal(editDistance("fleet", ""), 5);
});

test("normalizeName ignores case and separators", () => {
	assert.equal(normalizeName("Review-Codex-Auto"), "reviewcodexauto");
	assert.equal(normalizeName("review codex auto"), "reviewcodexauto");
});

test("the motivating case: fleece suggests fleet", () => {
	const suggestions = suggestNames("fleece", CATALOG);
	assert.equal(suggestions[0]?.name, "fleet");
	assert.equal(didYouMean(suggestions.slice(0, 1)), " Did you mean 'fleet'?");
});

test("a wrong separator or case resolves to the same skill", () => {
	assert.deepEqual(suggestNames("Fleet", CATALOG)[0], { name: "fleet", reason: "case" });
	assert.deepEqual(suggestNames("review codex auto", CATALOG)[0], { name: "review-codex-auto", reason: "separator" });
});

test("a partial name offers every skill that contains it", () => {
	const names = suggestNames("review-codex", CATALOG).map((s) => s.name);
	assert.ok(names.includes("review-codex-auto"));
	assert.ok(names.includes("review-codex-herdr"));
});

test("nothing close returns no suggestions", () => {
	assert.deepEqual(suggestNames("zzzzzzzzzzzz", CATALOG), []);
	assert.equal(didYouMean([]), "");
});

test("a short name does not match everything", () => {
	// "qb" is 2 characters; a floor of 2 edits must not drag in every short name.
	const names = suggestNames("qb", CATALOG).map((s) => s.name);
	assert.equal(names[0], "qb");
});

test("suggestions are capped and ordered", () => {
	const suggestions = suggestNames("review", CATALOG, 2);
	assert.ok(suggestions.length <= 2);
});

test("didYouMean joins two names with or", () => {
	assert.equal(
		didYouMean([{ name: "fleet", reason: "typo" }, { name: "reel", reason: "typo" }]),
		" Did you mean 'fleet' or 'reel'?",
	);
});

test("an empty query suggests nothing", () => {
	assert.deepEqual(suggestNames("   ", CATALOG), []);
});
