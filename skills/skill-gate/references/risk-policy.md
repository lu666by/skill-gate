# Risk Policy

LOW:

- Only `SKILL.md` and static references.
- No scripts.
- No network, secrets, global config, or writes outside the project.

MEDIUM:

- Templates or project files.
- Network instructions or dependency install commands that are not executed automatically.

HIGH:

- Executable scripts, nested `scripts/`, package install hooks, or symlinks.
- Shell, PowerShell, or external downloads.
- Environment variables, API keys, secrets, or global Codex config.
- Writes outside the project, administrator privileges, delete commands, or prompt-injection language.

V1 rule: HIGH skills are view-only. Do not execute their scripts.
