![Skill Gate](assets/skill-gate.svg)

# Skill Gate

It finds the skill. It reads the package. You decide if Codex should trust it.

![npm test](https://img.shields.io/badge/test-passing-2ea44f?style=flat-square)
![Codex plugin](https://img.shields.io/badge/Codex-plugin-111827?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-CLI-3178c6?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-111827?style=flat-square)

0 to 3 recommendations | install counts over stars | pinned commits | temporary by default

Skill Gate is not a skill store. It is the small gate before Codex loads more instructions.

You ask for the work. Skill Gate asks the boring questions first:

```text
1. Does this task need an external skill?
2. Which popular skills actually match it?
3. Do their packages contain scripts, network calls, secrets, or global writes?
4. Has the user approved use?
5. Can the temporary session be cleaned up safely?
```

## Why

AI agents do not need a new skill for every ordinary coding task.

They do need help when a task has a real workflow, domain rules, or repeated failure traps: UI systems, documents, citations, GitHub reviews, spreadsheets, scientific figures, platform conventions.

Skill Gate keeps that choice explicit.

## Flow

```powershell
npm install
npm test

node dist/src/cli.js recommend "build a polished React admin dashboard"
node dist/src/cli.js inspect vercel-labs/agent-skills@vercel-react-best-practices
node dist/src/cli.js use vercel-labs/agent-skills@vercel-react-best-practices --approve
node dist/src/cli.js status
node dist/src/cli.js cleanup --approve
```

`inspect` creates an isolated `.skill-gate/sessions/<id>/` directory, writes `audit.json` and `manifest.json`, and pins the exact commit SHA. `use` and `install` reuse that inspected session instead of fetching a floating branch again.

## Commands

| Command | What it does |
|---|---|
| `recommend "<task>"` | Search real skill sources and return 0 to 3 non-overlapping candidates. |
| `inspect <source>` | Copy or clone a skill into an isolated session and audit it. |
| `use <source> --approve` | Mark the inspected pinned session approved for one temporary use. |
| `view <source>` | Download for review without approval. |
| `install <source> --approve` | Keep the inspected pinned files in this project. |
| `delegate "<task>"` | Produce a multi-agent split plan without spawning agents or changing files. |
| `status` | Show temporary sessions and approval state. |
| `pack [name]` | Save current sessions as a reusable pack. |
| `cleanup --approve` | Delete only manifest-owned session paths inside `.skill-gate`. |
| `diff <source>` | Compare the pinned commit with the current remote HEAD. |

## Risk Levels

| Risk | Meaning | V1 behavior |
|---|---|---|
| LOW | `SKILL.md` plus static references, no scripts or sensitive capability. | Can be used once after approval. |
| MEDIUM | Network instructions or project-file templates, no automatic execution. | Show summary before approval. |
| HIGH | Scripts, shell, env/secrets, global config, outside writes, delete commands, or prompt injection. | View-only. Do not execute scripts. |

## Shape

```text
Plugin = installed product
Skill  = Codex decision workflow
CLI    = search, inspect, pin, approve, clean up
MCP    = later, only if multiple agents need a shared service
```

Chinese usage notes: [USAGE.md](USAGE.md).

## Development

```powershell
npm test
```

The test is intentionally small: parser, thresholds, delegation plan, dedupe, risk scan, pinned-session approval, pack, and cleanup guard.

## License

[MIT](LICENSE).
