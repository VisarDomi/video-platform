# Grep/search reference (oh-my-pi)

## Failure: `grep` blocked

```
Blocked: Use the `search` tool instead of grep/rg. It respects .gitignore and provides structured output.
```

**Cause:** The `bash` tool intercepts `grep`, `rg`, `awk` (for searching), and any shell command that
merely reads/trims bytes a dedicated tool can serve. These are blocked to enforce `.gitignore`
semantics and structured output.

**Fix:** Use `search` (regex) or `find` (filename glob) instead.

## Pass patterns

- **Regex search**: `search(pattern="console\\.(log|error|warn)\\(", paths=["src"])` — structured `LINE:TEXT` output with snapshot tags
- **Filename glob**: `find(paths=["src/**/*.ts"])`
- **Structural search**: `ast_grep(pat="console.log($$$)", paths=["src/**/*.ts"])`
