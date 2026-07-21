# File System Service

## Purpose

The file system service gives extensions a typed Effect boundary for shared file reads and controlled file mutations. Consumers receive operation-specific failures without depending directly on Node filesystem objects.

## Read Operations

The service checks path existence, reads modification times, and reads UTF-8 text. A missing path is a successful negative existence result; other failures identify the operation and path.

## Private Empty Files

A consumer can replace a path with a zero-byte regular file owned by the current user and mode `0600`. Publication never follows the existing target. Replaceable non-directory entries, including symlinks and regular files with unexpected metadata, are replaced; targets that cannot be replaced safely fail without being treated as published.

A consumer can remove the named file entry without following symlinks. Missing entries are already removed and therefore succeed; directories and other removal failures remain typed failures.

[Test Services](./test-services.md) owns the reusable fake conventions for file-system consumers.
