import path from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import {
  type DirectoryEntry,
  FileSystemError,
  type FileMetadata,
  type FileSystemOperation,
  FileSystemService,
} from "../../src/services/file-system";

export type FileSystemServiceTestFailures = ReadonlyMap<
  FileSystemOperation,
  ReadonlyMap<string, FileSystemError>
>;

export type FileSystemServiceTestDirectories = ReadonlyMap<
  string,
  ReadonlyArray<DirectoryEntry>
>;

export type FileSystemServiceTestMetadata = ReadonlyMap<string, FileMetadata>;

export type FileSystemServiceTestRealPaths = ReadonlyMap<string, string>;

export type FileSystemServiceTestPathStyle = "native" | "posix" | "win32";

type PlatformPath = Pick<
  typeof path,
  "basename" | "dirname" | "isAbsolute" | "relative" | "sep"
>;

export interface FileSystemServiceTestConfig {
  readonly pathStyle?: FileSystemServiceTestPathStyle;
  readonly exists?: ReadonlyMap<string, boolean>;
  readonly mtimes?: ReadonlyMap<string, number>;
  readonly directories?: FileSystemServiceTestDirectories;
  readonly metadata?: FileSystemServiceTestMetadata;
  readonly realPaths?: FileSystemServiceTestRealPaths;
  readonly contents?: ReadonlyMap<string, string>;
  readonly failures?: FileSystemServiceTestFailures;
}

export interface FileSystemServiceTestCall {
  readonly operation: FileSystemOperation;
  readonly path: string;
  readonly content?: string;
  readonly mode?: number;
  readonly recursive?: boolean;
  readonly from?: string;
  readonly to?: string;
}

export interface FileSystemServiceTestState {
  readonly calls: ReadonlyArray<FileSystemServiceTestCall>;
  readonly exists: ReadonlyMap<string, boolean>;
  readonly mtimes: ReadonlyMap<string, number>;
  readonly directories: FileSystemServiceTestDirectories;
  readonly metadata: FileSystemServiceTestMetadata;
  readonly realPaths: FileSystemServiceTestRealPaths;
  readonly contents: ReadonlyMap<string, string>;
  readonly failures: FileSystemServiceTestFailures;
}

type FileSystemServiceTestInternalState = FileSystemServiceTestState;

export interface FileSystemServiceTestService {
  readonly setExists: (path: string, exists: boolean) => Effect.Effect<void>;
  readonly setMtime: (path: string, mtimeMs: number) => Effect.Effect<void>;
  readonly setDirectory: (
    path: string,
    entries: ReadonlyArray<DirectoryEntry>,
  ) => Effect.Effect<void>;
  readonly setMetadata: (
    path: string,
    metadata: FileMetadata,
  ) => Effect.Effect<void>;
  readonly setRealPath: (path: string, realPath: string) => Effect.Effect<void>;
  readonly setContent: (path: string, content: string) => Effect.Effect<void>;
  readonly setFailure: (
    operation: FileSystemOperation,
    path: string,
    error: FileSystemError,
  ) => Effect.Effect<void>;
  readonly clearFailure: (
    operation: FileSystemOperation,
    path: string,
  ) => Effect.Effect<void>;
  readonly getState: Effect.Effect<FileSystemServiceTestState>;
  readonly resetCalls: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
}

type FileSystemServiceTestRef = Ref.Ref<FileSystemServiceTestInternalState>;

type Resolution<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: FileSystemError }
  | { readonly _tag: "Unconfigured" };

type MutationResult =
  | {
      readonly _tag: "Success";
      readonly state: FileSystemServiceTestInternalState;
    }
  | {
      readonly _tag: "Failure";
      readonly state: FileSystemServiceTestInternalState;
      readonly error: FileSystemError;
    }
  | {
      readonly _tag: "Unconfigured";
      readonly state: FileSystemServiceTestInternalState;
    };

const cloneError = (error: FileSystemError): FileSystemError =>
  new FileSystemError({
    operation: error.operation,
    path: error.path,
    message: error.message,
  });

const cloneEntry = (entry: DirectoryEntry): DirectoryEntry => ({ ...entry });

const cloneMetadata = (metadata: FileMetadata): FileMetadata => ({
  ...metadata,
});

const copyDirectories = (
  directories: FileSystemServiceTestDirectories | undefined,
): FileSystemServiceTestDirectories =>
  new Map(
    [...(directories ?? new Map())].map(([path, entries]) => [
      path,
      entries.map(cloneEntry),
    ]),
  );

const copyMetadata = (
  metadata: FileSystemServiceTestMetadata | undefined,
): FileSystemServiceTestMetadata =>
  new Map(
    [...(metadata ?? new Map())].map(([path, value]) => [
      path,
      cloneMetadata(value),
    ]),
  );

const copyFailures = (
  failures: FileSystemServiceTestFailures | undefined,
): FileSystemServiceTestFailures =>
  new Map(
    [...(failures ?? new Map())].map(([operation, paths]) => [
      operation,
      new Map(
        [...paths].map(([path, error]): readonly [string, FileSystemError] => [
          path,
          cloneError(error),
        ]),
      ),
    ]),
  );

const copyConfig = (
  config: FileSystemServiceTestConfig = {},
): FileSystemServiceTestConfig => ({
  ...(config.pathStyle === undefined ? {} : { pathStyle: config.pathStyle }),
  exists: new Map(config.exists),
  mtimes: new Map(config.mtimes),
  directories: copyDirectories(config.directories),
  metadata: copyMetadata(config.metadata),
  realPaths: new Map(config.realPaths),
  contents: new Map(config.contents),
  failures: copyFailures(config.failures),
});

const makeInitialState = (
  config: FileSystemServiceTestConfig = {},
): FileSystemServiceTestInternalState => ({
  calls: [],
  exists: new Map(config.exists),
  mtimes: new Map(config.mtimes),
  directories: copyDirectories(config.directories),
  metadata: copyMetadata(config.metadata),
  realPaths: new Map(config.realPaths),
  contents: new Map(config.contents),
  failures: copyFailures(config.failures),
});

const snapshotState = (
  ref: FileSystemServiceTestRef,
): Effect.Effect<FileSystemServiceTestState> =>
  Ref.get(ref).pipe(
    Effect.map((state) => ({
      calls: state.calls.map((call) => ({ ...call })),
      exists: new Map(state.exists),
      mtimes: new Map(state.mtimes),
      directories: copyDirectories(state.directories),
      metadata: copyMetadata(state.metadata),
      realPaths: new Map(state.realPaths),
      contents: new Map(state.contents),
      failures: copyFailures(state.failures),
    })),
  );

const resolveResult = <A>(
  operation: FileSystemOperation,
  path: string,
  resolution: Resolution<A>,
): Effect.Effect<A, FileSystemError> => {
  switch (resolution._tag) {
    case "Success":
      return Effect.succeed(resolution.value);
    case "Failure":
      return Effect.fail(resolution.error);
    case "Unconfigured":
      return Effect.die(
        new Error(
          `FileSystemServiceTest.${operation} is not configured for ${path}`,
        ),
      );
  }
};

const record = (
  state: FileSystemServiceTestInternalState,
  call: FileSystemServiceTestCall,
): FileSystemServiceTestInternalState => ({
  ...state,
  calls: [...state.calls, { ...call }],
});

const resolve = <A>(
  ref: FileSystemServiceTestRef,
  call: FileSystemServiceTestCall,
  lookup: (state: FileSystemServiceTestInternalState) => A | undefined,
): Effect.Effect<A, FileSystemError> =>
  Ref.modify<FileSystemServiceTestInternalState, Resolution<A>>(
    ref,
    (state) => {
      const nextState = record(state, call);
      const failure = state.failures.get(call.operation)?.get(call.path);
      if (failure !== undefined) {
        return [{ _tag: "Failure", error: cloneError(failure) }, nextState];
      }
      const value = lookup(state);
      return value === undefined
        ? [{ _tag: "Unconfigured" }, nextState]
        : [{ _tag: "Success", value }, nextState];
    },
  ).pipe(
    Effect.flatMap((resolution) =>
      resolveResult(call.operation, call.path, resolution),
    ),
  );

const mutateResult = (
  ref: FileSystemServiceTestRef,
  call: FileSystemServiceTestCall,
  update: (state: FileSystemServiceTestInternalState) => MutationResult,
): Effect.Effect<void, FileSystemError> =>
  Ref.modify<FileSystemServiceTestInternalState, Resolution<void>>(
    ref,
    (state) => {
      const nextState = record(state, call);
      const configuredFailure = state.failures
        .get(call.operation)
        ?.get(call.path);
      if (configuredFailure !== undefined) {
        return [
          { _tag: "Failure", error: cloneError(configuredFailure) },
          nextState,
        ];
      }

      const result = update(nextState);
      switch (result._tag) {
        case "Failure":
          return [{ _tag: "Failure", error: result.error }, result.state];
        case "Unconfigured":
          return [{ _tag: "Unconfigured" }, result.state];
        case "Success":
          return [{ _tag: "Success", value: undefined }, result.state];
      }
    },
  ).pipe(
    Effect.flatMap((resolution) =>
      resolveResult(call.operation, call.path, resolution),
    ),
  );

const mutate = (
  ref: FileSystemServiceTestRef,
  call: FileSystemServiceTestCall,
  update: (
    state: FileSystemServiceTestInternalState,
  ) => FileSystemServiceTestInternalState,
): Effect.Effect<void, FileSystemError> =>
  mutateResult(ref, call, (state) => ({
    _tag: "Success",
    state: update(state),
  }));

const setMapValue = <A>(
  values: ReadonlyMap<string, A>,
  path: string,
  value: A,
): ReadonlyMap<string, A> => {
  const nextValues = new Map(values);
  nextValues.set(path, value);
  return nextValues;
};

const inferExists = (
  state: FileSystemServiceTestInternalState,
  path: string,
): boolean | undefined => {
  if (state.exists.has(path)) return state.exists.get(path);
  return state.mtimes.has(path) ||
    state.directories.has(path) ||
    state.metadata.has(path) ||
    state.realPaths.has(path) ||
    state.contents.has(path)
    ? true
    : undefined;
};

type PathKnowledge = "Present" | "Absent" | "Unknown";

const inspectPath = (
  state: FileSystemServiceTestInternalState,
  path: string,
): PathKnowledge => {
  const exists = inferExists(state, path);
  return exists === true ? "Present" : exists === false ? "Absent" : "Unknown";
};

const pathSemanticsFor = (
  style: FileSystemServiceTestPathStyle | undefined,
): PlatformPath => {
  switch (style) {
    case "posix":
      return path.posix;
    case "win32":
      return path.win32;
    case "native":
    case undefined:
      return path;
  }
};

const parentPath = (
  pathSemantics: PlatformPath,
  filePath: string,
): string | undefined => {
  const parent = pathSemantics.dirname(filePath);
  return parent === filePath ? undefined : parent;
};

const setParentEntry = (
  pathSemantics: PlatformPath,
  directories: FileSystemServiceTestDirectories,
  filePath: string,
  kind: DirectoryEntry["kind"],
): FileSystemServiceTestDirectories => {
  const parent = parentPath(pathSemantics, filePath);
  if (parent === undefined) return directories;
  const name = pathSemantics.basename(filePath);
  const entries = (directories.get(parent) ?? []).filter(
    (entry) => entry.name !== name,
  );
  return setMapValue(directories, parent, [
    ...entries.map(cloneEntry),
    { name, kind },
  ]);
};

const removeParentEntry = (
  pathSemantics: PlatformPath,
  directories: FileSystemServiceTestDirectories,
  filePath: string,
): FileSystemServiceTestDirectories => {
  const parent = parentPath(pathSemantics, filePath);
  if (parent === undefined || !directories.has(parent)) return directories;
  const name = pathSemantics.basename(filePath);
  return setMapValue(
    directories,
    parent,
    (directories.get(parent) ?? [])
      .filter((entry) => entry.name !== name)
      .map(cloneEntry),
  );
};

const writeFileState = (
  pathSemantics: PlatformPath,
  state: FileSystemServiceTestInternalState,
  filePath: string,
  content: string,
  mode: number,
): FileSystemServiceTestInternalState => {
  const mtimeMs =
    state.metadata.get(filePath)?.mtimeMs ?? state.mtimes.get(filePath) ?? 0;
  return {
    ...state,
    exists: setMapValue(state.exists, filePath, true),
    mtimes: setMapValue(state.mtimes, filePath, mtimeMs),
    directories: setParentEntry(
      pathSemantics,
      state.directories,
      filePath,
      "file",
    ),
    metadata: setMapValue(state.metadata, filePath, {
      kind: "file",
      mtimeMs,
      mode,
    }),
    realPaths: setMapValue(state.realPaths, filePath, filePath),
    contents: setMapValue(state.contents, filePath, content),
  };
};

const moveMapValue = <A>(
  values: ReadonlyMap<string, A>,
  from: string,
  to: string,
  clone: (value: A) => A,
): ReadonlyMap<string, A> => {
  const value = values.get(from);
  const nextValues = new Map(values);
  nextValues.delete(from);
  nextValues.delete(to);
  if (value !== undefined) nextValues.set(to, clone(value));
  return nextValues;
};

const renameState = (
  pathSemantics: PlatformPath,
  state: FileSystemServiceTestInternalState,
  from: string,
  to: string,
): MutationResult => {
  const source = inspectPath(state, from);
  if (source === "Unknown") return { _tag: "Unconfigured", state };
  if (source === "Absent") {
    return {
      _tag: "Failure",
      state,
      error: new FileSystemError({
        operation: "rename",
        path: `${from} -> ${to}`,
        message: `rename source does not exist: ${from}`,
      }),
    };
  }

  const kind = state.metadata.get(from)?.kind ?? "file";
  return {
    _tag: "Success",
    state: {
      ...state,
      exists: setMapValue(
        moveMapValue(state.exists, from, to, (value) => value),
        from,
        false,
      ),
      mtimes: moveMapValue(state.mtimes, from, to, (value) => value),
      directories: setParentEntry(
        pathSemantics,
        removeParentEntry(
          pathSemantics,
          moveMapValue(state.directories, from, to, (entries) =>
            entries.map(cloneEntry),
          ),
          from,
        ),
        to,
        kind,
      ),
      metadata: moveMapValue(state.metadata, from, to, cloneMetadata),
      realPaths: setMapValue(
        moveMapValue(state.realPaths, from, to, (value) => value),
        to,
        to,
      ),
      contents: moveMapValue(state.contents, from, to, (value) => value),
    },
  };
};

const isRemovedPath = (
  pathSemantics: PlatformPath,
  candidate: string,
  removedPath: string,
  recursive: boolean | undefined,
): boolean => {
  const relative = pathSemantics.relative(removedPath, candidate);
  if (relative.length === 0) return true;
  return (
    recursive === true &&
    relative !== ".." &&
    !relative.startsWith(`..${pathSemantics.sep}`) &&
    !pathSemantics.isAbsolute(relative)
  );
};

const removeMapPaths = <A>(
  pathSemantics: PlatformPath,
  values: ReadonlyMap<string, A>,
  removedPath: string,
  recursive: boolean | undefined,
): ReadonlyMap<string, A> =>
  new Map(
    [...values].filter(
      ([candidate]) =>
        !isRemovedPath(pathSemantics, candidate, removedPath, recursive),
    ),
  );

const removeState = (
  pathSemantics: PlatformPath,
  state: FileSystemServiceTestInternalState,
  path: string,
  recursive: boolean | undefined,
): MutationResult => {
  const isDirectory =
    state.metadata.get(path)?.kind === "directory" ||
    state.directories.has(path);
  if (isDirectory && recursive !== true) {
    return {
      _tag: "Failure",
      state,
      error: new FileSystemError({
        operation: "remove",
        path,
        message: "recursive removal is required for directories",
      }),
    };
  }

  const removedPaths = new Set([path]);
  for (const values of [
    state.exists,
    state.mtimes,
    state.directories,
    state.metadata,
    state.realPaths,
    state.contents,
  ]) {
    for (const candidate of values.keys()) {
      if (isRemovedPath(pathSemantics, candidate, path, recursive)) {
        removedPaths.add(candidate);
      }
    }
  }

  let exists = removeMapPaths(pathSemantics, state.exists, path, recursive);
  for (const removedPath of removedPaths) {
    exists = setMapValue(exists, removedPath, false);
  }

  return {
    _tag: "Success",
    state: {
      ...state,
      exists,
      mtimes: removeMapPaths(pathSemantics, state.mtimes, path, recursive),
      directories: removeParentEntry(
        pathSemantics,
        removeMapPaths(pathSemantics, state.directories, path, recursive),
        path,
      ),
      metadata: removeMapPaths(pathSemantics, state.metadata, path, recursive),
      realPaths: removeMapPaths(
        pathSemantics,
        state.realPaths,
        path,
        recursive,
      ),
      contents: removeMapPaths(pathSemantics, state.contents, path, recursive),
    },
  };
};

const makeFileSystemService = (
  ref: FileSystemServiceTestRef,
  pathSemantics: PlatformPath,
): FileSystemService => ({
  exists: (path) =>
    resolve(ref, { operation: "exists", path }, (state) =>
      inferExists(state, path),
    ),
  statMtimeMs: (path) =>
    resolve(
      ref,
      { operation: "statMtimeMs", path },
      (state) => state.mtimes.get(path) ?? state.metadata.get(path)?.mtimeMs,
    ),
  stat: (path) =>
    resolve(ref, { operation: "stat", path }, (state) => {
      const metadata = state.metadata.get(path);
      return metadata === undefined ? undefined : cloneMetadata(metadata);
    }),
  readDirectory: (path) =>
    resolve(ref, { operation: "readDirectory", path }, (state) => {
      const entries = state.directories.get(path);
      return entries === undefined ? undefined : entries.map(cloneEntry);
    }),
  readTextFile: (path) =>
    resolve(ref, { operation: "readTextFile", path }, (state) =>
      state.contents.get(path),
    ),
  makeDirectory: (path, options) =>
    mutate(
      ref,
      {
        operation: "makeDirectory",
        path,
        recursive: options.recursive,
        mode: options.mode,
      },
      (state) => {
        const mtimeMs = state.metadata.get(path)?.mtimeMs ?? 0;
        return {
          ...state,
          exists: setMapValue(state.exists, path, true),
          mtimes: setMapValue(state.mtimes, path, mtimeMs),
          directories: setParentEntry(
            pathSemantics,
            setMapValue(state.directories, path, []),
            path,
            "directory",
          ),
          metadata: setMapValue(state.metadata, path, {
            kind: "directory",
            mtimeMs,
            mode: options.mode,
          }),
          realPaths: setMapValue(state.realPaths, path, path),
        };
      },
    ),
  writeTextFile: (path, content, options) =>
    mutate(
      ref,
      { operation: "writeTextFile", path, content, mode: options.mode },
      (state) =>
        writeFileState(pathSemantics, state, path, content, options.mode),
    ),
  appendTextFile: (path, content) =>
    mutate(ref, { operation: "appendTextFile", path, content }, (state) =>
      writeFileState(
        pathSemantics,
        state,
        path,
        `${state.contents.get(path) ?? ""}${content}`,
        state.metadata.get(path)?.mode ?? 0o666,
      ),
    ),
  realPath: (path) =>
    resolve(
      ref,
      { operation: "realPath", path },
      (state) =>
        state.realPaths.get(path) ??
        (inferExists(state, path) === true ? path : undefined),
    ),
  rename: (from, to) =>
    mutateResult(
      ref,
      { operation: "rename", path: `${from} -> ${to}`, from, to },
      (state) => renameState(pathSemantics, state, from, to),
    ),
  remove: (path, options) =>
    mutateResult(
      ref,
      { operation: "remove", path, recursive: options?.recursive },
      (state) => removeState(pathSemantics, state, path, options?.recursive),
    ),
});

const makeFileSystemServiceTest = (
  ref: FileSystemServiceTestRef,
  initialConfig: FileSystemServiceTestConfig,
): FileSystemServiceTestService => ({
  setExists: (path, exists) =>
    Ref.update(ref, (state) => ({
      ...state,
      exists: setMapValue(state.exists, path, exists),
    })),
  setMtime: (path, mtimeMs) =>
    Ref.update(ref, (state) => ({
      ...state,
      mtimes: setMapValue(state.mtimes, path, mtimeMs),
    })),
  setDirectory: (path, entries) =>
    Ref.update(ref, (state) => ({
      ...state,
      directories: setMapValue(
        state.directories,
        path,
        entries.map(cloneEntry),
      ),
    })),
  setMetadata: (path, metadata) =>
    Ref.update(ref, (state) => ({
      ...state,
      metadata: setMapValue(state.metadata, path, cloneMetadata(metadata)),
    })),
  setRealPath: (path, realPath) =>
    Ref.update(ref, (state) => ({
      ...state,
      realPaths: setMapValue(state.realPaths, path, realPath),
    })),
  setContent: (path, content) =>
    Ref.update(ref, (state) => ({
      ...state,
      contents: setMapValue(state.contents, path, content),
    })),
  setFailure: (operation, path, error) =>
    Ref.update(ref, (state) => {
      const operationFailures = new Map(state.failures.get(operation));
      operationFailures.set(path, cloneError(error));
      const failures = new Map(state.failures);
      failures.set(operation, operationFailures);
      return { ...state, failures };
    }),
  clearFailure: (operation, path) =>
    Ref.update(ref, (state) => {
      const operationFailures = new Map(state.failures.get(operation));
      operationFailures.delete(path);
      const failures = new Map(state.failures);
      if (operationFailures.size === 0) failures.delete(operation);
      else failures.set(operation, operationFailures);
      return { ...state, failures };
    }),
  getState: snapshotState(ref),
  resetCalls: Ref.update(ref, (state) => ({ ...state, calls: [] })),
  reset: Ref.set(ref, makeInitialState(initialConfig)),
});

const makeFileSystemServiceTestLayer = (
  config: FileSystemServiceTestConfig = {},
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const initialConfig = copyConfig(config);
      const ref = yield* Ref.make(makeInitialState(initialConfig));
      const controls = makeFileSystemServiceTest(ref, initialConfig);
      const fake = makeFileSystemService(
        ref,
        pathSemanticsFor(initialConfig.pathStyle),
      );

      return Context.add(
        Context.make(FileSystemService, fake),
        FileSystemServiceTest,
        controls,
      );
    }),
  );

export class FileSystemServiceTest extends Context.Tag("FileSystemServiceTest")<
  FileSystemServiceTest,
  FileSystemServiceTestService
>() {
  static readonly layer = makeFileSystemServiceTestLayer;
}
