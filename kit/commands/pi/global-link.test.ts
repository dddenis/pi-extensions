import { FileSystem, Path } from "@effect/platform";
import { BunContext, BunPath } from "@effect/platform-bun";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  globalLinkDestination,
  linkGlobal,
  resolveAgentDirectory,
  unlinkGlobal,
} from "./global-link";

const withRoots = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sandbox = yield* fs.makeTempDirectoryScoped({
    prefix: "pi-extensions-global-link-",
  });
  const projectRoot = path.join(sandbox, "repository");
  const agentDirectory = path.join(sandbox, "agent");
  yield* fs.makeDirectory(projectRoot, { recursive: true });

  return {
    fs,
    path,
    sandbox,
    projectRoot,
    agentDirectory,
    destination: globalLinkDestination(path, agentDirectory),
  };
});

const provideBun = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => effect.pipe(Effect.provide(BunContext.layer));

describe("global Pi extension link", () => {
  it.effect("resolves PI_CODING_AGENT_DIR before the home default", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      expect(
        resolveAgentDirectory(
          path,
          { PI_CODING_AGENT_DIR: "./custom-agent" },
          "/home/developer",
        ),
      ).toBe(path.resolve("./custom-agent"));
      expect(resolveAgentDirectory(path, {}, "/home/developer")).toBe(
        path.resolve("/home/developer", ".pi", "agent"),
      );
    }).pipe(Effect.provide(BunContext.layer)),
  );

  it.effect("uses the home default for an empty PI_CODING_AGENT_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      expect(
        resolveAgentDirectory(
          path,
          { PI_CODING_AGENT_DIR: "" },
          "/home/developer",
        ),
      ).toBe(path.resolve("/home/developer", ".pi", "agent"));
    }).pipe(Effect.provide(BunContext.layer)),
  );

  it.effect("expands Pi-supported tilde agent directories", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const homeDirectory = "/home/developer";

      expect(
        resolveAgentDirectory(
          path,
          { PI_CODING_AGENT_DIR: "~" },
          homeDirectory,
        ),
      ).toBe(path.resolve(homeDirectory));
      expect(
        resolveAgentDirectory(
          path,
          { PI_CODING_AGENT_DIR: "~/custom-agent" },
          homeDirectory,
        ),
      ).toBe(path.resolve(homeDirectory, "custom-agent"));
    }).pipe(Effect.provide(BunContext.layer)),
  );

  it.effect(
    "expands the Windows home separator without expanding other tilde forms",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeDirectory = "C:\\Users\\developer";

        expect(
          resolveAgentDirectory(
            path,
            { PI_CODING_AGENT_DIR: "~\\custom-agent" },
            homeDirectory,
          ),
        ).toBe(path.resolve(homeDirectory, "custom-agent"));
        expect(
          resolveAgentDirectory(
            path,
            { PI_CODING_AGENT_DIR: "~/forward-slash-agent" },
            homeDirectory,
          ),
        ).toBe(path.resolve(homeDirectory, "forward-slash-agent"));
        expect(
          resolveAgentDirectory(
            path,
            { PI_CODING_AGENT_DIR: "~other\\custom-agent" },
            homeDirectory,
          ),
        ).toBe(path.resolve("~other\\custom-agent"));
      }).pipe(Effect.provide(BunPath.layerWin32)),
  );

  it.effect("creates a fresh package-root symlink", () =>
    provideBun(
      Effect.gen(function* () {
        const { fs, projectRoot, agentDirectory, destination } =
          yield* withRoots;

        const result = yield* linkGlobal({ projectRoot, agentDirectory });

        expect(result._tag).toBe("Linked");
        expect(yield* fs.readLink(destination)).toBe(
          yield* fs.realPath(projectRoot),
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("treats the correct existing symlink as idempotent", () =>
    provideBun(
      Effect.gen(function* () {
        const { projectRoot, agentDirectory } = yield* withRoots;
        yield* linkGlobal({ projectRoot, agentDirectory });

        const result = yield* linkGlobal({ projectRoot, agentDirectory });

        expect(result._tag).toBe("AlreadyLinked");
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("accepts and removes an owned relative symlink", () =>
    provideBun(
      Effect.gen(function* () {
        const { fs, path, projectRoot, agentDirectory, destination } =
          yield* withRoots;
        const relativeTarget = path.relative(
          path.dirname(destination),
          projectRoot,
        );
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.symlink(relativeTarget, destination);

        const linkResult = yield* linkGlobal({ projectRoot, agentDirectory });
        expect(linkResult._tag).toBe("AlreadyLinked");
        expect(yield* fs.readLink(destination)).toBe(relativeTarget);

        const unlinkResult = yield* unlinkGlobal({
          projectRoot,
          agentDirectory,
        });
        expect(unlinkResult._tag).toBe("Unlinked");
        expect(yield* fs.exists(destination)).toBe(false);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("rejects a symlink to another target", () =>
    provideBun(
      Effect.gen(function* () {
        const { fs, path, sandbox, projectRoot, agentDirectory, destination } =
          yield* withRoots;
        const otherTarget = path.join(sandbox, "other");
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.makeDirectory(otherTarget);
        yield* fs.symlink(otherTarget, destination);

        const error = yield* linkGlobal({
          projectRoot,
          agentDirectory,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "GlobalLinkConflictError",
          action: "link",
          destination,
        });
        expect(yield* fs.readLink(destination)).toBe(otherTarget);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("rejects regular files and directories", () =>
    provideBun(
      Effect.gen(function* () {
        const { fs, path, projectRoot, agentDirectory, destination } =
          yield* withRoots;
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.writeFileString(destination, "occupied");

        const fileError = yield* linkGlobal({
          projectRoot,
          agentDirectory,
        }).pipe(Effect.flip);
        expect(fileError).toMatchObject({
          _tag: "GlobalLinkConflictError",
          action: "link",
          destination,
          actual: "File",
        });

        yield* fs.remove(destination);
        yield* fs.makeDirectory(destination);

        const directoryError = yield* linkGlobal({
          projectRoot,
          agentDirectory,
        }).pipe(Effect.flip);
        expect(directoryError).toMatchObject({
          _tag: "GlobalLinkConflictError",
          action: "link",
          destination,
          actual: "Directory",
        });
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("removes an owned symlink", () =>
    provideBun(
      Effect.gen(function* () {
        const { fs, projectRoot, agentDirectory, destination } =
          yield* withRoots;
        yield* linkGlobal({ projectRoot, agentDirectory });

        const result = yield* unlinkGlobal({ projectRoot, agentDirectory });

        expect(result._tag).toBe("Unlinked");
        expect(yield* fs.exists(destination)).toBe(false);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("treats an absent unlink destination as idempotent", () =>
    provideBun(
      Effect.gen(function* () {
        const { projectRoot, agentDirectory } = yield* withRoots;

        const result = yield* unlinkGlobal({ projectRoot, agentDirectory });

        expect(result._tag).toBe("AlreadyAbsent");
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("preserves an unrelated symlink on unlink", () =>
    provideBun(
      Effect.gen(function* () {
        const { fs, path, sandbox, projectRoot, agentDirectory, destination } =
          yield* withRoots;
        const otherTarget = path.join(sandbox, "other");
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.makeDirectory(otherTarget);
        yield* fs.symlink(otherTarget, destination);

        const error = yield* unlinkGlobal({
          projectRoot,
          agentDirectory,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "GlobalLinkConflictError",
          action: "unlink",
          destination,
        });
        expect(yield* fs.readLink(destination)).toBe(otherTarget);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("rejects and preserves a dangling symlink", () =>
    provideBun(
      Effect.gen(function* () {
        const { fs, path, projectRoot, agentDirectory, destination } =
          yield* withRoots;
        const danglingTarget = "missing-repository";
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.symlink(danglingTarget, destination);

        const linkError = yield* linkGlobal({
          projectRoot,
          agentDirectory,
        }).pipe(Effect.flip);
        expect(linkError).toMatchObject({
          _tag: "GlobalLinkConflictError",
          action: "link",
          destination,
        });
        expect(yield* fs.readLink(destination)).toBe(danglingTarget);

        const unlinkError = yield* unlinkGlobal({
          projectRoot,
          agentDirectory,
        }).pipe(Effect.flip);
        expect(unlinkError).toMatchObject({
          _tag: "GlobalLinkConflictError",
          action: "unlink",
          destination,
        });
        expect(yield* fs.readLink(destination)).toBe(danglingTarget);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("preserves unrelated files and directories on unlink", () =>
    provideBun(
      Effect.gen(function* () {
        const { fs, path, projectRoot, agentDirectory, destination } =
          yield* withRoots;
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.writeFileString(destination, "occupied");

        const fileError = yield* unlinkGlobal({
          projectRoot,
          agentDirectory,
        }).pipe(Effect.flip);
        expect(fileError).toMatchObject({
          _tag: "GlobalLinkConflictError",
          action: "unlink",
          destination,
          actual: "File",
        });
        expect(yield* fs.readFileString(destination)).toBe("occupied");

        yield* fs.remove(destination);
        yield* fs.makeDirectory(destination);

        const directoryError = yield* unlinkGlobal({
          projectRoot,
          agentDirectory,
        }).pipe(Effect.flip);
        expect(directoryError).toMatchObject({
          _tag: "GlobalLinkConflictError",
          action: "unlink",
          destination,
          actual: "Directory",
        });
        expect(yield* fs.stat(destination)).toMatchObject({
          type: "Directory",
        });
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("preserves the filesystem cause in a typed operation error", () =>
    provideBun(
      Effect.gen(function* () {
        const { path, sandbox, agentDirectory } = yield* withRoots;
        const missingProjectRoot = path.join(sandbox, "missing-repository");

        const error = yield* linkGlobal({
          projectRoot: missingProjectRoot,
          agentDirectory,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "GlobalLinkFileSystemError",
          action: "link",
          path: missingProjectRoot,
          cause: {
            _tag: "SystemError",
            reason: "NotFound",
          },
        });
      }).pipe(Effect.scoped),
    ),
  );
});
