# Supporting files for portable skills

A portable skill keeps the main `SKILL.md` short enough to load during discovery and moves detail into predictable child directories.

## Directory contract

```text
skill-name/
├── SKILL.md
├── references/    # focused Markdown procedures, contracts, and examples
├── scripts/       # bounded executable helpers
└── assets/        # templates or static resources when required
```

Use `references/` for information that explains a decision or procedure. Use `scripts/` for deterministic work that benefits from repeatable execution. Keep both directories one level below the skill directory so a loader can discover them without recursive repository scanning.

## Referencing a file

Every supporting file should be linked from `SKILL.md` with a relative path and a sentence explaining when to open or run it:

```markdown
See [references/supporting-files.md](references/supporting-files.md) for the directory contract.
Run `node scripts/validate-skill.mjs <skill-directory>` before loading a changed skill.
```

Do not paste credentials, runtime databases, private paths, transient run output, or invented external facts into a reference. Replace sensitive values with `[REDACTED]` and describe the value shape instead.

## Script contract

A skill script should:

1. use an explicit interpreter or executable entrypoint;
2. accept bounded arguments and fail clearly on invalid input;
3. avoid shell interpolation and unrestricted host control;
4. return a non-zero exit code on validation or execution failure;
5. print only the result needed by the operator;
6. avoid modifying files unless the skill explicitly documents the mutation.

Executable permission is part of the contract for scripts:

```bash
chmod 0755 scripts/<name>
```

## Validation order

1. Validate `SKILL.md` frontmatter and body.
2. Validate the parent directory/name match.
3. Check referenced files exist.
4. Check scripts are executable and syntactically valid.
5. Run a trigger match and a near-miss test through the NUAAI registry.

The bundled validator covers the first four checks. Trigger matching remains a runtime test because trigger semantics belong to the registry.
