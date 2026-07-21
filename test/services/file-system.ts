import { Context, Effect, Layer, Ref } from "effect";
import {
  FileSystemError,
  type FileSystemOperation,
  FileSystemService,
} from "../../src/services/file-system";

export type FileSystemServiceTestFailures = ReadonlyMap<
  FileSystemOperation,
  ReadonlyMap<string, FileSystemError>
>;

export interface FileSystemServiceTestPrivateFile {
  readonly contents: "";
  readonly mode: number;
}

export interface FileSystemServiceTestConfig {
  readonly exists?: ReadonlyMap<string, boolean>;
  readonly mtimes?: ReadonlyMap<string, number>;
  readonly contents?: ReadonlyMap<string, string>;
  readonly privateFiles?: ReadonlyMap<string, FileSystemServiceTestPrivateFile>;
  readonly failures?: FileSystemServiceTestFailures;
}

export interface FileSystemServiceTestCall {
  readonly operation: FileSystemOperation;
  readonly path: string;
}

export interface FileSystemServiceTestState {
  readonly calls: ReadonlyArray<FileSystemServiceTestCall>;
  readonly exists: ReadonlyMap<string, boolean>;
  readonly mtimes: ReadonlyMap<string, number>;
  readonly contents: ReadonlyMap<string, string>;
  readonly privateFiles: ReadonlyMap<string, FileSystemServiceTestPrivateFile>;
  readonly failures: FileSystemServiceTestFailures;
}

type FileSystemServiceTestInternalState = FileSystemServiceTestState;

export interface FileSystemServiceTestService {
  readonly setExists: (path: string, exists: boolean) => Effect.Effect<void>;
  readonly setMtime: (path: string, mtimeMs: number) => Effect.Effect<void>;
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

type MutationResolution =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Failure"; readonly error: FileSystemError };

const cloneError = (error: FileSystemError): FileSystemError =>
  new FileSystemError({
    operation: error.operation,
    path: error.path,
    message: error.message,
  });

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

const copyPrivateFiles = (
  privateFiles:
    ReadonlyMap<string, FileSystemServiceTestPrivateFile> | undefined,
): ReadonlyMap<string, FileSystemServiceTestPrivateFile> =>
  new Map(
    [...(privateFiles ?? new Map())].map(
      ([path, file]): readonly [string, FileSystemServiceTestPrivateFile] => [
        path,
        { contents: file.contents, mode: file.mode },
      ],
    ),
  );

const makeInitialState = (
  config: FileSystemServiceTestConfig = {},
): FileSystemServiceTestInternalState => ({
  calls: [],
  exists: new Map(config.exists),
  mtimes: new Map(config.mtimes),
  contents: new Map(config.contents),
  privateFiles: copyPrivateFiles(config.privateFiles),
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
      contents: new Map(state.contents),
      privateFiles: copyPrivateFiles(state.privateFiles),
      failures: copyFailures(state.failures),
    })),
  );

const resolve = <A>(
  ref: FileSystemServiceTestRef,
  operation: FileSystemOperation,
  path: string,
  values: (state: FileSystemServiceTestInternalState) => ReadonlyMap<string, A>,
): Effect.Effect<A, FileSystemError> =>
  Ref.modify<FileSystemServiceTestInternalState, Resolution<A>>(
    ref,
    (state) => {
      const nextState = {
        ...state,
        calls: [...state.calls, { operation, path }],
      };
      const failure = state.failures.get(operation)?.get(path);
      if (failure !== undefined) {
        return [{ _tag: "Failure", error: cloneError(failure) }, nextState];
      }
      const value = values(state).get(path);
      return value === undefined
        ? [{ _tag: "Unconfigured" }, nextState]
        : [{ _tag: "Success", value }, nextState];
    },
  ).pipe(
    Effect.flatMap((resolution) => {
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
    }),
  );

const mutate = (
  ref: FileSystemServiceTestRef,
  operation: FileSystemOperation,
  path: string,
  update: (
    privateFiles: ReadonlyMap<string, FileSystemServiceTestPrivateFile>,
  ) => ReadonlyMap<string, FileSystemServiceTestPrivateFile>,
): Effect.Effect<void, FileSystemError> =>
  Ref.modify<FileSystemServiceTestInternalState, MutationResolution>(
    ref,
    (state) => {
      const nextState = {
        ...state,
        calls: [...state.calls, { operation, path }],
      };
      const failure = state.failures.get(operation)?.get(path);
      return failure === undefined
        ? [
            { _tag: "Success" },
            { ...nextState, privateFiles: update(state.privateFiles) },
          ]
        : [{ _tag: "Failure", error: cloneError(failure) }, nextState];
    },
  ).pipe(
    Effect.flatMap((resolution) =>
      resolution._tag === "Success"
        ? Effect.void
        : Effect.fail(resolution.error),
    ),
  );

const makeFileSystemService = (
  ref: FileSystemServiceTestRef,
): FileSystemService => ({
  exists: (path) => resolve(ref, "exists", path, (state) => state.exists),
  statMtimeMs: (path) =>
    resolve(ref, "statMtimeMs", path, (state) => state.mtimes),
  readTextFile: (path) =>
    resolve(ref, "readTextFile", path, (state) => state.contents),
  replaceWithPrivateEmptyFile: (path) =>
    mutate(ref, "replaceWithPrivateEmptyFile", path, (privateFiles) => {
      const next = new Map(privateFiles);
      next.set(path, { contents: "", mode: 0o600 });
      return next;
    }),
  removeFile: (path) =>
    mutate(ref, "removeFile", path, (privateFiles) => {
      const next = new Map(privateFiles);
      next.delete(path);
      return next;
    }),
});

const setPathValue = <A>(
  values: ReadonlyMap<string, A>,
  path: string,
  value: A,
): ReadonlyMap<string, A> => {
  const nextValues = new Map(values);
  nextValues.set(path, value);
  return nextValues;
};

const makeFileSystemServiceTest = (
  ref: FileSystemServiceTestRef,
  initialState: FileSystemServiceTestInternalState,
): FileSystemServiceTestService => ({
  setExists: (path, exists) =>
    Ref.update(ref, (state) => ({
      ...state,
      exists: setPathValue(state.exists, path, exists),
    })),
  setMtime: (path, mtimeMs) =>
    Ref.update(ref, (state) => ({
      ...state,
      mtimes: setPathValue(state.mtimes, path, mtimeMs),
    })),
  setContent: (path, content) =>
    Ref.update(ref, (state) => ({
      ...state,
      contents: setPathValue(state.contents, path, content),
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
      if (operationFailures.size === 0) {
        failures.delete(operation);
      } else {
        failures.set(operation, operationFailures);
      }
      return { ...state, failures };
    }),
  getState: snapshotState(ref),
  resetCalls: Ref.update(ref, (state) => ({ ...state, calls: [] })),
  reset: Ref.set(ref, initialState),
});

const makeFileSystemServiceTestLayer = (
  config: FileSystemServiceTestConfig = {},
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const initialState = makeInitialState(config);
      const ref = yield* Ref.make(initialState);
      const controls = makeFileSystemServiceTest(ref, initialState);
      const fake = makeFileSystemService(ref);

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
