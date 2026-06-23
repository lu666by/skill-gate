#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type Risk = "LOW" | "MEDIUM" | "HIGH";

export type Candidate = {
  source: string;
  installs: number;
  url?: string;
};

export type ThresholdMode = "trusted" | "popular" | "explorer";

export type Audit = {
  skill: string;
  files: string[];
  hashes: Record<string, string>;
  capabilities: {
    hasSkillMd: boolean;
    executableScripts: string[];
    networkAccess: boolean;
    shellExecution: boolean;
    readsEnvironment: boolean;
    writesOutsideRepo: boolean;
    globalConfigChanges: boolean;
    destructiveCommands: boolean;
    promptInjection: boolean;
  };
  risk: Risk;
};

export type Manifest = {
  skill: string;
  source: string;
  installCount: number | null;
  commitSha: string;
  risk: Risk;
  approvedByUser: boolean;
  scope: "temporary";
  createdFiles: string[];
  approvedAt?: string;
};

type InspectOptions = {
  cwd?: string;
  approved?: boolean;
  sessionId?: string;
  installCount?: number | null;
};

const ansiPattern = /\u001b\[[0-9;]*m/g;
const executableExts = new Set([".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".js", ".mjs", ".cjs", ".ts", ".py"]);

export function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

export function parseInstallCount(value: string): number {
  const match = value.trim().match(/^([\d.]+)\s*([KkMm])?$/);
  if (!match) return 0;
  const base = Number(match[1]);
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "M") return Math.round(base * 1_000_000);
  if (suffix === "K") return Math.round(base * 1_000);
  return Math.round(base);
}

export function parseSkillsFind(output: string): Candidate[] {
  const clean = stripAnsi(output);
  const lines = clean.split(/\r?\n/);
  const results: Candidate[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].trim().match(/^([^\s]+\/[^\s]+@[^\s]+)\s+([\d.]+\s*[KkMm]?)\s+installs$/);
    if (!match) continue;
    const urlLine = (lines[i + 1] || "").replace(/^[^\w:/.-]+/, "").trim();
    results.push({
      source: match[1],
      installs: parseInstallCount(match[2]),
      url: urlLine.startsWith("http") ? urlLine : undefined
    });
  }
  return results;
}

export function taskNeedsSkill(task: string): { needed: boolean; reasons: string[] } {
  const lower = task.toLowerCase();
  const triggers = [
    ["ui", "interface design"],
    ["react", "framework-specific workflow"],
    ["windows", "platform conventions"],
    ["winui", "platform conventions"],
    ["accessibility", "accessibility review"],
    ["pdf", "document workflow"],
    ["docx", "document workflow"],
    ["excel", "spreadsheet workflow"],
    ["spreadsheet", "spreadsheet workflow"],
    ["powerpoint", "presentation workflow"],
    ["github", "GitHub workflow"],
    ["gmail", "mail workflow"],
    ["hugging face", "ML platform workflow"],
    ["fine-tune", "ML training workflow"],
    ["paper", "academic workflow"],
    ["citation", "academic citation workflow"],
    ["figure", "scientific figure workflow"],
    ["dashboard", "product UI workflow"]
  ];
  const reasons = triggers.filter(([word]) => lower.includes(word)).map(([, reason]) => reason);
  // ponytail: keyword gate; replace with model scoring when false negatives matter.
  return { needed: reasons.length > 0, reasons: [...new Set(reasons)] };
}

export function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.installs - a.installs);
  const kept: Candidate[] = [];
  for (const candidate of sorted) {
    const tokens = skillTokens(candidate.source);
    const covered = kept.some((item) => {
      const existing = skillTokens(item.source);
      const overlap = [...tokens].filter((token) => existing.has(token)).length;
      return overlap >= Math.min(tokens.size, existing.size, 2);
    });
    if (!covered) kept.push(candidate);
  }
  return kept;
}

export function thresholdForMode(mode: ThresholdMode): number {
  if (mode === "trusted") return 10000;
  if (mode === "explorer") return 0;
  return 1000;
}

export function recommend(task: string, mode: ThresholdMode = "popular", force = false): string {
  const gate = taskNeedsSkill(task);
  if (!gate.needed && !force) {
    return [
      "No external skill is necessary for this task.",
      "Continue with Codex only, or rerun with --force if this is a specialized domain the keyword gate missed."
    ].join("\n");
  }

  const query = queryForTask(task);
  const raw = run("npx", ["--yes", "skills", "find", query], process.cwd(), true);
  const minInstalls = thresholdForMode(mode);
  const candidates = dedupeCandidates(parseSkillsFind(raw).filter((item) => item.installs >= minInstalls)).slice(0, 3);
  if (candidates.length === 0) {
    return [
      "Skill Gate analysis",
      gate.reasons.length ? `External expertise may help with: ${gate.reasons.join(", ")}` : "Forced search: keyword gate did not find a built-in reason.",
      `No skill met the ${mode} install threshold (${minInstalls}).`,
      "Continue with Codex only or rerun with --mode explorer."
    ].join("\n");
  }

  return [
    "Skill Gate analysis",
    gate.reasons.length ? `External expertise may help with: ${gate.reasons.join(", ")}` : "Forced search: keyword gate did not find a built-in reason.",
    "",
    "Recommended skills",
    ...candidates.map((item, index) => [
      `${index + 1}. ${item.source}`,
      `   Installs: ${item.installs.toLocaleString()}`,
      item.url ? `   Source: ${item.url}` : undefined,
      "   Next: inspect before use"
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

type Lane = {
  role: string;
  owns: string;
  forbidden: string;
  skill: string;
  input: string;
  output: string;
  acceptance: string;
};

export function delegateText(task: string): string {
  const lanes = delegationLanes(task);
  const small = lanes.length === 0;
  const work = small ? fallbackLanes() : lanes.slice(0, 4);

  return [
    "# Delegation Plan",
    "",
    "## Task Split",
    small
      ? "No split recommended: this looks small enough for the main agent. Use the reviewer only if the change touches shared behavior."
      : work.map((lane, index) => `${index + 1}. ${lane.role}: ${lane.owns}`).join("\n"),
    "",
    "## Agent Assignments",
    ...work.map((lane, index) => [
      `### Agent ${index + 1}: ${lane.role}`,
      `Scope: ${lane.owns}`,
      `Do not touch: ${lane.forbidden}`,
      `Input: ${lane.input}`,
      `Output: ${lane.output}`,
      `Acceptance: ${lane.acceptance}`
    ].join("\n")),
    "### Reviewer Agent",
    "Scope: read-only review of outputs, file ownership, unapproved skill use, tests, and integration risk.",
    "Do not touch: source files, generated artifacts, plugin installs, or session manifests.",
    "Output: findings only, ordered by severity.",
    "",
    "## Skill Plan",
    ...work.map((lane) => `- ${lane.role}: ${lane.skill}`),
    "- Reviewer Agent: no skill install by default; use only built-in review judgment unless the main agent approves a read-only review skill.",
    "",
    "## Conflict Rules",
    "- One file or module has exactly one owner agent.",
    "- Shared files are changed only by the main agent.",
    "- Each agent may use only skills assigned to its lane and approved by the main agent.",
    "- Reviewer Agent does not write fixes; it reports findings.",
    "- All skill use/install approval remains with the main agent after user confirmation.",
    "",
    "## Reviewer Checklist",
    "- Scope boundaries were respected.",
    "- No unapproved skill was used or installed.",
    "- No two agents edited the same owned file/module.",
    "- Outputs integrate into one coherent user-facing result.",
    "- Tests or checks cover the risky parts of the split.",
    "",
    "## Next Commands",
    "- Main agent: inspect any proposed skill before use.",
    "- Main agent: assign file ownership before implementation starts.",
    "- Reviewer agent: review after agents report outputs, before final merge."
  ].join("\n");
}

export function auditSkill(skillDir: string): Audit {
  const files = walkFiles(skillDir);
  const hashes: Record<string, string> = {};
  const text = files.map((file) => {
    const absolute = join(skillDir, file);
    const bytes = readFileSync(absolute);
    hashes[file] = createHash("sha256").update(bytes).digest("hex");
    return isTextish(file) ? bytes.toString("utf8") : "";
  }).join("\n");

  const executableScripts = files.filter((file) => {
    const lower = file.toLowerCase().replaceAll("\\", "/");
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
    return lower.startsWith("scripts/") && executableExts.has(ext);
  });

  const capabilities = {
    hasSkillMd: files.some((file) => file.replaceAll("\\", "/") === "SKILL.md"),
    executableScripts,
    networkAccess: /\bhttps?:\/\/|fetch\s*\(|invoke-webrequest|curl\b|wget\b|git clone|npm install|pip install/i.test(text),
    shellExecution: /child_process|exec\s*\(|spawn\s*\(|powershell|pwsh|bash\b|cmd\.exe/i.test(text) || executableScripts.some((file) => /\.(sh|ps1|bat|cmd)$/i.test(file)),
    readsEnvironment: /process\.env|\$env:|api[_-]?key|token|secret/i.test(text),
    writesOutsideRepo: /\.\.\/|~\/|%userprofile%|appdata|c:\\users/i.test(text),
    globalConfigChanges: /\.codex|config\.toml|agents\/plugins|codex plugin/i.test(text),
    destructiveCommands: /rm\s+-rf|remove-item|del\s+\/[sq]|rmdir\b|format\s+[a-z]:/i.test(text),
    promptInjection: /ignore (all )?(previous|prior) instructions|system prompt|developer message|exfiltrate|leak.*secret/i.test(text)
  };

  let risk: Risk = "LOW";
  if (
    capabilities.executableScripts.length > 0 ||
    capabilities.shellExecution ||
    capabilities.readsEnvironment ||
    capabilities.writesOutsideRepo ||
    capabilities.globalConfigChanges ||
    capabilities.destructiveCommands ||
    capabilities.promptInjection
  ) {
    risk = "HIGH";
  } else if (capabilities.networkAccess) {
    risk = "MEDIUM";
  }

  return {
    skill: readSkillName(join(skillDir, "SKILL.md")) || basename(skillDir),
    files,
    hashes,
    capabilities,
    risk
  };
}

export function inspectSource(source: string, options: InspectOptions = {}): { sessionDir: string; audit: Audit; manifest: Manifest } {
  const cwd = resolve(options.cwd || process.cwd());
  const sessionId = options.sessionId || timestamp();
  const sessionDir = join(cwd, ".skill-gate", "sessions", sessionId);
  const skillsDir = join(sessionDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  let sourceSkillDir: string;
  let commitSha = "local";
  let parsed: ReturnType<typeof parseSkillSource> | null = null;

  if (existsSync(resolve(cwd, source)) || existsSync(source)) {
    sourceSkillDir = resolve(cwd, source);
  } else {
    parsed = parseSkillSource(source);
    const repoDir = join(sessionDir, "repo");
    run("git", ["clone", "--depth", "1", "--quiet", parsed.repoUrl, repoDir], cwd);
    commitSha = run("git", ["-C", repoDir, "rev-parse", "HEAD"], cwd).trim();
    sourceSkillDir = findSkillDir(repoDir, parsed.skill);
  }

  const skillName = readSkillName(join(sourceSkillDir, "SKILL.md")) || parsed?.skill || basename(sourceSkillDir);
  const targetSkillDir = join(skillsDir, skillName);
  cpSync(sourceSkillDir, targetSkillDir, { recursive: true });

  const audit = auditSkill(targetSkillDir);
  const manifest: Manifest = {
    skill: audit.skill,
    source,
    installCount: options.installCount ?? null,
    commitSha,
    risk: audit.risk,
    approvedByUser: options.approved === true,
    scope: "temporary",
    createdFiles: [toPosix(relative(cwd, sessionDir))]
  };

  writeJson(join(sessionDir, "audit.json"), audit);
  writeJson(join(sessionDir, "manifest.json"), manifest);

  return { sessionDir, audit, manifest };
}

export function inspectText(source: string, options: InspectOptions = {}): string {
  const { sessionDir, audit, manifest } = inspectSource(source, options);
  return [
    "Package inspection",
    `Session: ${sessionDir}`,
    `Source: ${manifest.source}`,
    `Pinned commit: ${manifest.commitSha}`,
    "",
    "Files:",
    ...audit.files.map((file) => `- ${file}`),
    "",
    "Capabilities:",
    `Network access:       ${yesNo(audit.capabilities.networkAccess)}`,
    `Shell execution:      ${yesNo(audit.capabilities.shellExecution)}`,
    `Environment variables: ${yesNo(audit.capabilities.readsEnvironment)}`,
    `Writes outside repo:  ${yesNo(audit.capabilities.writesOutsideRepo)}`,
    `Global config changes: ${yesNo(audit.capabilities.globalConfigChanges)}`,
    `Executable scripts:   ${audit.capabilities.executableScripts.length ? audit.capabilities.executableScripts.join(", ") : "No"}`,
    "",
    `Risk: ${audit.risk}`
  ].join("\n");
}

export function useText(source: string, approved: boolean, cwd = process.cwd()): string {
  if (!approved) {
    return "Refusing to use this skill without approval. Rerun with --approve after the user confirms.";
  }
  const inspected = approveInspectedSession(source, cwd);
  if (!inspected) return `No inspected session for ${source}. Run inspect first, then approve use.`;
  const { manifest, path } = inspected;
  const sessionDir = dirname(path);
  return [
    "Temporary skill ready.",
    `Read: ${join(sessionDir, "skills", manifest.skill, "SKILL.md")}`,
    `Pinned commit: ${manifest.commitSha}`,
    `Risk: ${manifest.risk}`,
    manifest.risk === "HIGH" ? "V1 rule: view only; do not execute scripts." : "Use once, then run cleanup."
  ].join("\n");
}

export function viewText(source: string): string {
  const { sessionDir, audit } = inspectSource(source, { approved: false });
  return [
    "Skill files ready for review.",
    `Session: ${sessionDir}`,
    `Open: ${join(sessionDir, "skills", audit.skill, "SKILL.md")}`,
    `Risk: ${audit.risk}`,
    "No approval recorded and no skill loaded."
  ].join("\n");
}

export function installText(source: string, approved: boolean, cwd = process.cwd()): string {
  if (!approved) {
    return "Refusing to install this skill without approval. Rerun with --approve after the user confirms.";
  }
  const inspected = approveInspectedSession(source, cwd);
  if (!inspected) return `No inspected session for ${source}. Run inspect first, then approve install.`;
  const { manifest, path } = inspected;
  const sourceDir = join(dirname(path), "skills", manifest.skill);
  const targetDir = join(resolve(cwd), ".skill-gate", "project-skills", manifest.skill);
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  return [
    "Installed pinned inspected skill for this project.",
    `Source: ${source}`,
    `Skill: ${manifest.skill}`,
    `Pinned commit: ${manifest.commitSha}`,
    `Path: ${targetDir}`,
    `Risk: ${manifest.risk}`,
    manifest.risk === "HIGH" ? "V1 rule still applies: do not execute bundled scripts automatically." : "Project install complete."
  ].join("\n");
}

export function packText(packName = `pack-${timestamp()}`, cwd = process.cwd()): string {
  const manifests = readManifests(cwd);
  if (manifests.length === 0) return "No temporary Skill Gate sessions to pack.";
  const safeName = packName.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const packDir = join(resolve(cwd), ".skill-gate", "packs", safeName);
  mkdirSync(join(packDir, "skills"), { recursive: true });
  for (const { manifest, path } of manifests) {
    const skillDir = join(dirname(path), "skills", manifest.skill);
    if (existsSync(skillDir)) cpSync(skillDir, join(packDir, "skills", manifest.skill), { recursive: true });
  }
  writeJson(join(packDir, "manifest.json"), {
    name: safeName,
    createdAt: new Date().toISOString(),
    sessions: manifests.map((item) => item.manifest)
  });
  return `Saved reusable pack: ${packDir}`;
}

export function rejectText(source?: string): string {
  return source ? `Rejected ${source}. No files loaded.` : "Rejected. No files loaded.";
}

export function statusText(cwd = process.cwd()): string {
  const manifests = readManifests(cwd);
  if (manifests.length === 0) return "No temporary Skill Gate sessions.";
  return [
    "Temporary Skill Gate sessions",
    ...manifests.map(({ manifest, path }) => [
      `- ${manifest.skill}`,
      `  Source: ${manifest.source}`,
      `  Risk: ${manifest.risk}`,
      `  Approved: ${yesNo(manifest.approvedByUser)}`,
      `  Manifest: ${path}`
    ].join("\n"))
  ].join("\n");
}

export function cleanupSessions(cwd = process.cwd(), approved = false): string {
  if (!approved) return "Cleanup requires user approval. Ask whether to delete temporary Skill Gate sessions, then rerun cleanup --approve.";
  const manifests = readManifests(cwd);
  if (manifests.length === 0) return "No temporary Skill Gate sessions to clean.";
  const root = join(resolve(cwd), ".skill-gate");
  const removed: string[] = [];
  for (const { manifest } of manifests) {
    for (const file of manifest.createdFiles) {
      safeRemove(root, resolve(cwd, file));
      removed.push(file);
    }
  }
  return [`Removed ${removed.length} manifest-owned path(s).`, ...removed.map((file) => `- ${file}`)].join("\n");
}

export function safeRemove(root: string, target: string): void {
  const safeRoot = resolve(root);
  const safeTarget = resolve(target);
  if (safeTarget !== safeRoot && !safeTarget.startsWith(safeRoot + "\\" ) && !safeTarget.startsWith(safeRoot + "/")) {
    throw new Error(`Refusing to remove outside .skill-gate: ${safeTarget}`);
  }
  if (existsSync(safeTarget)) rmSync(safeTarget, { recursive: true, force: true });
}

export function diffText(source: string, cwd = process.cwd()): string {
  const parsed = parseSkillSource(source);
  const latest = run("git", ["ls-remote", parsed.repoUrl, "HEAD"], cwd).split(/\s+/)[0];
  const current = readManifests(cwd).find((item) => item.manifest.source === source)?.manifest.commitSha;
  if (!current) return `No local manifest for ${source}. Latest remote commit: ${latest}`;
  if (current === latest) return `${source} is up to date at ${current}.`;
  return `${source} changed.\nLocal:  ${current}\nRemote: ${latest}`;
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "recommend" || command === "search") {
      const mode = parseMode(args);
      const force = args.includes("--force");
      const task = args.filter((arg, index) => !["--explorer", "--trusted", "--popular", "--force", "--mode"].includes(arg) && args[index - 1] !== "--mode").join(" ");
      console.log(recommend(task, mode, force));
      return;
    }
    if (command === "inspect") {
      requireSource(args[0]);
      console.log(inspectText(args[0]));
      return;
    }
    if (command === "delegate") {
      console.log(delegateText(args.join(" ")));
      return;
    }
    if (command === "use") {
      requireSource(args[0]);
      console.log(useText(args[0], args.includes("--approve")));
      return;
    }
    if (command === "view") {
      requireSource(args[0]);
      console.log(viewText(args[0]));
      return;
    }
    if (command === "install") {
      requireSource(args[0]);
      console.log(installText(args[0], args.includes("--approve")));
      return;
    }
    if (command === "pack") {
      console.log(packText(args[0]));
      return;
    }
    if (command === "reject") {
      console.log(rejectText(args[0]));
      return;
    }
    if (command === "status" || command === "list") {
      console.log(statusText());
      return;
    }
    if (command === "cleanup") {
      console.log(cleanupSessions(process.cwd(), args.includes("--approve")));
      return;
    }
    if (command === "diff") {
      requireSource(args[0]);
      console.log(diffText(args[0]));
      return;
    }
    console.log(helpText());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`skill-gate: ${message}`);
    process.exitCode = 1;
  }
}

function helpText(): string {
  return [
    "Usage:",
    "  skill-gate recommend \"<task>\" [--mode trusted|popular|explorer] [--force]",
    "  skill-gate delegate \"<task>\"",
    "  skill-gate inspect <owner/repo@skill|local-path>",
    "  skill-gate use <source> --approve",
    "  skill-gate view <source>",
    "  skill-gate install <source> --approve",
    "  skill-gate reject [source]",
    "  skill-gate pack [name]",
    "  skill-gate status",
    "  skill-gate cleanup --approve",
    "  skill-gate diff <owner/repo@skill>"
  ].join("\n");
}

function parseSkillSource(source: string): { owner: string; repo: string; repoUrl: string; skill: string } {
  const match = source.match(/^([^/@]+)\/([^/@]+)@(.+)$/);
  if (!match) throw new Error(`Expected source like owner/repo@skill, got: ${source}`);
  return {
    owner: match[1],
    repo: match[2],
    repoUrl: `https://github.com/${match[1]}/${match[2]}.git`,
    skill: match[3]
  };
}

function parseMode(args: string[]): ThresholdMode {
  if (args.includes("--trusted")) return "trusted";
  if (args.includes("--explorer")) return "explorer";
  if (args.includes("--popular")) return "popular";
  const modeIndex = args.indexOf("--mode");
  if (modeIndex >= 0) {
    const value = args[modeIndex + 1];
    if (value === "trusted" || value === "popular" || value === "explorer") return value;
    throw new Error(`unknown mode: ${value}`);
  }
  return "popular";
}

function findSkillDir(repoDir: string, skill: string): string {
  const aliases = [skill, stripKnownPrefix(skill)];
  const direct = [
    ...aliases.map((name) => join(repoDir, name, "SKILL.md")),
    ...aliases.map((name) => join(repoDir, "skills", name, "SKILL.md"))
  ];
  for (const file of direct) {
    if (existsSync(file)) return dirname(file);
  }
  const matches = walkDirs(repoDir).filter((dir) => aliases.includes(basename(dir)) && existsSync(join(dir, "SKILL.md")));
  if (matches[0]) return matches[0];
  if (existsSync(join(repoDir, "SKILL.md"))) return repoDir;
  throw new Error(`Could not find SKILL.md for ${skill}`);
}

function stripKnownPrefix(skill: string): string {
  return skill.replace(/^(vercel|anthropic|openai|google|meta|microsoft)-/, "");
}

function readSkillName(skillFile: string): string | null {
  if (!existsSync(skillFile)) return null;
  const match = readFileSync(skillFile, "utf8").match(/^name:\s*["']?([^"'\r\n]+)["']?/m);
  return match ? match[1].trim() : null;
}

function readManifests(cwd: string): Array<{ manifest: Manifest; path: string }> {
  const root = join(resolve(cwd), ".skill-gate", "sessions");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "manifest.json"))
    .filter((file) => existsSync(file))
    .map((file) => ({ manifest: JSON.parse(readFileSync(file, "utf8")) as Manifest, path: file }));
}

function approveInspectedSession(source: string, cwd = process.cwd()): { manifest: Manifest; path: string } | null {
  const match = readManifests(cwd)
    .filter((item) => item.manifest.source === source)
    .sort((a, b) => b.path.localeCompare(a.path))[0];
  if (!match) return null;
  match.manifest.approvedByUser = true;
  match.manifest.approvedAt = new Date().toISOString();
  writeJson(match.path, match.manifest);
  return match;
}

function run(command: string, args: string[], cwd: string, allowFailure = false): string {
  const actual = command === "git" && process.platform === "win32" ? "git.exe" : command;
  try {
    return execFileSync(actual, args, {
      cwd,
      encoding: "utf8",
      shell: command === "npx" && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const child of walkFiles(absolute)) out.push(toPosix(join(entry.name, child)));
    } else if (entry.isFile()) {
      out.push(toPosix(entry.name));
    }
  }
  return out.sort();
}

function walkDirs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = join(root, entry.name);
    out.push(absolute, ...walkDirs(absolute));
  }
  return out;
}

function isTextish(file: string): boolean {
  return /\.(md|txt|yaml|yml|json|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1|bat|cmd|py)$/i.test(file);
}

function skillTokens(source: string): Set<string> {
  const name = source.split("@").pop() || source;
  const stop = new Set(["skill", "skills", "helper", "best", "practices"]);
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !stop.has(token)));
}

function queryForTask(task: string): string {
  const lower = task.toLowerCase();
  const choices: Array<[string, string]> = [
    ["react", "react"],
    ["windows", "windows"],
    ["winui", "winui"],
    ["accessibility", "accessibility"],
    ["dashboard", "dashboard"],
    ["ui", "design"],
    ["pdf", "pdf"],
    ["docx", "docx"],
    ["excel", "excel"],
    ["spreadsheet", "spreadsheet"],
    ["powerpoint", "powerpoint"],
    ["github", "github"],
    ["gmail", "gmail"],
    ["hugging face", "hugging face"],
    ["fine-tune", "fine tune"],
    ["citation", "citation"],
    ["figure", "figure"]
  ];
  return choices.find(([needle]) => lower.includes(needle))?.[1] || task.split(/\s+/).slice(0, 4).join(" ");
}

function delegationLanes(task: string): Lane[] {
  const lower = task.toLowerCase();
  const lanes: Lane[] = [];
  if (/\b(ui|ux|design|react|frontend|dashboard|page|screen|style|visual)\b/i.test(lower)) {
    lanes.push({
      role: "UI/design agent",
      owns: "layout, visual direction, interaction states, accessibility basics",
      forbidden: "backend APIs, data migrations, release notes",
      skill: "Suggest a frontend/design skill only after inspect; ask style choice first if direction is unclear.",
      input: "product goal, target users, existing UI conventions",
      output: "UI plan or implementation notes with owned files/modules",
      acceptance: "matches chosen style, no overlapping ownership, responsive/accessibility basics covered"
    });
  }
  if (/\b(api|backend|server|database|db|data|auth|integration|storage|model)\b/i.test(lower)) {
    lanes.push({
      role: "Backend/data agent",
      owns: "API shape, data flow, persistence, integration boundaries",
      forbidden: "visual styling, copywriting, release packaging",
      skill: "Suggest backend/data/API skills only after inspect.",
      input: "required behavior, current schemas/configs, trust boundaries",
      output: "backend plan or implementation notes with contracts and owned files/modules",
      acceptance: "interfaces are explicit, validation/error paths are covered, no UI ownership conflict"
    });
  }
  if (/\b(test|tests|qa|review|ci|bug|verify|validation|coverage)\b/i.test(lower)) {
    lanes.push({
      role: "Tests/QA agent",
      owns: "test cases, verification commands, regression risks",
      forbidden: "feature implementation except tiny test fixtures",
      skill: "Suggest QA/test/review skills only after inspect.",
      input: "changed behavior, acceptance criteria, existing test commands",
      output: "test plan, failing-risk list, and minimal runnable checks",
      acceptance: "checks fail on likely regressions and avoid unrelated fixture churn"
    });
  }
  if (/\b(doc|docs|readme|usage|release|changelog|manual|guide|presentation|ppt|report)\b/i.test(lower)) {
    lanes.push({
      role: "Docs/release agent",
      owns: "README/usage docs, changelog, release notes, user-facing explanation",
      forbidden: "runtime code and test logic",
      skill: "Suggest writing/docs/release skills only after inspect.",
      input: "implemented behavior, commands, known limitations",
      output: "documentation updates and release/change summary",
      acceptance: "docs match actual CLI behavior and do not promise unimplemented features"
    });
  }
  return lanes;
}

function fallbackLanes(): Lane[] {
  return [
    {
      role: "Main implementation agent",
      owns: "the whole small task",
      forbidden: "unapproved external skills and speculative refactors",
      skill: "No external skill by default.",
      input: "user request and current repo context",
      output: "single scoped change or answer",
      acceptance: "solves the task without unnecessary delegation"
    }
  ];
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function yesNo(value: boolean): "Yes" | "No" {
  return value ? "Yes" : "No";
}

function requireSource(source: string | undefined): asserts source is string {
  if (!source) throw new Error("missing skill source");
}

if (require.main === module) main();
