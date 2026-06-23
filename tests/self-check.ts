import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  auditSkill,
  cleanupSessions,
  dedupeCandidates,
  delegateText,
  installText,
  inspectSource,
  packText,
  parseSkillsFind,
  safeRemove,
  taskNeedsSkill,
  thresholdForMode,
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
assert.deepEqual(deduped.map((item) => item.source), ["demo/repo@frontend-design", "demo/repo@typography-helper"]);

const fixtureRoot = join(process.cwd(), "fixtures");
assert.equal(auditSkill(join(fixtureRoot, "safe-skill")).risk, "LOW");
assert.equal(auditSkill(join(fixtureRoot, "scripted-skill")).risk, "HIGH");
assert.equal(auditSkill(join(fixtureRoot, "malicious-skill")).capabilities.promptInjection, true);
assert.notEqual(auditSkill(join(process.cwd(), "skills", "skill-gate")).risk, "HIGH");

const temp = mkdtempSync(join(tmpdir(), "skill-gate-"));
const badSkill = join(temp, "bad-skill");
mkdirSync(badSkill, { recursive: true });
writeFileSync(join(badSkill, "SKILL.md"), "---\nname: ../../escape\ndescription: bad\n---\n");
assert.throws(() => inspectSource(badSkill, { cwd: temp, sessionId: "bad" }), /Invalid skill name/);
assert.equal(existsSync(join(temp, ".skill-gate", "sessions", "escape")), false);
writeFileSync(join(badSkill, "SKILL.md"), "---\nname: ..\\escape\ndescription: bad\n---\n");
assert.throws(() => inspectSource(badSkill, { cwd: temp, sessionId: "bad-win" }), /Invalid skill name/);

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
  createdFiles: [".skill-gate/sessions/test"]
}));
assert.match(packText("demo-pack", temp), /Saved reusable pack/);
assert.equal(existsSync(join(temp, ".skill-gate", "packs", "demo-pack", "skills", "demo", "SKILL.md")), true);
assert.match(useText("local", true, temp), /Pinned commit: local/);
assert.equal(readdirSync(join(temp, ".skill-gate", "sessions")).length, 1);
assert.equal(JSON.parse(readFileSync(join(session, "manifest.json"), "utf8")).approvedByUser, true);
assert.match(installText("local", true, temp), /Installed pinned inspected skill/);
assert.equal(existsSync(join(temp, ".skill-gate", "project-skills", "demo", "SKILL.md")), true);
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
assert.throws(() => cleanupSessions(temp), /requires user approval/);
assert.equal(existsSync(session), true);
assert.match(cleanupSessions(temp, true), /Removed 1/);
assert.equal(existsSync(session), false);

assert.throws(() => safeRemove(resolve(temp, ".skill-gate"), resolve(temp, "outside")), /Refusing/);
assert.throws(() => safeRemove(resolve(temp, ".skill-gate"), resolve(temp, ".skill-gate")), /Refusing/);

console.log("self-check ok");
