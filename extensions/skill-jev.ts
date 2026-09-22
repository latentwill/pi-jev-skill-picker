/**
 * Keep Pi's full Agent Skills catalog out of every model request.
 *
 * Skills stay loaded, so /skill:name keeps working. Before each agent turn the
 * generated <available_skills> catalog is removed from the effective system
 * prompt and replaced by one tool. That tool rates every enabled skill against
 * the current task with TypeSafe's Jev — one Score question per skill, sharded
 * across parallel requests — and returns the full SKILL.md of the winners.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { readFileSync } from "node:fs";

import {
	configPath,
	JevError,
	loadConfig,
	rankSkills,
	stripSkillCatalog,

	type SkillEntry,
} from "./jev.ts";
import { lexicalMatches } from "./lexical.ts";
import { didYouMean, suggestNames } from "./fuzzy.ts";

export { stripSkillCatalog };

function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

function xmlAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function renderSkill(skill: SkillEntry, note: string): string {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
	return [
		`<skill name="${xmlAttribute(skill.name)}" location="${xmlAttribute(skill.filePath)}">`,
		note,
		`References are relative to ${skill.baseDir}.`,
		"",
		body,
		"</skill>",
	].join("\n");
}

function toEntries(skills: Skill[]): SkillEntry[] {
	return skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
	}));
}

export default function (pi: ExtensionAPI) {
	// Injected TypeBox shim; the call sites below keep the classic Type.Object(...) shape.
	const Type = pi.typebox.Type;
	let enabledSkills: SkillEntry[] = [];

	// omp ≥18 dropped `systemPromptOptions` from before_agent_start: the event now
	// carries the assembled system prompt as string[]. The skill list comes from the
	// host's own discovery pipeline — the same one that renders the <skills> catalog
	// — memoized briefly so policy-preparation retries stay cheap.
	let discoveryCache: { at: number; skills: SkillEntry[] } | null = null;

	async function loadEnabledSkills(cwd: string | undefined): Promise<SkillEntry[]> {
		const now = Date.now();
		if (discoveryCache && now - discoveryCache.at < 5_000) return discoveryCache.skills;
		let skills: SkillEntry[] = [];
		try {
			const result = await pi.pi.discoverSkills(cwd);
			// Shape drift guard: discovery resolves to { skills, warnings }; older
			// builds returned the bare array.
			const discovered: Skill[] = Array.isArray(result) ? result : result.skills;
			skills = toEntries(discovered.filter((skill) => !skill.hide));
		} catch (error) {
			pi.logger.warn(
				`skill-jev: skill discovery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		discoveryCache = { at: now, skills };
		return skills;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		const base = event.systemPrompt.join("\n\n");
		enabledSkills = await loadEnabledSkills(ctx.cwd);
		return { systemPrompt: [stripSkillCatalog(base)] };
	});

	pi.registerTool({
		name: "skill_load",
		label: "Skill Load",
		description:
			"Load named Agent Skills in full, straight from disk. Use it when you already know which skill you want — for example one skill_search listed but did not load. Use skill_search instead when you do not know the name. A name that does not match returns close alternatives rather than failing.",
		parameters: Type.Object({
			names: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 5,
				description: "Exact skill names, as skill_search reported them.",
			}),
		}),
		async execute(_toolCallId, params) {
			if (!enabledSkills.length) {
				throw new Error("No enabled Agent Skills are available to load.");
			}

			const byName = new Map(enabledSkills.map((entry) => [entry.name, entry]));
			const allNames = enabledSkills.map((entry) => entry.name);
			const loaded: SkillEntry[] = [];
			const misses: { name: string; suggestions: string[] }[] = [];
			const seen = new Set<string>();

			for (const requested of params.names) {
				const name = requested.trim();
				const exact = byName.get(name);
				if (exact) {
					if (!seen.has(exact.name)) {
						seen.add(exact.name);
						loaded.push(exact);
					}
					continue;
				}
				const suggestions = suggestNames(name, allNames);
				// A single unambiguous case or separator slip is the same skill, so take it.
				if (suggestions.length === 1 && (suggestions[0]!.reason === "case" || suggestions[0]!.reason === "separator")) {
					const resolved = byName.get(suggestions[0]!.name)!;
					if (!seen.has(resolved.name)) {
						seen.add(resolved.name);
						loaded.push(resolved);
					}
					continue;
				}
				misses.push({ name, suggestions: suggestions.map((entry) => entry.name) });
			}

			const problems = misses.map(({ name, suggestions }) => {
				const hint = didYouMean(suggestions.map((s) => ({ name: s, reason: "typo" as const })));
				return hint
					? `No skill named '${name}'.${hint}`
					: `No skill named '${name}', and nothing close to it is enabled.`;
			});

			if (!loaded.length) {
				return {
					content: [
						{
							type: "text",
							text: `${problems.join(" ")} Call skill_load again with an exact name, or skill_search with a task description.`,
						},
					],
					details: { loaded: [], misses },
					isError: true,
				};
			}

			const bodies = loaded.map((skill) => renderSkill(skill, "Loaded by name, without ranking."));
			const note = problems.length ? `\n\n${problems.join(" ")}` : "";
			return {
				content: [
					{
						type: "text",
						text:
							`Loaded ${bodies.length} Agent Skill${bodies.length === 1 ? "" : "s"} by name. Follow these instructions for the current task:\n\n`
							+ bodies.join("\n\n") + note,
					},
				],
				details: { loaded: loaded.map((entry) => entry.name), misses },
			};
		},
	});

	pi.registerTool({
		name: "skill_search",
		label: "Skill Search",
		description:
			"Rate every enabled Agent Skill against the current task with TypeSafe's Jev and load the full instructions of the ones that actually apply. The Agent Skills catalog is deliberately omitted from the system prompt, so before substantive work where a specialized workflow, private CLI or house convention may exist, call this once with a plain-language description of the task. It returns the complete instructions of any skill that applies, or says that none do. Describe the task in plain language; do not guess skill names.",
		parameters: Type.Object({
			task: Type.String({
				minLength: 3,
				description:
					"Plain-language description of what you are about to do, including the concrete tools, services or files involved. For example: 'restart the jellyfin service on the server-pc box and tail its logs'.",
			}),
			maxSkills: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5,
					description: "Maximum skills to load (default 3).",
				}),
			),

		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			if (!enabledSkills.length) {
				throw new Error("No enabled Agent Skills are available to search.");
			}

			const config = loadConfig();
			const limit = params.maxSkills ?? config.maxSkills;

			const task = params.task.trim();

			onUpdate?.({
				content: [{ type: "text", text: `Rating ${enabledSkills.length} enabled skills against the task…` }],
				details: { status: "running", model: config.model, totalSkills: enabledSkills.length },
			});

			let result: Awaited<ReturnType<typeof rankSkills>>;
			try {
				result = await rankSkills(task, enabledSkills, config, limit, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				if (!(error instanceof JevError)) throw error;

				const matches = lexicalMatches(enabledSkills, task, limit);
				const reason = config.apiKey
					? `Jev was unreachable (${error.message})`
					: `No TypeSafe API key is configured (set TYPESAFE_API_KEY or add "apiKey" to ${configPath()})`;
				if (!matches.length) {
					return {
						content: [
							{
								type: "text",
								text: `${reason}. The deterministic lexical fallback matched no skills either. Continue with ordinary tools and reasoning.`,
							},
						],
						details: { task, fallback: "lexical", error: error.message, matches: [] },
					};
				}

				const rendered = matches
					.map(({ skill }, index) => `${index + 1}. ${skill.name}\n   ${skill.description.slice(0, 400)}\n   Read: ${skill.filePath}`)
					.join("\n\n");
				return {
					content: [
						{
							type: "text",
							text:
								`${reason}, so these are lexical keyword matches rather than Jev judgments. Read a SKILL.md before following it.\n\n${rendered}`,
						},
					],
					details: {
						task,
						fallback: "lexical",
						error: error.message,
						matches: matches.map(({ skill, score }) => ({ name: skill.name, filePath: skill.filePath, score })),
					},
				};
			}

			const details = {
				task,
				model: result.model ?? config.model,
				totalSkills: enabledSkills.length,
				shards: result.shards,
				inputTokens: result.inputTokens,
				minScore: config.minScore,
				partialFailures: result.failures,
				selections: result.ranked.map(({ skill, score, confidence }) => ({
					name: skill.name,
					filePath: skill.filePath,
					score,
					confidence,
				})),
				alsoRanked: result.alsoRanked.map(({ skill, score }) => ({ name: skill.name, score })),
			};

			const partial = result.failures.length
				? ` ${result.failures.length} of ${result.shards} shards failed, so part of the catalog went unrated.`
				: "";

			if (!result.ranked.length) {
				return {
					content: [
						{
							type: "text",
							text: `No enabled Agent Skill scored at or above ${config.minScore} of 2 for this task.${partial} Continue with ordinary tools and reasoning.`,
						},
					],
					details,
				};
			}

			const loaded = result.ranked.map(({ skill, score, confidence }) =>
				renderSkill(skill, `Jev rated this ${score.toFixed(2)} of 2 for the stated task (confidence ${confidence.toFixed(2)}).`),
			);
			// Everything else above the floor, so the agent can pull one in deliberately.
			const alsoText = result.alsoRanked.length
				? `\n\nThese also scored above ${config.minScore} but were not loaded. Use skill_load to pull one in:\n`
					+ result.alsoRanked
						.map(({ skill, score }) => `- ${skill.name} (${score.toFixed(2)}) — ${skill.filePath}`)
						.join("\n")
				: "";
			return {
				content: [
					{
						type: "text",
						text:
							`Jev selected and loaded ${loaded.length} Agent Skill${loaded.length === 1 ? "" : "s"} out of ${enabledSkills.length} enabled.${partial} Follow these instructions for the current task:\n\n`
							+ loaded.join("\n\n") + alsoText,
					},
				],
				details,
			};
		},
	});
}
