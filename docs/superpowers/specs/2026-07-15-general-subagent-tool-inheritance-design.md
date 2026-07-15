# General Subagent and Parent Tool Inheritance Design

**Date:** 2026-07-15
**Status:** Approved
**Base:** `feat/pi-subagents`

## 1. Purpose

Simplify the lightweight Subagents extension around one bundled general-purpose child role that is available whenever the extension loads. Optional user-global definitions may still describe specialized identity, model policy, and behavior, but definitions no longer control tool capabilities. Every child instead receives the parent session's active, cross-process-reloadable tools, except for nested delegation.

This design follows the current Superpowers Subagent-Driven Development (SDD) separation between the parent controller and fresh task-scoped children while allowing the same general agent definition to serve as an implementer, task reviewer, fixer, researcher, or final reviewer through its delegated task prompt.

## 2. Decisions

1. Ship `general` as an embedded builtin for arbitrary isolated tasks.
2. Keep user-global agent definitions as optional overrides and additional named roles.
3. Give a valid, uniquely named user-global definition precedence over the builtin with the same name. Invalid or duplicate user definitions produce diagnostics but do not remove the builtin fallback.
4. Make the task-level `agent` field optional and resolve omission to `general`.
5. Advertise the always-available default in the parent-visible tool and parameter descriptions.
6. Remove `tools` from agent-definition frontmatter.
7. Interpret the parent's **active** tools as the child's inherited capability set. Configured but inactive tools are not inherited.
8. Always exclude `subagent` so an ordinary child cannot recursively delegate.
9. Always add the child-only `complete_subagent` tool.
10. Inherit built-in and reloadable file-backed extension tools.
11. Omit non-reloadable tools from the child and retain visible diagnostics instead of failing the complete request.
12. Freeze the effective tool names, provider extension paths, and diagnostics during preflight so later parent changes cannot alter an active run.
13. Continue starting children with normal extension discovery disabled. Load only the completion extension and providers needed by inherited tools.
14. Keep model and thinking inheritance unchanged: omitted values inherit from the parent, and Pi resolves or clamps thinking for the selected model.

Backward compatibility for definition-level tool allowlists is not required. A definition that still contains `tools` becomes invalid through the existing unknown-field validation.

## 3. Bundled General Agent

The extension embeds `general` in its runtime source rather than depending on a Markdown file outside the package. The builtin is therefore installed, linked, updated, and versioned with the extension entrypoint and remains available when `<agent-dir>/subagents/agents/` is absent or unreadable.

Its identity is:

```text
name: general
description: General-purpose isolated task executor
source: builtin
model: inherit parent
thinking: inherit parent
```

Its bundled role prompt is:

```markdown
You are a general-purpose subagent. Complete exactly the delegated task using
available tools.

Treat the task's supplied scope, paths, constraints, acceptance criteria,
validation requirements, and output contract as authoritative. Inspect evidence
rather than guessing. Make only changes required by the task, and do not broaden
scope or make unapproved product or architecture decisions.

If required information is missing, report NEEDS_CONTEXT. If the task cannot be
completed, report BLOCKED. Use DONE_WITH_CONCERNS only when the requested work is
complete but material uncertainty remains. When the task requires a durable
report, write it to the supplied absolute path and return that path through
structured completion.
```

The runtime remains responsible for appending the no-delegation instruction and exact `complete_subagent` protocol. The bundled prompt does not duplicate those runtime-owned contracts.

Pi packages do not natively declare subagent resources; their standard manifest supports extensions, skills, prompts, and themes. The Subagents extension therefore owns this builtin catalog entry directly. No package-local Markdown loading or installation into the user's agent directory is required.

## 4. Optional Global Agent Definition Contract

User-global definitions remain discoverable from `<agent-dir>/subagents/agents/*.md`. Supported frontmatter becomes:

| Field         | Required | Contract                                                     |
| ------------- | -------: | ------------------------------------------------------------ |
| `name`        |      yes | Trimmed, non-empty, single-line public identifier            |
| `description` |      yes | Trimmed, non-empty, single-line description                  |
| `model`       |       no | Pi model pattern or canonical model identifier               |
| `thinking`    |       no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

Tool policy is a runtime contract rather than agent configuration. The builtin and all valid global definitions inherit the same frozen parent capability snapshot for one invocation.

The catalog begins with the bundled `general` definition. A valid, unique global definition shadows a builtin with the same name. Malformed or duplicate global candidates remain excluded and diagnostic, while the bundled fallback remains selectable. Other valid global names are added normally.

## 5. Parent-Facing Tool Contract

The parent does not need prior knowledge of the agent catalog to delegate ordinary work. Each task accepts:

```text
task: required delegated instruction
cwd: optional existing working directory
agent: optional agent name, defaulting to general
```

An omitted or undefined `agent` is normalized to `general` before lookup and durable execution planning. An explicitly supplied name continues to select a valid global override or specialized definition and retains the existing unknown-agent failure when it cannot be resolved.

The parent-visible `subagent` tool description states:

> Run one to three isolated child agents. The `general` agent name is always available through a bundled fallback and is used when an agent name is omitted.

The optional `agent` parameter description states:

> Optional agent definition name. Defaults to the always-available `general` agent. Specify another name only when intentionally using a specialized global definition.

Progress, manifests, rendering, and final results always use the resolved name. A task that omitted the field therefore appears as agent `general`, rather than retaining an absent or implicit identity.

## 6. Parent Capability Snapshot

At the start of a `subagent` invocation, the parent captures:

- `pi.getActiveTools()` for the names the parent has actually enabled; and
- `pi.getAllTools()` for provider metadata used to recreate those active tools.

The extension must not infer inheritance from `getAllTools()` alone because it includes configured but inactive tools.

The snapshot is copied before preflight and shared by every task in the accepted batch. A parent tool added, removed, enabled, or disabled after the snapshot does not alter any child in that invocation.

## 7. Effective Child Tool Resolution

Preflight resolves tools in active-parent order:

1. Remove `subagent` and any parent-side `complete_subagent` entry.
2. Find provider metadata for each remaining active tool name.
3. Preserve built-in tools without loading an extension.
4. For a file-backed extension tool, canonicalize and validate its provider path.
5. Deduplicate provider extension paths in first-use order while preserving every inherited tool name.
6. Omit unsupported tools and record a diagnostic.
7. Add `complete_subagent` exactly once.

Unsupported inheritance includes:

- no provider metadata for an active name;
- ambiguous provider metadata;
- SDK-injected tools that cannot be recreated in a process;
- synthetic provider paths;
- non-file or missing provider paths; and
- provider paths that cannot be canonicalized safely.

Best-effort omission applies only to implicit parent inheritance. There is no longer an explicit definition allowlist whose unsatisfied contract must fail preflight.

If every parent tool is unsupported or reserved, the child may still launch with only `complete_subagent`. Diagnostics make the reduced capability visible to the parent and in durable evidence.

## 8. Child Invocation

Every child command includes:

- JSON print mode;
- no session;
- disabled normal extension discovery;
- the completion extension;
- each deduplicated inherited provider extension;
- the resolved model and thinking level;
- an explicit `--tools` value containing the inherited tool names plus `complete_subagent`; and
- the existing appended system-prompt and private task-file arguments.

Passing `--tools` even when the parent had only Pi defaults ensures the child receives the exact frozen active set rather than recomputing defaults in its own process.

Loading an extension may register tools other than the inherited tool that selected it. Those additional registrations remain inactive because the explicit `--tools` list is authoritative. In particular, loading a provider that also registers `subagent` does not make nested delegation available.

## 9. Durable Evidence and Results

The run manifest records:

- whether the selected agent came from the bundled catalog or a global definition;
- a definition path only for filesystem-backed global agents;
- the parent's frozen active tool-name snapshot;
- the effective child tool names after reserved and unsupported tools are removed;
- canonical provider extension paths; and
- every unsupported inherited tool diagnostic.

Expected removal of `subagent` is policy behavior rather than a warning. Its absence remains evident by comparing the parent snapshot with the effective child set.

Progress and final structured details retain inheritance diagnostics under the existing bounded rendering and privacy rules. The model-facing result remains limited to the child status, summary, and optional report path.

The frozen manifest and composed system prompt continue to prevent later edits to an agent definition or parent tool configuration from changing an active run.

## 10. SDD Usage

The parent remains the SDD controller. It owns the complete plan, task sequencing, model selection, worktree state, task briefs, review packages, progress ledger, human escalation, and acceptance gates.

Each SDD dispatch may omit `agent` to use `general` with a complete role-specific task contract:

- **Implementer:** fresh task brief, minimal interface context, TDD and validation expectations, commit requirement, report path, and status protocol.
- **Task reviewer:** task brief, implementer report, binding global constraints, base/head range, review package, read-only project instructions, dual spec/quality verdicts, and report path.
- **Fixer:** accepted findings, implementer-side validation contract, covering tests, and append-only report expectations.
- **Final reviewer:** whole-branch package, complete requirements, accumulated minor findings, broad merge-readiness rubric, and report path.

Using one agent name does not collapse these behavioral roles. Every dispatch is still a fresh child, and the task prompt supplies distinct authority, evidence, validation, and output boundaries. The independent review gate remains independent because it is a separate fresh process, even though it uses the same global definition.

Review-only behavior is enforced by the delegated prompt and the user's sandbox, not by per-agent tool restrictions. This is an accepted trade-off of the single general-agent design.

Current Superpowers sources informing these task contracts at upstream commit `d884ae04edebef577e82ff7c4e143debd0bbec99`:

- `skills/subagent-driven-development/SKILL.md`
- `skills/subagent-driven-development/implementer-prompt.md`
- `skills/subagent-driven-development/task-reviewer-prompt.md`
- `skills/requesting-code-review/code-reviewer.md`

## 11. Error Handling

- Reserved delegation tools are policy-filtered rather than treated as user configuration errors.
- Unsupported inherited tools produce diagnostics and do not block otherwise valid tasks.
- Model, thinking, working-directory, process, artifact, and structured-completion failures retain their existing behavior.
- Missing, unreadable, or indeterminate global discovery does not prevent selecting bundled `general`; its diagnostics remain visible. Requests for names that exist only in the unavailable global catalog retain the existing discovery failure behavior.
- A provider extension that passes preflight but fails during child startup produces the existing child launch or execution failure; the runtime must not claim the tool was available.
- Tool inheritance diagnostics remain separate from child semantic concerns so a successfully completed task can still expose reduced inherited capability.

## 12. Testing Strategy

### Parent-facing API

- accept tasks with omitted `agent` and normalize them to `general`;
- preserve explicit valid specialized names and existing unknown-name failures;
- advertise the bundled default in the tool and parameter descriptions;
- render and persist the resolved `general` identity for omitted input.

### Agent catalog and schema

- expose bundled `general` when the global definitions directory is missing, empty, unreadable, or contains unrelated invalid files;
- allow a valid unique global `general` definition to shadow the builtin;
- retain builtin `general` with diagnostics when global candidates for that name are malformed or duplicated;
- add other valid global names normally;
- accept global definitions containing only name, description, optional model, and optional thinking;
- reject the removed `tools` field as unknown;
- persist bundled-versus-global source identity and a definition path only for global agents;
- preserve model and thinking inheritance and model-capability clamping.

### Parent snapshot

- capture active names separately from all configured metadata;
- prove configured-but-inactive tools are not inherited;
- copy and freeze the snapshot against later mutation.

### Tool resolution

- inherit active built-ins in order;
- exclude `subagent` and replace any parent completion entry with one child completion tool;
- resolve and deduplicate file-backed providers;
- omit missing, ambiguous, SDK, synthetic, non-file, and unsafe providers with diagnostics;
- allow a completion-only child when no parent capability is reloadable.

### Child command

- always pass the explicit inherited `--tools` list;
- load only completion and required provider extensions;
- keep normal extension discovery disabled;
- prove a provider's unrelated registered tools, especially `subagent`, remain inactive.

### Durable behavior

- persist effective names, providers, and diagnostics in the manifest;
- keep ordered batch results and bounded progress behavior unchanged;
- verify later parent tool changes do not affect an active run.

### Integration

- expose a fake active external tool in the parent, inherit it in a child, and complete successfully;
- expose an unsupported parent tool, verify diagnostic omission, and complete with remaining tools;
- verify the child cannot call `subagent`;
- run `bun run check` for typecheck, lint, and the complete test suite.

## 13. Non-Goals

- Proxying SDK or parent-session-bound tool calls through the parent process.
- Adding a native Pi package resource type for subagent definitions.
- Loading the bundled prompt from package-local Markdown or copying it into the user agent directory.
- Per-agent or per-task tool restrictions.
- Nested delegation or child-owned orchestration.
- Changing sandbox or permission-system policy.
- Dynamically changing a running child's inherited tool set after preflight.
- Adding chains, acceptance gates, worktree management, or other milestone-two orchestration to the execution engine.
