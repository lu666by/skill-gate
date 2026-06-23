# Trust Policy

Use Skill Gate only when an external skill adds real capability.

Search when the task has a specialized workflow, domain rules, repeated error risk, trusted expert knowledge, or a verifiable process. Do not search for normal coding work.

Default mode is Popular:

- Trusted: at least 10000 installs.
- Popular: at least 1000 installs.
- Explorer: no install threshold; still requires inspect and explicit use/install approval.

V1 enforces install thresholds, exact-source deduplication, GitHub metadata checks, and resolver dry-runs.

Reject recommendations when:

- Catalog URL does not match the candidate source.
- GitHub publisher/repo metadata does not match the source.
- Repository is archived.
- License metadata is missing.
- Repository update date is missing or older than 365 days.
- The source cannot resolve to a `SKILL.md` before inspect.

Recommend at most 3 skills. Do not collapse different capability names unless the source string is exactly duplicated.
