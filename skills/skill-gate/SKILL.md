---
name: skill-gate
description: Find useful external agent skills, inspect their source, contents, permissions, risk, and popularity before Codex uses them. Use when a task may benefit from a specialized external skill, when the user asks whether a skill is needed, when a user asks to search skills, inspect a skill package, temporarily use a skill, compare skill versions, or clean up temporary skill sessions. Do not use for ordinary coding tasks where Codex already has enough capability.
---

# Skill Gate

Skill Gate answers one question before Codex loads more instructions: does this task get real value from an external skill, and is that skill safe enough to use temporarily?

## Workflow

1. Decide whether an external skill is needed.
   - Do not search for ordinary coding, refactors, small bug fixes, or tasks Codex can already handle.
   - Search only when a specialized workflow, domain standard, repeated failure mode, or verifiable expert process would help.

2. Recommend the smallest useful set.
   - Run `skill-gate recommend "<user task>"`.
   - Use `--mode trusted`, `--mode popular`, or `--mode explorer` to select install thresholds.
   - Use `--force` only when the task is a specialized domain the keyword gate missed.
   - Show 0 to 3 non-overlapping skills.
   - Prefer concrete install counts over repository stars.
   - Prefer one broad skill over several narrow skills when coverage overlaps. The v1 CLI uses a lightweight token overlap heuristic; Codex must still apply judgment before recommending.
   - If more than one candidate is plausible, ask the user to choose before inspecting or using one.

3. Inspect before use.
   - Run `skill-gate inspect <owner/repo@skill>`.
   - This downloads or copies the candidate into an isolated `.skill-gate/sessions/<id>/` directory so it can be audited.
   - Summarize source, install count if known, pinned commit, files, capabilities, and risk.
   - Read `references/risk-policy.md` if risk interpretation matters.

4. Ask the user before loading.
   - Allowed choices are: use once, install for project, view full files, or reject.
   - Default to use once.
   - Never use or install an inspected skill unless the user approves. V1 does not require approval before isolated inspection download.
   - Prefer the app's short choice UI when available. If no choice UI is available, ask one concise numbered question in chat.

5. Apply the user's choice.
   - Run `skill-gate use <owner/repo@skill> --approve` only after user approval; it reuses the already inspected pinned session.
   - Run `skill-gate install <owner/repo@skill> --approve` only after explicit project-install approval; it copies the already inspected pinned files into `.skill-gate/project-skills/`.
   - Run `skill-gate view <owner/repo@skill>` when the user wants to inspect files without approval.
   - Run `skill-gate reject <owner/repo@skill>` or do nothing when the user rejects.
   - Read the temporary skill from `.skill-gate/sessions/<id>/skills/<skill>/SKILL.md`.
   - Do not execute scripts from HIGH risk skills. Treat them as view-only in v1.

6. Clean up after the task.
   - Run `skill-gate status` to show active temporary sessions.
   - When the task appears complete, ask the user whether to delete temporary sessions, keep them, or pack them.
   - Run `skill-gate cleanup --approve` only when the user explicitly chooses delete.
   - Run `skill-gate pack <name>` when the user chooses save as reusable pack.
   - Cleanup may delete only paths listed in the session manifest and only inside `.skill-gate`.
   - Never infer cleanup approval from task completion; the user may still want follow-up work.

## Delegation Mode

Use Delegation Mode when the user asks to split work across agents, mentions multiple agents, wants separate skills per agent, asks for a reviewer agent, or the task clearly spans three or more independent workflows.

- Run `skill-gate delegate "<task>"`.
- Output a plan only; do not spawn agents, download skills, install skills, or write files from this command.
- Keep 2 to 4 workstreams. If more than 4 appear, merge related work.
- Each workstream must name the agent role, scope, forbidden scope, suggested skill direction, input, output, and acceptance criteria.
- Reviewer Agent is read-only by default: it checks quality, conflicts, scope boundaries, and unapproved skill use, then reports findings only.
- One file or module must have exactly one owner agent. Shared files are changed only by the main agent.
- Each agent may use only skills assigned to its lane and approved by the main agent after user confirmation.

## Choice Prompts

Use a choice prompt when a decision materially changes the result and the user has not already specified it.

- Skill choice: after recommendation when 2 or 3 skills are plausible.
- Use mode: after inspection, choose use once / install for project / view files / reject.
- Style direction: before using design, writing, presentation, UI, image, or document skills when style is underspecified.
- Risk override: before any HIGH risk skill is used, and never to execute scripts in v1.
- Cleanup choice: when the task appears complete, ask delete / keep / pack before running cleanup.

Keep prompts small:

- Ask at most one question at a time.
- Offer 2 or 3 mutually exclusive options.
- Put the recommended/default option first and label it as recommended.
- Include one sentence per option explaining the tradeoff.
- Continue with the recommended option only if the choice is non-blocking; do not continue on use/install approval without an explicit user answer.

Style choice examples:

- SaaS/dashboard UI: "Quiet operational UI (Recommended)" / "Polished marketing style" / "Dense admin console".
- Writing: "Concise technical" / "Friendly explanatory" / "Formal report".
- Presentation: "Swiss grid" / "Editorial magazine" / "Minimal executive".

## Trust Rules

Read `references/trust-policy.md` before changing recommendation thresholds, source filters, or deduplication behavior.

## Commands

- `skill-gate recommend "<task>"`: analyze the task and recommend 0 to 3 skills.
- `skill-gate delegate "<task>"`: create a plan-only multi-agent work split with reviewer checklist.
- `skill-gate inspect <source>`: clone or read a skill into an isolated session and write `audit.json`.
- `skill-gate use <source> --approve`: approve and read the latest inspected pinned session for that source.
- `skill-gate view <source>`: inspect and show the temporary file path without approval.
- `skill-gate install <source> --approve`: copy the latest inspected pinned session into `.skill-gate/project-skills/`.
- `skill-gate reject [source]`: record an explicit no-op rejection.
- `skill-gate pack [name]`: save current temporary sessions as a reusable pack.
- `skill-gate status`: list temporary sessions and risks.
- `skill-gate cleanup --approve`: delete only current session files recorded in manifests after explicit user approval.
- `skill-gate diff <source>`: compare the pinned commit with the latest remote commit.
