#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
    symlinks: string[];
    hiddenFiles: string[];
    largeFiles: string[];
    largeCriticalFiles: string[];
    binaryFiles: string[];
    installHooks: boolean;
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
  usedAt?: string;
  expiresAt?: string;
};

type InspectOptions = {
  cwd?: string;
  approved?: boolean;
  sessionId?: string;
  installCount?: number | null;
  task?: string;
};

type ParsedSource = {
  owner: string;
  repo: string;
  repoUrl: string;
  skill?: string;
  ref?: string;
  path?: string;
};

type ScoredCandidate = Candidate & {
  fit: number;
  trust: number;
  tags: string[];
  reason: string;
};

type DecisionScores = {
  fit: number;
  trust: number;
  risk: number;
  maintenance: number;
  verdict: string;
  notes: string[];
};

type NeedRule = {
  pattern: RegExp;
  reason: string;
  query: string;
};

const ansiPattern = /\u001b\[[0-9;]*m/g;
const executableExts = new Set([".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".js", ".mjs", ".cjs", ".ts", ".py"]);
const maxAuditFileBytes = 1_000_000;
const needRules: NeedRule[] = [
  { pattern: /\breact\b/i, reason: "framework-specific workflow", query: "react" },
  { pattern: /\b(ui|ux|frontend|interface|dashboard)\b/i, reason: "interface design", query: "design" },
  { pattern: /\b(windows|winui)\b/i, reason: "platform conventions", query: "windows" },
  { pattern: /\b(accessibility|a11y)\b/i, reason: "accessibility review", query: "accessibility" },
  { pattern: /\b(pdf|docx|document)\b/i, reason: "document workflow", query: "pdf" },
  { pattern: /\b(excel|spreadsheet|csv)\b/i, reason: "spreadsheet workflow", query: "spreadsheet" },
  { pattern: /\b(powerpoint|presentation|slides?|ppt)\b/i, reason: "presentation workflow", query: "powerpoint" },
  { pattern: /\b(github|pull request|pr|issue|ci)\b/i, reason: "GitHub workflow", query: "github" },
  { pattern: /\bgmail\b/i, reason: "mail workflow", query: "gmail" },
  { pattern: /\b(hugging face|fine-?tune|ml training)\b/i, reason: "ML platform workflow", query: "hugging face" },
  { pattern: /\b(paper|citation|figure|academic)\b/i, reason: "academic workflow", query: "citation" }
];

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
  const reasons = needRules.filter((rule) => rule.pattern.test(task)).map((rule) => rule.reason);
  // ponytail: keyword gate; replace with model scoring when false negatives matter.
  return { needed: reasons.length > 0, reasons: [...new Set(reasons)] };
}

export function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.installs - a.installs);
  const kept: Candidate[] = [];
  const seen = new Set<string>();
  for (const candidate of sorted) {
    const key = candidate.source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(candidate);
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
  let raw: string;
  try {
    raw = run("npx", ["--yes", "skills", "find", query], process.cwd());
  } catch {
    throw new Error(`search failed: npx skills find ${query}`);
  }
  const minInstalls = thresholdForMode(mode);
  const candidates = dedupeCandidates(parseSkillsFind(raw).filter((item) => item.installs >= minInstalls))
    .map((item) => scoreCandidate(task, item))
    .sort((a, b) => (b.fit * 2 + b.trust) - (a.fit * 2 + a.trust) || b.installs - a.installs)
    .slice(0, 3);
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
    gate.reasons.length ? `Heuristic fit reasons: ${gate.reasons.join(", ")}` : "Forced search: keyword gate did not find a built-in reason.",
    "",
    "Recommended skills",
    ...candidates.map((item, index) => [
      `${index + 1}. ${item.source}`,
      `   Installs: ${item.installs.toLocaleString()}`,
      `   Fit: ${item.fit}/100; Trust: ${item.trust}/100`,
      `   Tags: ${item.tags.length ? item.tags.join(", ") : "unknown"}`,
      `   Why: ${item.reason}`,
      item.url ? `   Catalog: ${item.url}` : undefined,
      `   Next: skill-gate inspect ${item.source}`
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
  const { files, symlinks } = walkFileEntries(skillDir);
  const hashes: Record<string, string> = {};
  const texts = files.map((file) => {
    const absolute = join(skillDir, file);
    const stat = lstatSync(absolute);
    const bytes = stat.size <= maxAuditFileBytes ? readFileSync(absolute) : Buffer.from("");
    hashes[file] = hashFile(absolute);
    return { file: file.replaceAll("\\", "/"), bytes, size: stat.size, text: isTextish(file) && stat.size <= maxAuditFileBytes ? bytes.toString("utf8") : "" };
  });

  const isScriptFile = (file: string): boolean => {
    const lower = file.toLowerCase().replaceAll("\\", "/");
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
    return (lower.startsWith("scripts/") || lower.includes("/scripts/")) && executableExts.has(ext);
  };
  const executableScripts = files.filter(isScriptFile);
  const hiddenFiles = files.filter((file) => file.split(/[\\/]/).some((part) => part.startsWith(".") && part.length > 1));
  const largeFiles = files.filter((file) => lstatSync(join(skillDir, file)).size > maxAuditFileBytes);
  const largeCriticalFiles = largeFiles.filter((file) => {
    const posix = file.replaceAll("\\", "/");
    return posix === "SKILL.md" || posix.endsWith("/package.json") || posix === "package.json" || isScriptFile(posix);
  });
  const binaryFiles = texts.filter((item) => !isTextish(item.file) || looksBinary(item.bytes)).map((item) => item.file);
  const packageTexts = texts.filter((item) => item.file === "package.json" || item.file.endsWith("/package.json")).map((item) => item.text).join("\n");
  const skillText = texts.find((item) => item.file === "SKILL.md")?.text || "";
  const scriptText = texts.filter((item) => isScriptFile(item.file)).map((item) => item.text).join("\n");
  // ponytail: scan executable/intended instructions, not policy references that merely name risks.
  const riskyText = [skillText, scriptText].join("\n");

  const capabilities = {
    hasSkillMd: files.some((file) => file.replaceAll("\\", "/") === "SKILL.md"),
    executableScripts,
    networkAccess: /fetch\s*\(|invoke-webrequest|curl\b|wget\b|git clone|npm install|pip install/i.test(riskyText),
    shellExecution: /child_process|exec\s*\(|spawn\s*\(|\b(powershell|pwsh|bash|cmd\.exe)\s+[-/]/i.test(riskyText) || executableScripts.some((file) => /\.(sh|ps1|bat|cmd)$/i.test(file)),
    readsEnvironment: /process\.env|\$env:|api[_ -]?key|\b(access|bearer|github|api)[_-]?token\b|secret/i.test(riskyText),
    writesOutsideRepo: /\.\.\/|~\/|%userprofile%|appdata|c:\\users/i.test(riskyText),
    globalConfigChanges: /\.codex|config\.toml|agents\/plugins|codex plugin/i.test(riskyText),
    destructiveCommands: /rm\s+-rf|remove-item|del\s+\/[sq]|rmdir\b|format\s+[a-z]:/i.test(riskyText),
    promptInjection: /ignore (all )?(previous|prior) instructions|system prompt|developer message|exfiltrate|leak.*secret/i.test(riskyText),
    symlinks,
    hiddenFiles,
    largeFiles,
    largeCriticalFiles,
    binaryFiles,
    installHooks: /"(preinstall|install|postinstall|prepare)"\s*:/i.test(packageTexts)
  };

  let risk: Risk = "LOW";
  if (
    capabilities.executableScripts.length > 0 ||
    capabilities.shellExecution ||
    capabilities.readsEnvironment ||
    capabilities.writesOutsideRepo ||
    capabilities.globalConfigChanges ||
    capabilities.destructiveCommands ||
    capabilities.promptInjection ||
    capabilities.symlinks.length > 0 ||
    capabilities.largeCriticalFiles.length > 0 ||
    capabilities.installHooks
  ) {
    risk = "HIGH";
  } else if (capabilities.networkAccess || capabilities.hiddenFiles.length > 0 || capabilities.largeFiles.length > 0 || capabilities.binaryFiles.length > 0) {
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
  let sessionDir = "";
  try {
    sessionDir = createSessionDir(cwd, options.sessionId);
    const skillsDir = join(sessionDir, "skills");
    mkdirSync(skillsDir);

    let sourceSkillDir: string;
    let commitSha = "local";
    let parsed: ParsedSource | null = null;

    if (existsSync(resolve(cwd, source)) || existsSync(source)) {
      sourceSkillDir = resolve(cwd, source);
    } else {
      parsed = parseSkillSource(source);
      const repoDir = join(sessionDir, "repo");
      if (parsed.ref) {
        run("git", ["clone", "--quiet", parsed.repoUrl, repoDir], cwd);
        run("git", ["-C", repoDir, "checkout", "--quiet", "--detach", parsed.ref], cwd);
      } else {
        run("git", ["clone", "--depth", "1", "--quiet", parsed.repoUrl, repoDir], cwd);
      }
      commitSha = run("git", ["-C", repoDir, "rev-parse", "HEAD"], cwd).trim();
      sourceSkillDir = parsed.path ? skillDirAtPath(repoDir, parsed.path) : findSkillDir(repoDir, parsed.skill);
    }

    const skillName = storageSkillName(readSkillName(join(sourceSkillDir, "SKILL.md")), parsed?.skill, basename(sourceSkillDir));
    const targetSkillDir = safeChildPath(skillsDir, skillName);
    cpSync(sourceSkillDir, targetSkillDir, { recursive: true });

    const audit = auditSkill(targetSkillDir);
    audit.skill = skillName;
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
  } catch (error) {
    if (sessionDir && existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
    throw error;
  }
}

export function inspectText(source: string, options: InspectOptions = {}): string {
  const { sessionDir, audit, manifest } = inspectSource(source, options);
  const scores = decisionScores(audit, manifest, options.task);
  return [
    "Package inspection",
    `Session: ${sessionDir}`,
    `Source: ${manifest.source}`,
    `Pinned commit: ${manifest.commitSha}`,
    "",
    "Decision:",
    `Fit: ${scores.fit}/100`,
    `Trust: ${scores.trust}/100`,
    `Risk: ${scores.risk}/100`,
    `Maintenance: ${scores.maintenance}/100`,
    `Verdict: ${scores.verdict}`,
    ...scores.notes.map((note) => `- ${note}`),
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
    `Install hooks:        ${yesNo(audit.capabilities.installHooks)}`,
    `Symlinks:             ${audit.capabilities.symlinks.length ? audit.capabilities.symlinks.join(", ") : "No"}`,
    `Hidden files:         ${audit.capabilities.hiddenFiles.length ? audit.capabilities.hiddenFiles.join(", ") : "No"}`,
    `Large files:          ${audit.capabilities.largeFiles.length ? audit.capabilities.largeFiles.join(", ") : "No"}`,
    `Large critical files: ${audit.capabilities.largeCriticalFiles.length ? audit.capabilities.largeCriticalFiles.join(", ") : "No"}`,
    `Binary files:         ${audit.capabilities.binaryFiles.length ? audit.capabilities.binaryFiles.join(", ") : "No"}`,
    "",
    `Risk: ${audit.risk}`
  ].join("\n");
}

function decisionScores(audit: Audit, manifest: Manifest, task?: string): DecisionScores {
  const skillText = `${manifest.source} ${audit.skill} ${audit.files.join(" ")}`;
  const taskTags = task ? capabilityTags(task) : [];
  const skillTags = capabilityTags(skillText);
  const overlap = skillTags.filter((tag) => taskTags.includes(tag));
  const fit = task ? Math.min(100, 35 + overlap.length * 25) : 50;
  const trust = trustScore(manifest.installCount);
  const risk = audit.risk === "HIGH" ? 90 : audit.risk === "MEDIUM" ? 45 : 10;
  const maintenance = Math.max(20, Math.min(80,
    70 -
    audit.capabilities.largeFiles.length * 10 -
    audit.capabilities.binaryFiles.length * 5 -
    audit.capabilities.hiddenFiles.length * 5
  ));
  const notes = [
    task ? (overlap.length ? `Fit tags: ${overlap.join(", ")}` : "No task tag matched; benefit is weak.") : "Fit is unknown; pass --task to score usefulness.",
    manifest.installCount === null ? "Trust uses no install count; source metadata is unknown." : `Trust uses ${manifest.installCount.toLocaleString()} installs.`,
    "Risk score is severity; lower is safer.",
    "Maintenance is package hygiene only; archived/license/update metadata still requires a source metadata check."
  ];
  let verdict = "Usable once after approval.";
  if (audit.risk === "HIGH") verdict = "Reject for use; view-only.";
  else if (task && fit < 50) verdict = "Skip unless the user has a specific reason.";
  else if (trust < 50) verdict = "Inspect manually; trust signal is weak.";
  return { fit, trust, risk, maintenance, verdict, notes };
}

export function useText(source: string, approved: boolean, cwd = process.cwd()): string {
  if (!approved) {
    throw new Error("Refusing to use this skill without approval. Rerun with --approve after the user confirms.");
  }
  const inspected = latestInspectedSession(source, cwd);
  if (!inspected) throw new Error(`No inspected session for ${source}. Run inspect first, then approve use.`);
  if (inspected.manifest.risk === "HIGH") throw new Error("HIGH risk skills are view-only in v1. Use view to inspect files; scripts are not loaded or installed.");
  if (inspected.manifest.usedAt) throw new Error(`Temporary approval already used at ${inspected.manifest.usedAt}. Run inspect again for a fresh one-time approval.`);
  if (inspected.manifest.expiresAt && Date.parse(inspected.manifest.expiresAt) <= Date.now()) throw new Error(`Temporary approval expired at ${inspected.manifest.expiresAt}. Run inspect again.`);
  useManifest(inspected);
  const { manifest, path } = inspected;
  const sessionDir = dirname(path);
  return [
    "Temporary skill ready.",
    `Read: ${join(sessionDir, "skills", manifest.skill, "SKILL.md")}`,
    `Pinned commit: ${manifest.commitSha}`,
    `Risk: ${manifest.risk}`,
    `Expires: ${manifest.expiresAt}`,
    "Use once, then run cleanup."
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
    throw new Error("Refusing to install this skill without approval. Rerun with --approve after the user confirms.");
  }
  const inspected = latestInspectedSession(source, cwd);
  if (!inspected) throw new Error(`No inspected session for ${source}. Run inspect first, then approve install.`);
  if (inspected.manifest.risk === "HIGH") throw new Error("HIGH risk skills are view-only in v1. Use view to inspect files; project install is refused.");
  approveManifest(inspected);
  const { manifest, path } = inspected;
  const skillName = validateSkillName(manifest.skill);
  const sourceDir = safeChildPath(join(dirname(path), "skills"), skillName);
  const targetDir = safeChildPath(join(resolve(cwd), ".skill-gate", "project-skills"), skillName);
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
  const safeName = validatePackName(packName);
  const packDir = safeChildPath(join(resolve(cwd), ".skill-gate", "packs"), safeName);
  if (existsSync(packDir)) throw new Error(`Pack already exists: ${safeName}`);
  for (const { manifest, path } of manifests) {
    if (manifest.risk === "HIGH") throw new Error(`Refusing to pack HIGH risk skill: ${manifest.skill}`);
    const skillName = validateSkillName(manifest.skill);
    const skillDir = safeChildPath(join(dirname(path), "skills"), skillName);
    if (!existsSync(skillDir)) continue;
  }
  mkdirSync(join(packDir, "skills"), { recursive: true });
  for (const { manifest, path } of manifests) {
    const skillName = validateSkillName(manifest.skill);
    const skillDir = safeChildPath(join(dirname(path), "skills"), skillName);
    if (existsSync(skillDir)) cpSync(skillDir, safeChildPath(join(packDir, "skills"), skillName), { recursive: true });
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
      manifest.usedAt ? `  Used: ${manifest.usedAt}` : undefined,
      manifest.expiresAt ? `  Expires: ${manifest.expiresAt}` : undefined,
      `  Manifest: ${path}`
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

export function cleanupSessions(cwd = process.cwd(), approved = false): string {
  const manifests = readManifests(cwd);
  if (manifests.length === 0) return "No temporary Skill Gate sessions to clean.";
  const root = join(resolve(cwd), ".skill-gate");
  const targets = cleanupTargets(cwd, manifests);
  if (!approved) {
    return [
      `Cleanup preview: ${targets.length} manifest-owned path(s).`,
      ...targets.map((file) => `- ${file}`),
      "Rerun cleanup --approve to delete them."
    ].join("\n");
  }
  const removed: string[] = [];
  for (const file of targets) {
    safeRemove(root, resolve(cwd, file));
    removed.push(file);
  }
  return [`Removed ${removed.length} manifest-owned path(s).`, ...removed.map((file) => `- ${file}`)].join("\n");
}

export function safeRemove(root: string, target: string): void {
  const safeTarget = safeSkillGateTarget(root, target);
  if (existsSync(safeTarget)) rmSync(safeTarget, { recursive: true, force: true });
}

function cleanupTargets(cwd: string, manifests: Array<{ manifest: Manifest; path: string }>): string[] {
  const root = join(resolve(cwd), ".skill-gate");
  return manifests.flatMap(({ manifest }) => manifest.createdFiles.map((file) => {
    safeSkillGateTarget(root, resolve(cwd, file));
    return file;
  }));
}

function safeSkillGateTarget(root: string, target: string): string {
  const safeRoot = resolve(root);
  const safeTarget = resolve(target);
  const rel = relative(safeRoot, safeTarget);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing to remove outside .skill-gate: ${safeTarget}`);
  }
  return safeTarget;
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
      console.log(inspectText(args[0], { task: optionValue(args, "--task") }));
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
    process.exitCode = 1;
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
    "  skill-gate inspect <owner/repo@skill[#commit]|github-url|local-path> [--task \"<task>\"]",
    "  skill-gate use <source> --approve",
    "  skill-gate view <source>",
    "  skill-gate install <source> --approve",
    "  skill-gate reject [source]",
    "  skill-gate pack [name]",
    "  skill-gate status",
    "  skill-gate cleanup [--approve]",
    "  skill-gate diff <owner/repo@skill>"
  ].join("\n");
}

export function parseSkillSource(source: string): ParsedSource {
  if (source.startsWith("https://skills.sh/")) {
    const url = new URL(source);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3) throw new Error(`Expected skills.sh URL like https://skills.sh/owner/repo/skill, got: ${source}`);
    const [owner, repo, ...skillParts] = parts;
    const skill = skillParts.join("/");
    return { owner, repo, repoUrl: `https://github.com/${owner}/${repo}.git`, skill, ref: url.hash ? validateCommitRef(decodeURIComponent(url.hash.slice(1))) : undefined };
  }
  if (source.startsWith("https://github.com/")) {
    const url = new URL(source);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Expected GitHub URL like https://github.com/owner/repo, got: ${source}`);
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    const treeIndex = parts.indexOf("tree");
    const ref = treeIndex >= 0 ? parts[treeIndex + 1] : (url.hash ? validateCommitRef(decodeURIComponent(url.hash.slice(1))) : undefined);
    const path = treeIndex >= 0 ? parts.slice(treeIndex + 2).join("/") : undefined;
    return { owner, repo, repoUrl: `https://github.com/${owner}/${repo}.git`, ref, path, skill: path ? basename(path) : undefined };
  }
  const [body, ref] = splitFragment(source);
  const match = body.match(/^([^/@]+)\/([^/@]+)@(.+)$/);
  if (!match) throw new Error(`Expected source like owner/repo@skill or https://github.com/owner/repo/tree/ref/path, got: ${source}`);
  return {
    owner: match[1],
    repo: match[2],
    repoUrl: `https://github.com/${match[1]}/${match[2]}.git`,
    skill: match[3],
    ref
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

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function splitFragment(value: string): [string, string?] {
  const index = value.lastIndexOf("#");
  if (index < 0) return [value, undefined];
  const ref = value.slice(index + 1).trim();
  if (!ref) throw new Error(`Empty commit/ref fragment in source: ${value}`);
  return [value.slice(0, index), validateCommitRef(ref)];
}

function validateCommitRef(ref: string): string {
  if (!/^[0-9a-f]{40}$/i.test(ref)) throw new Error(`Expected 40-hex commit SHA, got: ${ref}`);
  return ref;
}

function findSkillDir(repoDir: string, skill?: string): string {
  if (!skill) {
    if (existsSync(join(repoDir, "SKILL.md"))) return repoDir;
    const matches = walkDirs(repoDir).filter((dir) => existsSync(join(dir, "SKILL.md")));
    if (matches.length === 1) return matches[0];
    throw new Error(`Could not choose a skill automatically; found ${matches.length} SKILL.md files. Use a GitHub /tree/<ref>/<path> URL.`);
  }
  const aliases = skillAliases(skill);
  const direct = [
    ...aliases.map((name) => join(repoDir, name, "SKILL.md")),
    ...aliases.map((name) => join(repoDir, "skills", name, "SKILL.md"))
  ];
  for (const file of direct) {
    if (existsSync(file)) return dirname(file);
  }
  const matches = walkDirs(repoDir).filter((dir) => aliases.includes(basename(dir)) && existsSync(join(dir, "SKILL.md")));
  if (matches[0]) return matches[0];
  const frontmatterMatches = walkDirs(repoDir).filter((dir) => existsSync(join(dir, "SKILL.md")) && aliases.includes((readSkillName(join(dir, "SKILL.md")) || "").replace(/:/g, "-")));
  if (frontmatterMatches.length === 1) return frontmatterMatches[0];
  if (frontmatterMatches.length > 1) throw new Error(`Multiple SKILL.md files declare ${skill}; use a GitHub /tree/<ref>/<path> URL.`);
  if (existsSync(join(repoDir, "SKILL.md"))) return repoDir;
  throw new Error(`Could not find SKILL.md for ${skill}`);
}

function skillDirAtPath(repoDir: string, path: string): string {
  const target = resolve(repoDir, path);
  const rel = relative(resolve(repoDir), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refusing skill path outside repo: ${path}`);
  if (!existsSync(join(target, "SKILL.md"))) throw new Error(`Could not find SKILL.md at ${path}`);
  return target;
}

function stripKnownPrefix(skill: string): string {
  return skill.replace(/^(vercel|anthropic|openai|google|meta|microsoft)-/, "");
}

function skillAliases(skill: string): string[] {
  const colonAsDash = skill.replace(/:/g, "-");
  const colonAsSlash = skill.replace(/:/g, "/");
  return [...new Set([
    skill,
    stripKnownPrefix(skill),
    colonAsDash,
    stripKnownPrefix(colonAsDash),
    colonAsSlash,
    stripKnownPrefix(colonAsSlash)
  ])];
}

function readSkillName(skillFile: string): string | null {
  if (!existsSync(skillFile)) return null;
  const text = readFileSync(skillFile, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const header = frontmatter?.[1] || "";
  const match = header.match(/^name:\s*["']?([^"'\r\n]+)["']?/m);
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

function latestInspectedSession(source: string, cwd = process.cwd()): { manifest: Manifest; path: string } | null {
  const match = readManifests(cwd)
    .filter((item) => item.manifest.source === source)
    .sort((a, b) => b.path.localeCompare(a.path))[0];
  if (!match) return null;
  validateSkillName(match.manifest.skill);
  return match;
}

function approveManifest(match: { manifest: Manifest; path: string }): void {
  match.manifest.approvedByUser = true;
  match.manifest.approvedAt = new Date().toISOString();
  writeJson(match.path, match.manifest);
}

function useManifest(match: { manifest: Manifest; path: string }): void {
  const now = new Date().toISOString();
  match.manifest.approvedByUser = true;
  match.manifest.approvedAt ||= now;
  match.manifest.usedAt = now;
  match.manifest.expiresAt = now;
  writeJson(match.path, match.manifest);
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

function validateSkillName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return name;
}

function validatePackName(name: string): string {
  if (!name) throw new Error("Invalid pack name: empty");
  return validateSkillName(name);
}

function safeChildPath(parent: string, childName: string): string {
  const target = resolve(parent, validateSkillName(childName));
  const rel = relative(resolve(parent), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing path outside target directory: ${target}`);
  }
  return target;
}

function storageSkillName(declared: string | null, sourceSkill: string | undefined, fallback: string): string {
  if (declared && /^[A-Za-z0-9._-]+$/.test(declared) && declared !== "." && declared !== "..") return declared;
  if (declared && sourceSkill && declared === sourceSkill && declared.includes(":")) return validateSkillName(declared.replace(/:/g, "-"));
  if (declared && sourceSkill && declared.replace(/:/g, "-") === sourceSkill) return validateSkillName(sourceSkill);
  if (declared) throw new Error(`Invalid skill name: ${declared}`);
  if (sourceSkill && sourceSkill.includes(":")) return validateSkillName(sourceSkill.replace(/:/g, "-"));
  return validateSkillName(sourceSkill || fallback);
}

function hashFile(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function looksBinary(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.3;
}

function walkFiles(root: string): string[] {
  return walkFileEntries(root).files;
}

function walkFileEntries(root: string): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  walkFileEntriesInto(root, "", files, symlinks);
  return { files: files.sort(), symlinks: symlinks.sort() };
}

function walkFileEntriesInto(root: string, prefix: string, files: string[], symlinks: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = toPosix(prefix ? join(prefix, entry.name) : entry.name);
    const absolute = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks.push(relativePath);
    } else if (entry.isDirectory()) {
      walkFileEntriesInto(absolute, relativePath, files, symlinks);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
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

function scoreCandidate(task: string, candidate: Candidate): ScoredCandidate {
  const tags = capabilityTags(candidate.source);
  const taskTags = capabilityTags(task);
  const overlap = tags.filter((tag) => taskTags.includes(tag));
  const fit = Math.min(100, 35 + overlap.length * 25 + (candidate.source.toLowerCase().includes(queryForTask(task).toLowerCase()) ? 15 : 0));
  const trust = trustScore(candidate.installs);
  return {
    ...candidate,
    fit,
    trust,
    tags,
    reason: overlap.length ? `matches ${overlap.join(", ")}` : "install-trusted candidate; inspect before use"
  };
}

function trustScore(installs: number | null | undefined): number {
  if (!installs) return 45;
  if (installs >= 100000) return 90;
  if (installs >= 10000) return 80;
  if (installs >= 1000) return 65;
  return 45;
}

function capabilityTags(value: string): string[] {
  const lower = value.toLowerCase();
  const tags: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/\b(react|next|jsx|tsx)\b/, "react"],
    [/\b(ui|ux|design|components?|frontend|dashboard|screen)\b/, "ui"],
    [/\b(perf|performance|speed|render|rerender|bundle)\b/, "performance"],
    [/\b(accessibility|a11y)\b/, "accessibility"],
    [/\b(github|pull request|pr|issue|ci)\b/, "github"],
    [/\b(pdf|docx|document|spreadsheet|excel|ppt|powerpoint)\b/, "documents"],
    [/\b(test|qa|review|lint)\b/, "quality"],
    [/\b(data|api|database|backend|server)\b/, "backend"],
    [/\b(hugging face|model|fine.?tune|training|ml)\b/, "ml"],
    [/\b(citation|paper|figure|academic)\b/, "academic"]
  ];
  for (const [pattern, tag] of rules) {
    if (pattern.test(lower)) tags.push(tag);
  }
  return [...new Set(tags)];
}

function queryForTask(task: string): string {
  return needRules.find((rule) => rule.pattern.test(task))?.query || task.split(/\s+/).slice(0, 4).join(" ");
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

function createSessionDir(cwd: string, requestedId?: string): string {
  const root = join(resolve(cwd), ".skill-gate", "sessions");
  mkdirSync(root, { recursive: true });
  if (requestedId) {
    const sessionDir = safeChildPath(root, requestedId);
    mkdirSync(sessionDir);
    return sessionDir;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionDir = safeChildPath(root, timestamp());
    try {
      mkdirSync(sessionDir);
      return sessionDir;
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not create a unique Skill Gate session.");
}

function timestamp(): string {
  return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-")}-${randomBytes(3).toString("hex")}`;
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
