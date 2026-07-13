import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { Context, Data, Effect, Layer } from "effect";

export type FileSystemOperation =
  | "exists"
  | "statMtimeMs"
  | "stat"
  | "readDirectory"
  | "readTextFile"
  | "makeDirectory"
  | "writeTextFile"
  | "appendTextFile"
  | "realPath"
  | "rename"
  | "remove";

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly operation: FileSystemOperation;
  readonly path: string;
  readonly message: string;
}> {}

export interface FileMetadata {
  readonly kind: "file" | "directory" | "other";
  readonly mtimeMs: number;
  readonly mode: number;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
}

export interface FileSystemService {
  readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>;
  readonly statMtimeMs: (
    path: string,
  ) => Effect.Effect<number, FileSystemError>;
  readonly stat: (path: string) => Effect.Effect<FileMetadata, FileSystemError>;
  readonly readDirectory: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<DirectoryEntry>, FileSystemError>;
  readonly readTextFile: (
    path: string,
  ) => Effect.Effect<string, FileSystemError>;
  readonly makeDirectory: (
    path: string,
    options: { readonly recursive: boolean; readonly mode: number },
  ) => Effect.Effect<void, FileSystemError>;
  readonly writeTextFile: (
    path: string,
    content: string,
    options: { readonly mode: number },
  ) => Effect.Effect<void, FileSystemError>;
  readonly appendTextFile: (
    path: string,
    content: string,
  ) => Effect.Effect<void, FileSystemError>;
  readonly realPath: (path: string) => Effect.Effect<string, FileSystemError>;
  readonly rename: (
    from: string,
    to: string,
  ) => Effect.Effect<void, FileSystemError>;
  readonly remove: (
    path: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<void, FileSystemError>;
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

const toFileKind = (value: {
  readonly isFile: () => boolean;
  readonly isDirectory: () => boolean;
}): FileMetadata["kind"] => {
  if (value.isFile()) return "file";
  if (value.isDirectory()) return "directory";
  return "other";
};

const toFileMetadata = (value: {
  readonly isFile: () => boolean;
  readonly isDirectory: () => boolean;
  readonly mtimeMs: number;
  readonly mode: number;
}): FileMetadata => ({
  kind: toFileKind(value),
  mtimeMs: value.mtimeMs,
  mode: value.mode,
});

const tryFileSystem = <A>(
  operation: FileSystemOperation,
  path: string,
  attempt: () => Promise<A>,
): Effect.Effect<A, FileSystemError> =>
  Effect.tryPromise({
    try: attempt,
    catch: (cause) => toFileSystemError(operation, path, cause),
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
      tryFileSystem("statMtimeMs", filePath, () =>
        stat(filePath).then((value) => value.mtimeMs),
      ),
    stat: (filePath) =>
      tryFileSystem("stat", filePath, () =>
        stat(filePath).then((value) => toFileMetadata(value)),
      ),
    readDirectory: (directoryPath) =>
      tryFileSystem("readDirectory", directoryPath, () =>
        readdir(directoryPath, { withFileTypes: true }).then((entries) =>
          entries.map((entry) => ({
            name: entry.name,
            kind: toFileKind(entry),
          })),
        ),
      ),
    readTextFile: (filePath) =>
      tryFileSystem("readTextFile", filePath, () => readFile(filePath, "utf8")),
    makeDirectory: (directoryPath, options) =>
      tryFileSystem("makeDirectory", directoryPath, () =>
        mkdir(directoryPath, {
          recursive: options.recursive,
          mode: options.mode,
        }).then(() => undefined),
      ),
    writeTextFile: (filePath, content, options) =>
      tryFileSystem("writeTextFile", filePath, async () => {
        const handle = await open(filePath, "w", options.mode);
        try {
          await handle.chmod(options.mode);
          await handle.writeFile(content, { encoding: "utf8" });
        } finally {
          await handle.close();
        }
      }),
    appendTextFile: (filePath, content) =>
      tryFileSystem("appendTextFile", filePath, () =>
        appendFile(filePath, content, "utf8"),
      ),
    realPath: (filePath) =>
      tryFileSystem("realPath", filePath, () => realpath(filePath, "utf8")),
    rename: (from, to) =>
      tryFileSystem("rename", `${from} -> ${to}`, () => rename(from, to)),
    remove: (path, options) =>
      tryFileSystem("remove", path, () =>
        rm(path, { recursive: options?.recursive }).then(() => undefined),
      ),
  } satisfies FileSystemService),
});
