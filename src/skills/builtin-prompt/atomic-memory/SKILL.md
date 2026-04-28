description: Use when the task involves the Atomic Memory system from ~/.claude, including Workflow Guardian hooks, atom rules, V4/V4.1 scopes, episodic memory, or the _AIDocs knowledge base.

# Atomic Memory

Use this skill when the user refers to:
- `原子記憶`
- `Atomic Memory`
- `Workflow Guardian`
- `~/.claude/_AIDocs`
- Claude-side memory / hook / episodic / conflict-review rules

## What To Read

Read only the minimum needed:

1. If available, prefer the imported CatClaw copy:
   - `~/.catclaw/aidocs/claude-atomic-memory/_AIDocs/_INDEX.md`
2. If that copy does not exist, fall back to the original source:
   - `~/.claude/_AIDocs/_INDEX.md`
3. For setup/overview, use:
   - `~/.catclaw/aidocs/claude-atomic-memory/README.md`
   - `~/.catclaw/aidocs/claude-atomic-memory/TECH.md`
   - fallback to `~/.claude/README.md` and `~/.claude/TECH.md`

## Recommended Document Order

- `_INDEX.md` for routing
- `Architecture.md` for hook/event architecture
- `Project_File_Tree.md` for file layout
- `SPEC_ATOM_V4.md` for scope and conflict semantics
- `V4.1-design-roundtable.md` for user-decision extraction and gating
- `DocIndex-System.md` for system-wide file lookup

## How To Apply It In CatClaw

- Treat Atomic Memory docs as the source of truth for Claude-side behavior.
- Map concepts onto CatClaw instead of blindly copying implementation details.
- Reuse existing CatClaw subsystems first:
  - `src/hooks/` for hook/event attachment
  - `src/memory/` for atom/recall/extract/episodic
  - `src/workflow/` for rut/wisdom/failure automation
  - `src/tools/builtin/atom-write.ts` and `/migrate` for operator entrypoints
- When there is a mismatch, preserve CatClaw architecture and port the Atomic Memory semantics.

## Scope Translation Notes

- Claude V4 `shared` usually maps to CatClaw project-shared memory behavior.
- Claude V4 `personal` usually maps to account or user-private memory behavior.
- Claude V4 `role` usually maps to role-scoped project knowledge, which CatClaw may need as an added layer rather than a direct existing primitive.
- Claude `episodic` and `wisdom` concepts map onto CatClaw `memory/episodic.ts` and `workflow/wisdom-engine.ts`.
