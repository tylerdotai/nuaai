---
name: skill-authoring
description: Create, validate, improve, and learn portable Agent Skills using the required SKILL.md format. Use when a user asks to create a skill, add trigger words, validate skill metadata, turn a workflow into a skill, or improve skill discoverability.
license: MIT
compatibility: Requires a NUAAI workspace with tracked skills/ or private .nuaai/skills/ directories.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "skill, skills, SKILL.md, create skill, author skill, validate skill, learn workflow, trigger words"
allowed-tools: "workspace.list workspace.read workspace.write workspace.command"
---

# Skill Authoring

## Required format

Create one directory per skill with a required `SKILL.md` file:

```text
skill-name/
├── SKILL.md
├── scripts/       # optional executable helpers
├── references/    # optional focused documentation
└── assets/        # optional templates and static resources
```

`SKILL.md` must contain YAML frontmatter followed by Markdown instructions.

Required frontmatter:

- `name`: 1–64 lowercase letters, numbers, and single hyphens; no leading, trailing, or consecutive hyphens; exactly matches the parent directory.
- `description`: 1–1024 characters; state what the skill does and when to use it, with concrete trigger vocabulary.

Optional frontmatter:

- `license`: short license name or bundled license reference.
- `compatibility`: 1–500 characters describing environment requirements.
- `metadata`: string-to-string values only. Put trigger words in `metadata.triggers` as a comma-separated string.
- `allowed-tools`: space-separated pre-approved tool names.

## Authoring workflow

1. Identify the repeated task and the activation words a user would naturally use.
2. Choose a lowercase directory name that exactly matches `name`.
3. Write a precise description covering both capability and activation conditions.
4. Put the shortest reliable procedure in `SKILL.md`; move large details to one-level-deep references.
5. Include steps, verification criteria, edge cases, and truthful failure handling.
6. Keep the main file below 500 lines and avoid secrets, private tokens, fabricated examples, and transient task results.
7. Validate metadata, directory/name equality, frontmatter boundaries, field lengths, and Markdown presence before loading.
8. Test trigger matching with both a matching phrase and a near miss.

## Learned skills

Only create a learned skill after an explicit learning request and a successful run. Store the workflow, not the model response or command output. Redact credentials and omit private runtime state. Learned skills belong in the private `.nuaai/skills/` directory and must pass the same validator as tracked skills.

See [references/supporting-files.md](references/supporting-files.md) for the references/scripts/assets contract and supporting-file verification order.
Run `node scripts/validate-skill.mjs <skill-directory>` before loading or learning a changed skill.
