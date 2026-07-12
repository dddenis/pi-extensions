# Agent Instructions

## Project Context

These extensions are maintained for personal use. Prefer the best current contract, design, and implementation over backward compatibility. Preserve compatibility only when the user or an applicable specification explicitly requires it.

## Specification Workflow

Treat `docs/specs/` as the project's living behavioral and architectural contract.

### Before implementation

1. Read `docs/specs/index.md`.
2. Identify and read the owning specification for every module you expect to touch.
3. Consult `docs/agents/spec-guardian.md` for the complete decision rules and edge cases.

### During implementation

Update the relevant specifications in the same change when code introduces, removes, or changes:

- User-visible behavior, workflows, entities, endpoints, or UI surfaces
- Interfaces, schemas, fields, types, or other contracts
- Services, integrations, dependencies, architecture, or data flow
- Behavior-affecting configuration options or environment variables

Do not update specifications for:

- A bug fix that restores behavior already described by the specification
- A behavior-preserving refactor or internal implementation detail
- Test-only, CI-only, formatting, typo, logging, or minor defensive changes
- Behavior already accurately covered by the existing specification

Specification edits must:

- Describe what and why, not implementation details
- Be minimal and limited to the affected contract
- Avoid implementation code and unnecessary code snippets
- Cross-reference other specifications instead of duplicating them
- Keep each specification under approximately 300 lines
- Add new specification files to `docs/specs/index.md`
- Split oversized specifications into focused files

When uncertain whether a change is specification-worthy, prefer not to add marginal implementation detail. Record the reason for skipping the update in the completion summary.

### Before completion

1. Review the final diff against `main`, unless the user supplied another comparison range.
2. Map each changed domain to its owning specification.
3. Confirm that each specification still accurately describes the resulting behavior and contracts.
4. Update any missing specifications before claiming completion.
5. Report which specifications changed, or explicitly explain why no specification update was required.

## Engineering Instructions

1. Use Bun for package management and commands.
2. Use Effect patterns for services and repository tooling.
3. Prefer Effect Schema, Effect DateTime, and Effect services over ad-hoc runtime logic when those APIs apply.
4. Use relevant materials in `.context` as read-only references.
5. Do not edit `.context` unless explicitly asked.
6. Avoid unsafe type assertions and non-null assertions unless explicitly approved.
7. Before claiming completion, run the validation commands relevant to the change and report exact failures if the local environment cannot run them.
