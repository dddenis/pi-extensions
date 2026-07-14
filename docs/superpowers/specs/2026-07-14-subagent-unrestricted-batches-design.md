# Unrestricted Subagent Batch Execution Design

**Date:** 2026-07-14
**Status:** Approved

## Purpose

Simplify milestone-one subagent execution so every valid task is governed by the same preflight and concurrency rules. Agent definitions describe prompts, models, thinking levels, and tool availability; they do not carry a separate mutation classification.

## Agent definitions

Supported frontmatter fields are:

- `name`;
- `description`;
- `model`;
- `thinking`; and
- `tools`.

Frontmatter remains strict. Discovery freezes the supported definition data for preflight, and active runs preserve resolved execution data in their manifests.

## Preflight and concurrency

Preflight continues to validate:

- agent discovery and uniqueness;
- working directories;
- model and thinking resolution;
- reserved tool names;
- declared tool provenance; and
- external provider paths.

A valid request contains one to three tasks. All accepted tasks may run concurrently. Tool allowlists affect child tool availability and provider loading only; they do not affect scheduling eligibility.

## Persisted contract

Resolved agents and run manifests contain identity, prompt-derived execution settings, tool configuration, provider extensions, and definition paths. They contain no separate mutation classification.

## Errors

The error model covers request, definition, working-directory, model, tool-provider, run-store, process, event-stream, and completion failures. There is no scheduling error based on a task's mutation capability.

## Testing

Tests cover the resulting contract directly:

- strict supported frontmatter;
- discovery and preflight resolution;
- tool provenance and reserved names;
- concurrent one-to-three-task batches;
- persisted manifests; and
- existing rollback, cancellation, progress, and result ordering behavior.

Fixtures use role-neutral names and contain only supported definition fields.

## Documentation

The living subagents specification and milestone design material describe uniform concurrent execution. Obsolete branch material that depends on a separate mutation classification is removed or revised so the repository presents one consistent contract.
