/**
 * Keep Pi's full Agent Skills catalog out of every model request.
 *
 * Skills stay loaded, so /skill:name keeps working. Before each agent turn the
 * generated <available_skills> catalog is removed from the effective system
 * prompt and replaced by one tool. That tool rates every enabled skill against
 * the current task with TypeSafe's Jev — one Score question per skill, sharded
 * across parallel requests — and returns the full SKILL.md of the winners.
 */

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";

import {
	configPath,
	JevError,
	loadConfig,
	rankSkills,
	stripSkillCatalog,
	type Ranked,
	type SkillEntry,
} from "./jev.ts";
import { lexicalMatches } from "./lexical.ts";

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

function renderSkill(ranked: Ranked): string {
	const { skill, score, confidence } = ranked;
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
	return [
		`<skill name="${xmlAttribute(skill.name)}" location="${xmlAttribute(skill.filePath)}">`,
		`Jev rated this ${score.toFixed(2)} of 2 for the stated task (confidence ${confidence.toFixed(2)}).`,
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
	let enabledSkills: SkillEntry[] = [];

	pi.on("before_agent_start", async (event) => {
		enabledSkills = toEntries(event.systemPromptOptions.skills ?? []);
		return { systemPrompt: stripSkillCatalog(event.systemPrompt) };
	});

	pi.registerTool({
		name: "skill_search",
		label: "Skill Search",
		description:
			"Rate every enabled Agent Skill against the current task with TypeSafe's Jev and load the full instructions of the ones that actually apply. Describe the task in plain language; do not guess skill names.",
		promptSnippet: "Find and load the Agent Skills that apply to the current task",
		promptGuidelines: [
			"The Agent Skills catalog is intentionally omitted from this prompt. Before substantive work where a specialized workflow, private CLI or house convention may exist, call skill_search once with a plain-language description of the task. It returns the complete instructions of any skill that applies, or says that none do.",
		],
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

			const loaded = result.ranked.map(renderSkill);
			return {
				content: [
					{
						type: "text",
						text:
							`Jev selected and loaded ${loaded.length} Agent Skill${loaded.length === 1 ? "" : "s"} out of ${enabledSkills.length} enabled.${partial} Follow these instructions for the current task:\n\n`
							+ loaded.join("\n\n"),
					},
				],
				details,
			};
		},
	});
}
