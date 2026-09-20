# pi-jev-skill-picker

A Pi extension that keeps the Agent Skills catalog out of model requests and replaces it with one ranking tool backed by [TypeSafe's Jev](https://docs.typesafe.ai) System One model.

Skills stay loaded, so `/skill:name` keeps working. Before each agent turn the extension removes Pi's generated `<skills>` catalog from the effective system prompt and exposes one tool.

`skill_search` takes a plain-language description of the task, rates every enabled skill against it, and returns the complete `SKILL.md` instructions of the skills that apply.

## What it saves

On a 137-skill catalog the generated `<skills>` block runs about 19,000 tokens, which is 87% of Pi's system prompt. Pi resends it on every request.

Both rows below use the same captured prompt and one trivial turn:

| Model | Catalog present | Catalog stripped | Saving |
|---|---|---|---|
| `gpt-6-astra` | 21,074 tokens, $0.2107 | 2,541 tokens, $0.0254 | 87.9% |
| `deepseek-v4.1-flash` | 22,377 tokens, $0.0034 | 3,434 tokens, $0.0005 | 84.6% |

One `skill_search` call costs about 38,600 Jev input tokens, or $0.0016 at $42 per billion. Jev bills input only. Against `gpt-6-astra` that is under 1% of what a single un-stripped request wastes.

## How the ranking works

Each skill becomes its own Score question. The task goes in the shared `state`, and the skill's name and description go in that skill's own `instructions`. Jev judges each skill without seeing the others, so no keyword prefilter can drop one first.

Every skill is rated on the same three ordered levels:

| Level | Meaning |
|---|---|
| 0 | Unrelated. A different domain, tool or workflow. |
| 1 | Adjacent. Same general area, not the specific thing the task needs. |
| 2 | Directly applicable. Covers the exact tool or workflow, and changes how the task is done. |

Jev returns a probability-weighted position on those levels. Code applies the floor, sorts, and loads the winners. A skill has to lean toward "directly applicable" to be loaded, and ties break on confidence.

## Why the questions are sharded

Sharding buys latency, not headroom. All 137 skills fit in one request at roughly 17,000 tokens against a 64,000 limit, and that single request is the slowest option measured:

| Target shard size | Requests | Split | Median |
|---|---|---|---|
| 137 | 1 | 137 | 2,743 ms |
| 100 | 2 | 100 + 37 | 1,598 ms |
| 69 | 2 | 69 + 68 | 975 ms |
| 50 | 3 | 46 + 46 + 45 | ~900 ms |
| 25 | 6 | 23x5 + 22 | ~800 ms |

Jev evaluates the questions inside a request in parallel, but the request itself is one unit of work. Splitting it across several requests runs them at the same time.

Latency follows the largest shard rather than the number of requests. The 100 and 69 rows are both two requests, but 100 + 37 takes 64% longer because the small shard finishes early and waits. So `shardSize` sets a target maximum instead of a fixed chunk. It decides how many shards to use, then spreads skills evenly across them, and any two shards end up within one item of each other.

Gains flatten below about 46. Sharding does cost a few extra tokens, since the shared state repeats in every request, but that state is a single sentence, so six shards cost 2% more than one.

## Fallback

If no API key is configured or every request fails, `skill_search` falls back to deterministic lexical matching and says so in its result. The fallback returns skill metadata and paths rather than loaded instructions, so the agent decides what to read.

## Configuration

Precedence is environment variable, then `skill-jev.json` under `PI_CODING_AGENT_DIR` (normally `~/.pi/agent`), then the package default.

| Setting | Environment variable | JSON field | Default |
|---|---|---|---|
| API key | `TYPESAFE_API_KEY` | `apiKey` | none |
| Model | `PI_SKILL_JEV_MODEL` | `model` | `jev-latest` |
| Max questions per request | `PI_SKILL_JEV_SHARD_SIZE` | `shardSize` | `50` |
| Score floor, 0 to 2 | `PI_SKILL_JEV_MIN_SCORE` | `minScore` | `1.4` |
| Skills loaded per call | `PI_SKILL_JEV_MAX_SKILLS` | `maxSkills` | `3` |
| Request timeout, ms | `PI_SKILL_JEV_TIMEOUT_MS` | `timeoutMs` | `20000` |
| Description truncation | none | `descriptionLimit` | `1200` |
| Endpoint | `PI_SKILL_JEV_ENDPOINT` | `endpoint` | `https://api.typesafe.ai/v1/systemone` |

Keep the key in the config file with `0600` permissions, or in the environment. It is never passed on a command line.

```json
{
  "apiKey": "apikey_…",
  "minScore": 1.4,
  "maxSkills": 3
}
```

Raise `minScore` if too many adjacent skills load, and lower it if a relevant skill is missed.

## Install

```sh
pi install git:github.com/safzanpirani/pi-jev-skill-picker
```

Reload an existing Pi session with `/reload`, or start a new session.

This extension replaces `pi-skill-search`. Uninstall that one, along with its `pi-subagents` dependency if nothing else uses it. The old subagent picker forked the whole conversation into a child agent and needed a persisted session to do it. This one sends a single task string, so it needs neither.

## Tool parameters

`skill_search` accepts:

- `task`: required plain-language description of what the agent is about to do, naming the concrete tools, services or files involved
- `maxSkills`: optional limit from 1 to 5; defaults to the configured `maxSkills`
- `names`: optional list of exact skill names to load directly. When set, `task` is ignored and no ranking request is made.

A result loads the top `maxSkills` skills in full and then lists every other skill that cleared the floor, with its score and path. Nothing above the floor is hidden. A task like "review this diff and hand it to codex" puts 12 skills over 1.4, so the 9 that did not make the cut are named rather than dropped.

The agent loads one of those by calling `skill_search` again with `names`. That path reads the files straight off disk, so it skips Jev entirely and costs nothing.

That `task` string is everything Jev sees of the request, so ranking quality rests on it. When the wrong skills load, the string is recorded in the tool call details and is the first place to look.

Disabled skills stay undiscoverable, because the extension rates Pi's resolved enabled-skill list.

## Development

```sh
npm install
npm run check   # typecheck and unit tests
```

Tests stub `fetch`, so they make no network calls.
