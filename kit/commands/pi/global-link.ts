import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Option, Schema } from "effect";

const packageName = "pi-extensions";

type GlobalLinkAction = "link" | "unlink";

export interface GlobalLinkOptions {
  readonly projectRoot: string;
  readonly agentDirectory: string;
}

export type GlobalLinkEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type GlobalLinkResult =
  | {
      readonly _tag: "Linked";
      readonly destination: string;
      readonly target: string;
    }
  | {
      readonly _tag: "AlreadyLinked";
      readonly destination: string;
      readonly target: string;
    }
  | {
      readonly _tag: "Unlinked";
      readonly destination: string;
      readonly target: string;
    }
  | {
      readonly _tag: "AlreadyAbsent";
      readonly destination: string;
      readonly target: string;
    };

export class GlobalLinkConflictError extends Schema.TaggedError<GlobalLinkConflictError>()(
  "GlobalLinkConflictError",
  {
    action: Schema.Literal("link", "unlink"),
    destination: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
    message: Schema.String,
  },
) {}

export class GlobalLinkFileSystemError extends Schema.TaggedError<GlobalLinkFileSystemError>()(
  "GlobalLinkFileSystemError",
  {
    action: Schema.Literal("link", "unlink"),
    path: Schema.String,
    cause: Schema.Defect,
    message: Schema.String,
  },
) {}

type DestinationState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "SymbolicLink"; readonly target: string }
  | {
      readonly _tag: "Occupied";
      readonly kind: FileSystem.File.Type;
    };

const isSystemError = (
  error: PlatformError,
  reason: "InvalidData" | "NotFound",
): boolean => error._tag === "SystemError" && error.reason === reason;

const hasSystemErrorCode = (error: PlatformError, code: string): boolean =>
  error._tag === "SystemError" &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  "code" in error.cause &&
  error.cause.code === code;

const isNonSymlinkError = (error: PlatformError): boolean =>
  isSystemError(error, "InvalidData") || hasSystemErrorCode(error, "EINVAL");

const fileSystemError = (
  action: GlobalLinkAction,
  path: string,
  cause: PlatformError,
): GlobalLinkFileSystemError =>
  new GlobalLinkFileSystemError({
    action,
    path,
    cause,
    message: `Failed to ${action} Pi extensions at ${path}: ${cause.message}`,
  });

const mapFileSystemError = <A, R>(
  action: GlobalLinkAction,
  path: string,
  effect: Effect.Effect<A, PlatformError, R>,
): Effect.Effect<A, GlobalLinkFileSystemError, R> =>
  effect.pipe(Effect.mapError((cause) => fileSystemError(action, path, cause)));

const conflictError = (
  action: GlobalLinkAction,
  destination: string,
  expected: string,
  actual: string,
): GlobalLinkConflictError =>
  new GlobalLinkConflictError({
    action,
    destination,
    expected,
    actual,
    message: `Refusing to ${action} ${destination}: expected ${expected}, found ${actual}`,
  });

const inspectDestination = (
  fs: FileSystem.FileSystem,
  destination: string,
  action: GlobalLinkAction,
): Effect.Effect<DestinationState, GlobalLinkFileSystemError, never> =>
  fs.readLink(destination).pipe(
    Effect.map((target) => ({ _tag: "SymbolicLink", target }) as const),
    Effect.catchAll(
      (cause): Effect.Effect<DestinationState, GlobalLinkFileSystemError> => {
        if (isSystemError(cause, "NotFound")) {
          return Effect.succeed({ _tag: "Missing" } as const);
        }
        if (isNonSymlinkError(cause)) {
          return mapFileSystemError(
            action,
            destination,
            fs.stat(destination),
          ).pipe(
            Effect.map(
              (info) => ({ _tag: "Occupied", kind: info.type }) as const,
            ),
          );
        }
        return Effect.fail(fileSystemError(action, destination, cause));
      },
    ),
  );

const canonicalLinkTarget = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  destination: string,
  target: string,
  action: GlobalLinkAction,
): Effect.Effect<Option.Option<string>, GlobalLinkFileSystemError, never> => {
  const absoluteTarget = path.resolve(path.dirname(destination), target);
  return fs.realPath(absoluteTarget).pipe(
    Effect.map(Option.some),
    Effect.catchAll((cause) =>
      isSystemError(cause, "NotFound")
        ? Effect.succeed(Option.none())
        : Effect.fail(fileSystemError(action, absoluteTarget, cause)),
    ),
  );
};

export const resolveAgentDirectory = (
  path: Path.Path,
  environment: GlobalLinkEnvironment,
  homeDirectory: string,
): string => {
  const configuredDirectory =
    environment.PI_CODING_AGENT_DIR || path.join(homeDirectory, ".pi", "agent");
  const expandedDirectory =
    configuredDirectory === "~"
      ? homeDirectory
      : configuredDirectory.startsWith("~/") ||
          configuredDirectory.startsWith(`~${path.sep}`)
        ? path.join(homeDirectory, configuredDirectory.slice(2))
        : configuredDirectory;

  return path.resolve(expandedDirectory);
};

export const globalLinkDestination = (
  path: Path.Path,
  agentDirectory: string,
): string => path.join(path.resolve(agentDirectory), "extensions", packageName);

export const linkGlobal = ({
  projectRoot,
  agentDirectory,
}: GlobalLinkOptions): Effect.Effect<
  GlobalLinkResult,
  GlobalLinkConflictError | GlobalLinkFileSystemError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = yield* mapFileSystemError(
      "link",
      projectRoot,
      fs.realPath(projectRoot),
    );
    const destination = globalLinkDestination(path, agentDirectory);
    const state = yield* inspectDestination(fs, destination, "link");

    if (state._tag === "SymbolicLink") {
      const canonicalTarget = yield* canonicalLinkTarget(
        fs,
        path,
        destination,
        state.target,
        "link",
      );
      if (Option.contains(canonicalTarget, target)) {
        return { _tag: "AlreadyLinked", destination, target } as const;
      }
      return yield* conflictError(
        "link",
        destination,
        target,
        `symlink to ${state.target}`,
      );
    }

    if (state._tag === "Occupied") {
      return yield* conflictError(
        "link",
        destination,
        `symlink to ${target}`,
        state.kind,
      );
    }

    const extensionDirectory = path.dirname(destination);
    yield* mapFileSystemError(
      "link",
      extensionDirectory,
      fs.makeDirectory(extensionDirectory, { recursive: true }),
    );
    yield* mapFileSystemError(
      "link",
      destination,
      fs.symlink(target, destination),
    );

    return { _tag: "Linked", destination, target } as const;
  });

export const unlinkGlobal = ({
  projectRoot,
  agentDirectory,
}: GlobalLinkOptions): Effect.Effect<
  GlobalLinkResult,
  GlobalLinkConflictError | GlobalLinkFileSystemError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = yield* mapFileSystemError(
      "unlink",
      projectRoot,
      fs.realPath(projectRoot),
    );
    const destination = globalLinkDestination(path, agentDirectory);
    const state = yield* inspectDestination(fs, destination, "unlink");

    if (state._tag === "Missing") {
      return { _tag: "AlreadyAbsent", destination, target } as const;
    }

    if (state._tag === "Occupied") {
      return yield* conflictError(
        "unlink",
        destination,
        `symlink to ${target}`,
        state.kind,
      );
    }

    const canonicalTarget = yield* canonicalLinkTarget(
      fs,
      path,
      destination,
      state.target,
      "unlink",
    );
    if (!Option.contains(canonicalTarget, target)) {
      return yield* conflictError(
        "unlink",
        destination,
        `symlink to ${target}`,
        `symlink to ${state.target}`,
      );
    }

    yield* mapFileSystemError("unlink", destination, fs.remove(destination));
    return { _tag: "Unlinked", destination, target } as const;
  });
