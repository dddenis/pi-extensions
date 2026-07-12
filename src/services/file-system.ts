import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { Context, Data, Effect, Layer } from "effect";

export type FileSystemOperation = "exists" | "statMtimeMs" | "readTextFile";

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly operation: FileSystemOperation;
  readonly path: string;
  readonly message: string;
}> {}

export interface FileSystemService {
  readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>;
  readonly statMtimeMs: (
    path: string,
  ) => Effect.Effect<number, FileSystemError>;
  readonly readTextFile: (
    path: string,
  ) => Effect.Effect<string, FileSystemError>;
}

const FileSystemServiceTag = Context.GenericTag<FileSystemService>(
  "pi-extensions/FileSystemService",
);

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

class FileAccessError extends Data.TaggedError("FileAccessError")<{
  readonly cause: unknown;
}> {}

const toFileSystemError = (
  operation: FileSystemOperation,
  path: string,
  cause: unknown,
): FileSystemError =>
  new FileSystemError({
    operation,
    path,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const FileSystemService = Object.assign(FileSystemServiceTag, {
  Live: Layer.succeed(FileSystemServiceTag, {
    exists: (filePath) =>
      Effect.tryPromise({
        try: () => access(filePath, constants.F_OK).then(() => true),
        catch: (cause) => new FileAccessError({ cause }),
      }).pipe(
        Effect.catchAll(({ cause }) =>
          isMissingFile(cause)
            ? Effect.succeed(false)
            : Effect.fail(toFileSystemError("exists", filePath, cause)),
        ),
      ),
    statMtimeMs: (filePath) =>
      Effect.tryPromise({
        try: () => stat(filePath).then((value) => value.mtimeMs),
        catch: (cause) => toFileSystemError("statMtimeMs", filePath, cause),
      }),
    readTextFile: (filePath) =>
      Effect.tryPromise({
        try: () => readFile(filePath, "utf8"),
        catch: (cause) => toFileSystemError("readTextFile", filePath, cause),
      }),
  } satisfies FileSystemService),
});
