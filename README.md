# pi-skill-jev

A Pi extension that keeps the full Agent Skills catalog out of model requests and replaces it with a single ranking tool backed by [TypeSafe's Jev](https://docs.typesafe.ai) System One model.

Skills stay loaded, so `/skill:name` keeps working. Before each agent turn the extension removes Pi's generated `<available_skills>` catalog from the effective system prompt and exposes one tool.

`skill_search` takes a plain-language description of the task, rates **every** enabled skill against it, and returns the complete `SKILL.md` instructions of the skills that actually apply.

## How the ranking works

Each skill becomes its own Score question. The task goes in the shared `state`; the skill's name and description go in that skill's own `instructions`. Questions are sharded into parallel requests, so a large catalog never crowds a single state and no skill is dropped by a keyword prefilter before the model sees it.

Every skill is rated on the same three ordered levels:

| Level | Meaning |
|---|---|
| 0 | Unrelated. A different domain, tool or workflow. |
| 1 | Adjacent. Same general area, not the specific thing the task needs. |
| 2 | Directly applicable. Covers the exact tool or workflow, and changes how the task is done. |

Jev returns a probability-weighted position on those levels. Code applies the floor, sorts, and loads the winners. A skill must lean toward "directly applicable" to be loaded; ties break on confidence.

Measured on a 169-skill catalog: seven parallel requests, roughly 48k input tokens, 0.6–2.0s end to end. Input tokens are the only billed tokens, so one ranking pass costs about $0.002.

## Fallback

If no API key is configured or every request fails, `skill_search` falls back to deterministic lexical matching and says so in its result. The fallback returns skill metadata and paths rather than loaded instructions, so the agent decides what to read.

## Configuration

Precedence is environment variable, then `skill-jev.json` under `PI_CODING_AGENT_DIR` (normally `~/.pi/agent`), then the package default.

| Setting | Environment variable | JSON field | Default |
|---|---|---|---|
| API key | `TYPESAFE_API_KEY` | `apiKey` | none |
| Model | `PI_SKILL_JEV_MODEL` | `model` | `jev-latest` |
| Questions per request | `PI_SKILL_JEV_SHARD_SIZE` | `shardSize` | `25` |
| Score floor, 0–2 | `PI_SKILL_JEV_MIN_SCORE` | `minScore` | `1.4` |
| Skills loaded per call | `PI_SKILL_JEV_MAX_SKILLS` | `maxSkills` | `3` |
| Request timeout, ms | `PI_SKILL_JEV_TIMEOUT_MS` | `timeoutMs` | `20000` |
| Description truncation | — | `descriptionLimit` | `1200` |
| Endpoint | `PI_SKILL_JEV_ENDPOINT` | `endpoint` | `https://api.typesafe.ai/v1/systemone` |

Keep the key in the config file with `0600` permissions, or in the environment. It is never passed on a command line.

```json
{
  "apiKey": "apikey_…",
  "minScore": 1.4,
  "maxSkills": 3
}
```

Raise `minScore` if too many adjacent skills load; lower it if a relevant skill is missed. Raise `shardSize` to cut request count, lower it if you see timeouts on a large catalog.

## Install

```sh
pi install git:github.com/safzanpirani/pi-skill-jev
```

Reload an existing Pi session with `/reload`, or start a new session.

This extension replaces `pi-skill-search`. Uninstall that one, along with its `pi-subagents` dependency if nothing else uses it. Unlike the subagent picker, this needs no persisted session and forks no conversation.

## Tool parameters

`skill_search` accepts:

- `task`: required plain-language description of what the agent is about to do, naming the concrete tools, services or files involved
- `maxSkills`: optional limit from 1 to 5; defaults to the configured `maxSkills`

Disabled skills stay undiscoverable, because the extension rates Pi's resolved enabled-skill list.

## Development

```sh
npm install
npm run check   # typecheck and unit tests
```

Tests stub `fetch`, so they make no network calls.
