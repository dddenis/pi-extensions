# File System Service

## Purpose

The file system service gives repository features one typed Effect boundary over local filesystem operations. It keeps Node filesystem objects and exceptions out of consumers, supports explicit privacy and atomic-publication workflows, and provides a matching configurable fake for deterministic tests.

[Architecture](./architecture.md) owns source placement and TypeScript boundaries. [Test Services](./test-services.md) owns reusable fake conventions. Feature specifications, such as [Subagents](./subagents.md), own the names and meaning of their files.

## Operations

The service provides:

- existence checks;
- modification-time lookup and metadata lookup;
- directory listing with entry names and file, directory, or other kinds;
- UTF-8 text reads;
- recursive or non-recursive directory creation with an explicit mode;
- UTF-8 text replacement with an explicit mode;
- UTF-8 text append;
- canonical real-path resolution;
- rename or replacement from one path to another; and
- recursive or non-recursive removal.

Metadata contains file kind, modification time in milliseconds, and mode. Directory entries and returned collections are fresh values so callers cannot mutate service-owned state.

## Failure Contract

Every operational failure is a typed file-system error containing the requested operation, relevant path, and diagnostic message. An existence check returns `false` only when the path is absent; permission and other access failures remain typed errors rather than being reported as absence.

The service does not silently reinterpret a failed read, metadata lookup, canonicalization, rename, or removal. Consumers decide which failures are fatal, diagnostic-only, or eligible for best-effort cleanup.

## Privacy and Atomic Publication

Directory creation and replacement text writes require callers to choose a mode so sensitive workflows can create private storage explicitly. Append extends the existing file without a mode parameter, supporting durable event and diagnostic streams without repeatedly replacing their complete contents.

Rename exists as a generic atomic-publication primitive: a consumer may fully write a temporary sibling and then replace the visible destination, preventing readers from observing a partially written record. Remove supports best-effort cleanup of temporary files and explicit recursive cleanup where a feature contract permits it. The service itself does not impose retention policy or feature-specific filenames.
