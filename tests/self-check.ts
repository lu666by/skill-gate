import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  auditSkill,
  cleanupSessions,
  candidateCatalogMatchesSource,
  dedupeCandidates,
  delegateText,
  evaluateCandidateQuality,
  findSkillDir,
  installText,
  inspectText,
  inspectSource,
  applyText,
  packText,
  parseSkillSource,
  parseSkillsFind,
  recommend,
  resolveCandidateInRepo,
  safeRemove,
  taskNeedsSkill,
  thresholdForMode,
  upgradeText,
  useText
} from "../src/cli";

const sampleFind = [
  "\u001b[38;5;145mvercel-labs/agent-skills@vercel-react-best-practices\u001b[0m \u001b[36m496.5K installs\u001b[0m",
  "\u001b[38;5;102m└ https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices\u001b[0m"
].join("\n");

const parsed = parseSkillsFind(sampleFind);
assert.equal(parsed.length, 1);
assert.equal(parsed[0].source, "vercel-labs/agent-skills@vercel-react-best-practices");
assert.equal(parsed[0].installs, 496500);
assert.equal(parsed[0].url, "https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices");

assert.equal(thresholdForMode("trusted"), 10000);
assert.equal(thresholdForMode("popular"), 1000);
assert.equal(thresholdForMode("explorer"), 0);

assert.equal(taskNeedsSkill("rename this variable").needed, false);
assert.equal(taskNeedsSkill("build a polished React admin dashboard").needed, true);
assert.equal(taskNeedsSkill("reactor control variable").needed, false);
assert.equal(taskNeedsSkill("paperwork cleanup").needed, false);
assert.equal(taskNeedsSkill("frontend accessibility audit").needed, true);

const delegation = delegateText("build a React dashboard with API, tests, and README");
assert.match(delegation, /Reviewer Agent/);
assert.match(delegation, /## Conflict Rules/);
assert.doesNotMatch(delegation, /--approve/);
assert.match(delegation, /UI\/design agent/);
assert.match(delegation, /Backend\/data agent/);
assert.match(delegation, /Tests\/QA agent/);
assert.match(delegation, /Docs\/release agent/);
assert.match(delegateText("rename this variable"), /No split recommended/);

const deduped = dedupeCandidates([
  { source: "demo/repo@frontend-design", installs: 10000 },
  { source: "demo/repo@typography-helper", installs: 9000 },
  { source: "demo/repo@frontend-typography", installs: 1000 }
]);
assert.deepEqual(deduped.map((item) => item.source), ["demo/repo@frontend-design", "demo/repo@typography-helper", "demo/repo@frontend-typography"]);
assert.deepEqual(dedupeCandidates([
  { source: "demo/repo@react-design", installs: 1000 },
  { source: "demo/repo@react-testing", installs: 900 },
  { source: "demo/repo@react-design", installs: 10 }
]).map((item) => item.source), ["demo/repo@react-design", "demo/repo@react-testing"]);

const commit = "0123456789abcdef0123456789abcdef01234567";
assert.equal(parseSkillSource(`owner/repo@skill#${commit}`).skill, "skill");
assert.equal(parseSkillSource(`owner/repo@skill#${commit}`).ref, commit);
assert.equal(parseSkillSource("owner/repo@react:components").skill, "react:components");
assert.throws(() => parseSkillSource("owner/repo@skill#main"), /40-hex/);
assert.throws(() => parseSkillSource("owner/repo@skill#"), /Empty/);
assert.throws(() => parseSkillSource("owner/repo@../x"), /Invalid skill selector/);
assert.throws(() => parseSkillSource("owner/repo@..\\x"), /Invalid skill selector/);
assert.throws(() => parseSkillSource("owner/repo@/x"), /Invalid skill selector/);

const goodFacts = {
  owner: "owner",
  repo: "repo",
  archived: false,
  license: "MIT",
  updatedAt: "2026-06-01T00:00:00Z"
};
const goodCandidate = {
  source: "owner/repo@skill",
  installs: 1000,
  url: "https://skills.sh/owner/repo/skill"
};
assert.equal(candidateCatalogMatchesSource(goodCandidate).accepted, true);
assert.equal(candidateCatalogMatchesSource({ source: "owner/repo@skill", installs: 1000 }).accepted, false);
assert.equal(evaluateCandidateQuality(goodCandidate, goodFacts, { ok: true, skill: "skill" }, new Date("2026-06-24T00:00:00Z")).accepted, true);
assert.equal(evaluateCandidateQuality(goodCandidate, { ...goodFacts, archived: true }, { ok: true }, new Date("2026-06-24T00:00:00Z")).accepted, false);
assert.equal(evaluateCandidateQuality(goodCandidate, { ...goodFacts, license: null }, { ok: true }, new Date("2026-06-24T00:00:00Z")).accepted, false);
assert.equal(evaluateCandidateQuality(goodCandidate, { ...goodFacts, license: "NOASSERTION" }, { ok: true }, new Date("2026-06-24T00:00:00Z")).accepted, false);
assert.equal(evaluateCandidateQuality(goodCandidate, { ...goodFacts, updatedAt: "not-a-date" }, { ok: true }, new Date("2026-06-24T00:00:00Z")).accepted, false);
assert.equal(evaluateCandidateQuality(goodCandidate, { ...goodFacts, updatedAt: "2024-01-01T00:00:00Z" }, { ok: true }, new Date("2026-06-24T00:00:00Z")).accepted, false);
assert.equal(evaluateCandidateQuality(goodCandidate, goodFacts, { ok: false, error: "missing SKILL.md" }, new Date("2026-06-24T00:00:00Z")).accepted, false);
assert.equal(candidateCatalogMatchesSource({ ...goodCandidate, url: "https://skills.sh/other/repo/skill" }).accepted, false);

const fixtureRoot = join(process.cwd(), "fixtures");
assert.equal(auditSkill(join(fixtureRoot, "safe-skill")).risk, "LOW");
assert.equal(auditSkill(join(fixtureRoot, "scripted-skill")).risk, "HIGH");
assert.equal(auditSkill(join(fixtureRoot, "malicious-skill")).capabilities.promptInjection, true);
assert.notEqual(auditSkill(join(process.cwd(), "skills", "skill-gate")).risk, "HIGH");

const temp = mkdtempSync(join(tmpdir(), "skill-gate-"));
const repoBoundary = join(temp, "repo-boundary");
const nestedSkill = join(repoBoundary, "react", "components");
const outsideSkill = join(temp, "outside-skill");
mkdirSync(nestedSkill, { recursive: true });
mkdirSync(outsideSkill, { recursive: true });
writeFileSync(join(nestedSkill, "SKILL.md"), "---\nname: react-components\ndescription: nested\n---\n");
writeFileSync(join(outsideSkill, "SKILL.md"), "---\nname: outside\ndescription: outside\n---\n");
assert.equal(findSkillDir(repoBoundary, "react:components"), nestedSkill);
assert.equal(resolveCandidateInRepo("owner/repo@react:components", repoBoundary).ok, true);
assert.equal(resolveCandidateInRepo("owner/repo@missing", repoBoundary).ok, false);
assert.throws(() => findSkillDir(repoBoundary, "../outside-skill"), /outside repo/);

const badSkill = join(temp, "bad-skill");
mkdirSync(badSkill, { recursive: true });
writeFileSync(join(badSkill, "SKILL.md"), "---\nname: ../../escape\ndescription: bad\n---\n");
assert.throws(() => inspectSource(badSkill, { cwd: temp, sessionId: "bad" }), /Invalid skill name/);
assert.equal(existsSync(join(temp, ".skill-gate", "sessions", "escape")), false);
writeFileSync(join(badSkill, "SKILL.md"), "---\nname: ..\\escape\ndescription: bad\n---\n");
assert.throws(() => inspectSource(badSkill, { cwd: temp, sessionId: "bad-win" }), /Invalid skill name/);
writeFileSync(join(badSkill, "SKILL.md"), "---\nname: safe-name\ndescription: ok\n---\n\nname: ../../body-is-not-frontmatter\n");
assert.equal(inspectSource(badSkill, { cwd: temp, sessionId: "body-name" }).manifest.skill, "safe-name");
const dupSession = inspectSource(badSkill, { cwd: temp, sessionId: "dup" }).sessionDir;
assert.throws(() => inspectSource(badSkill, { cwd: temp, sessionId: "dup" }), /exist|EEXIST/i);
assert.equal(existsSync(dupSession), true);
assert.throws(() => inspectSource(badSkill, { cwd: temp, sessionId: ".." }), /Invalid skill name/);
const generatedA = inspectSource(badSkill, { cwd: temp }).sessionDir;
const generatedB = inspectSource(badSkill, { cwd: temp }).sessionDir;
assert.notEqual(generatedA, generatedB);
const decision = inspectText(badSkill, { cwd: temp, task: "build a frontend dashboard" });
assert.match(decision, /Decision:/);
assert.match(decision, /Fit: \d+\/100/);
assert.match(decision, /Trust: \d+\/100/);
assert.match(decision, /Risk: \d+\/100/);
assert.match(decision, /Maintenance: \d+\/100/);
cleanupSessions(temp, true);

const auditEdge = join(temp, "audit-edge");
mkdirSync(join(auditEdge, "deep", "scripts"), { recursive: true });
writeFileSync(join(auditEdge, "SKILL.md"), "---\nname: audit-edge\ndescription: edge\n---\n");
writeFileSync(join(auditEdge, ".hidden"), "x");
writeFileSync(join(auditEdge, "image.bin"), Buffer.from([0, 1, 2, 3]));
writeFileSync(join(auditEdge, "payload.md"), Buffer.from([65, 0, 66]));
writeFileSync(join(auditEdge, "large.txt"), Buffer.alloc(1_000_001, "a"));
writeFileSync(join(auditEdge, "deep", "scripts", "run.sh"), "curl https://example.com");
writeFileSync(join(auditEdge, "deep", "scripts", "run.js"), "console.log(process.env.SECRET)");
writeFileSync(join(auditEdge, "package.json"), JSON.stringify({ scripts: { postinstall: "node setup.js" } }));
const edgeAudit = auditSkill(auditEdge);
assert.equal(edgeAudit.capabilities.executableScripts.includes("deep/scripts/run.sh"), true);
assert.equal(edgeAudit.capabilities.networkAccess, true);
assert.equal(edgeAudit.capabilities.readsEnvironment, true);
assert.equal(edgeAudit.capabilities.hiddenFiles.includes(".hidden"), true);
assert.equal(edgeAudit.capabilities.binaryFiles.includes("image.bin"), true);
assert.equal(edgeAudit.capabilities.binaryFiles.includes("payload.md"), true);
assert.equal(edgeAudit.capabilities.largeFiles.includes("large.txt"), true);
assert.equal(edgeAudit.capabilities.installHooks, true);
assert.equal(edgeAudit.risk, "HIGH");

const largeCore = join(temp, "large-core");
mkdirSync(largeCore, { recursive: true });
writeFileSync(join(largeCore, "SKILL.md"), Buffer.alloc(1_000_001, "x"));
const largeCoreAudit = auditSkill(largeCore);
assert.equal(largeCoreAudit.capabilities.largeCriticalFiles.includes("SKILL.md"), true);
assert.notEqual(largeCoreAudit.hashes["SKILL.md"], createHash("sha256").digest("hex"));
assert.equal(largeCoreAudit.risk, "HIGH");

const symlinkSkill = join(temp, "symlink-skill");
mkdirSync(symlinkSkill, { recursive: true });
writeFileSync(join(symlinkSkill, "SKILL.md"), "---\nname: symlink-skill\ndescription: symlink\n---\n");
try {
  symlinkSync(join(symlinkSkill, "SKILL.md"), join(symlinkSkill, "link.md"));
  const symlinkAudit = auditSkill(symlinkSkill);
  assert.equal(symlinkAudit.capabilities.symlinks.includes("link.md"), true);
  assert.equal(symlinkAudit.risk, "HIGH");
} catch {
  // Windows may require Developer Mode or elevated privileges for symlink creation.
}

const session = join(temp, ".skill-gate", "sessions", "test");
mkdirSync(join(session, "skills", "demo"), { recursive: true });
writeFileSync(join(session, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "demo",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "LOW",
  approvedByUser: true,
  scope: "temporary",
  expiresAt: "2000-01-01T00:00:00.000Z",
  createdFiles: [".skill-gate/sessions/test"]
}));
assert.throws(() => useText("local", true, temp), /expired/);
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "demo",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "LOW",
  approvedByUser: true,
  scope: "temporary",
  createdFiles: [".skill-gate/sessions/test"]
}));
assert.match(packText("demo-pack", temp), /Saved reusable pack/);
assert.equal(existsSync(join(temp, ".skill-gate", "packs", "demo-pack", "skills", "demo", "SKILL.md")), true);
assert.throws(() => packText("demo-pack", temp), /already exists/);
assert.throws(() => packText("..", temp), /Invalid skill name/);
assert.throws(() => packText("bad pack", temp), /Invalid skill name/);
assert.match(useText("local", true, temp), /Pinned commit: local/);
assert.throws(() => useText("local", true, temp), /already used/);
assert.equal(readdirSync(join(temp, ".skill-gate", "sessions")).length, 1);
assert.equal(JSON.parse(readFileSync(join(session, "manifest.json"), "utf8")).approvedByUser, true);
assert.match(JSON.parse(readFileSync(join(session, "manifest.json"), "utf8")).usedAt, /\d{4}-/);
assert.match(JSON.parse(readFileSync(join(session, "manifest.json"), "utf8")).expiresAt, /\d{4}-/);
assert.match(installText("local", true, temp), /Installed pinned inspected skill/);
assert.equal(existsSync(join(temp, ".skill-gate", "project-skills", "demo", "SKILL.md")), true);
assert.match(applyText("local", true, temp), /Applied latest inspected skill/);
const upgradeTemp = mkdtempSync(join(tmpdir(), "skill-gate-upgrade-"));
const upgradeSource = join(upgradeTemp, "upgrade-source");
mkdirSync(upgradeSource, { recursive: true });
writeFileSync(join(upgradeSource, "SKILL.md"), "---\nname: upgrade-source\ndescription: upgrade\n---\n");
inspectSource(upgradeSource, { cwd: upgradeTemp });
assert.match(applyText(upgradeSource, true, upgradeTemp), /Applied latest inspected skill/);
assert.match(upgradeText(upgradeSource, upgradeTemp), /Upgrade check/);
assert.match(upgradeText(upgradeSource, upgradeTemp), /Changed: No/);
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "demo",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "HIGH",
  approvedByUser: false,
  scope: "temporary",
  createdFiles: [".skill-gate/sessions/test"]
}));
assert.throws(() => useText("local", true, temp), /HIGH risk/);
assert.throws(() => installText("local", true, temp), /HIGH risk/);
assert.throws(() => packText("bad-pack", temp), /HIGH risk/);
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "../../escape",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "LOW",
  approvedByUser: true,
  scope: "temporary",
  createdFiles: [".skill-gate/sessions/test"]
}));
assert.throws(() => installText("local", true, temp), /Invalid skill name/);
assert.throws(() => useText("local", true, temp), /Invalid skill name/);
assert.throws(() => packText("bad-pack", temp), /Invalid skill name/);
assert.equal(existsSync(join(temp, "escape")), false);
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "..\\escape",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "LOW",
  approvedByUser: true,
  scope: "temporary",
  createdFiles: [".skill-gate/sessions/test"]
}));
assert.throws(() => installText("local", true, temp), /Invalid skill name/);
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "demo",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "LOW",
  approvedByUser: true,
  scope: "temporary",
  createdFiles: [".skill-gate/sessions/test"]
}));
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "demo",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "LOW",
  approvedByUser: true,
  scope: "temporary",
  createdFiles: ["../outside"]
}));
assert.throws(() => cleanupSessions(temp), /outside .skill-gate/);
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "demo",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "LOW",
  approvedByUser: true,
  scope: "temporary",
  createdFiles: [".skill-gate"]
}));
assert.throws(() => cleanupSessions(temp), /outside .skill-gate/);
writeFileSync(join(session, "manifest.json"), JSON.stringify({
  skill: "demo",
  source: "local",
  installCount: null,
  commitSha: "local",
  risk: "LOW",
  approvedByUser: true,
  scope: "temporary",
  createdFiles: [".skill-gate/sessions/test"]
}));
assert.match(cleanupSessions(temp), /Cleanup preview: 1/);
assert.equal(existsSync(session), true);
assert.match(cleanupSessions(temp, true), /Removed 1/);
assert.equal(existsSync(session), false);

assert.throws(() => safeRemove(resolve(temp, ".skill-gate"), resolve(temp, "outside")), /Refusing/);
assert.throws(() => safeRemove(resolve(temp, ".skill-gate"), resolve(temp, ".skill-gate")), /Refusing/);

async function asyncChecks(): Promise<void> {
  const rawRecommend = [
    "owner/good@react 2K installs",
    "  https://skills.sh/owner/good/react",
    "owner/archived@react 2K installs",
    "  https://skills.sh/owner/archived/react",
    "owner/stale@react 2K installs",
    "  https://skills.sh/owner/stale/react",
    "owner/nolicense@react 2K installs",
    "  https://skills.sh/owner/nolicense/react",
    "owner/badresolver@react 2K installs",
    "  https://skills.sh/owner/badresolver/react"
  ].join("\n");
  const recommendation = await recommend("build a React dashboard", "explorer", false, {
    rawSearch: rawRecommend,
    now: new Date("2026-06-24T00:00:00Z"),
    factsProvider: (source) => ({
      owner: source.owner,
      repo: source.repo,
      archived: source.repo === "archived",
      license: source.repo === "nolicense" ? null : "MIT",
      updatedAt: source.repo === "stale" ? "2024-01-01T00:00:00Z" : "2026-06-01T00:00:00Z"
    }),
    resolver: (source) => source.includes("badresolver") ? { ok: false, error: "missing SKILL.md" } : { ok: true, skill: "react" }
  });
  assert.match(recommendation, /owner\/good@react/);
  assert.doesNotMatch(recommendation, /owner\/archived@react/);
  assert.doesNotMatch(recommendation, /owner\/stale@react/);
  assert.doesNotMatch(recommendation, /owner\/nolicense@react/);
  assert.doesNotMatch(recommendation, /owner\/badresolver@react/);
}

asyncChecks()
  .then(() => console.log("self-check ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
