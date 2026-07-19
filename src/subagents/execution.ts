import { resolve } from "node:path";
import { Duration, Effect, Fiber, Ref, Stream } from "effect";
import {
  type ProcessError,
  type ProcessExit,
  ProcessError as ProcessFailure,
  type ProcessShutdownPolicy,
  type ProcessShutdownReport,
  ProcessService,
} from "../services/process";
import type { ChildCommand } from "./child-command";
import {
  makeHeadAccumulator,
  makeTailAccumulator,
  type SubagentTaskResult,
} from "./output";

export interface SubagentTask {
  readonly description: string;
  readonly prompt: string;
  readonly cwd?: string;
}

interface ResolvedSubagentTask {
  readonly description: string;
  readonly prompt: string;
  readonly cwd: string;
}

export interface ExecuteBatchInput {
  readonly tasks: ReadonlyArray<SubagentTask>;
  readonly parentCwd: string;
  readonly command: ChildCommand;
  readonly semaphore: Effect.Semaphore;
  readonly onTaskSettled?: (completed: number) => void;
}

export const SUBAGENT_SHUTDOWN_POLICY = {
  stdinCloseTimeout: Duration.millis(100),
  gracefulTimeout: Duration.seconds(1),
  forcedTimeout: Duration.seconds(1),
  totalTimeout: Duration.millis(2_100),
} satisfies ProcessShutdownPolicy;

type ProcessObservation<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: ProcessError };

interface TaskObservation {
  readonly terminal: ProcessExit | null;
  readonly errors: ReadonlyArray<ProcessError>;
}

const observeProcess = <A, R>(
  effect: Effect.Effect<A, ProcessError, R>,
): Effect.Effect<ProcessObservation<A>, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error): ProcessObservation<A> => ({
        _tag: "Failure",
        error,
      }),
      onSuccess: (value): ProcessObservation<A> => ({
        _tag: "Success",
        value,
      }),
    }),
  );

const shutdownDiagnostics = (
  report: ProcessShutdownReport,
): ReadonlyArray<ProcessError> => {
  const errors: Array<ProcessError> = [];
  switch (report.stdin._tag) {
    case "Failed":
      errors.push(report.stdin.error);
      break;
    case "TimedOut":
      errors.push(
        new ProcessFailure({
          operation: "stdin",
          message: "shutdown timed out waiting for stdin EOF",
        }),
      );
      break;
    case "Unavailable":
      errors.push(
        new ProcessFailure({
          operation: "stdin",
          message: "stdin was unavailable during shutdown",
        }),
      );
      break;
    case "Completed":
      break;
  }
  errors.push(...report.signalErrors, ...report.processErrors);
  if (report.terminal?._tag === "Failed") {
    errors.push(report.terminal.error);
  }
  if (report.terminalUnconfirmed) {
    errors.push(
      new ProcessFailure({
        operation: "wait",
        message: "shutdown could not confirm process termination",
      }),
    );
  }
  if (report.deadlineExceeded) {
    errors.push(
      new ProcessFailure({
        operation: "wait",
        message: "shutdown deadline exceeded",
      }),
    );
  }
  if (report.internalFailure !== undefined) {
    errors.push(
      new ProcessFailure({
        operation: "wait",
        message: `shutdown internal failure: ${report.internalFailure}`,
      }),
    );
  }
  return errors;
};

const executeTask = (
  task: ResolvedSubagentTask,
  input: ExecuteBatchInput,
): Effect.Effect<SubagentTaskResult, never, ProcessService> => {
  const stdout = makeHeadAccumulator();
  const stderr = makeTailAccumulator();
  const finishCaptures = (): void => {
    stdout.finish();
    stderr.finish();
  };

  const runChild = Effect.gen(function* () {
    const processes = yield* ProcessService;
    const child = yield* processes.spawnScoped(
      input.command.command,
      input.command.args,
      { cwd: task.cwd, stdio: "pipe" },
      SUBAGENT_SHUTDOWN_POLICY,
    );
    const stdoutFiber = yield* Effect.forkScoped(
      Stream.runForEach(child.stdoutLines, (line) =>
        Effect.sync(() => stdout.append(line + "\n")),
      ).pipe(observeProcess),
    );
    const stderrFiber = yield* Effect.forkScoped(
      Stream.runForEach(child.stderrChunks, (chunk) =>
        Effect.sync(() => stderr.append(chunk)),
      ).pipe(observeProcess),
    );
    const waitFiber = yield* Effect.forkScoped(
      observeProcess(child.waitForExit),
    );
    const stdinObservation = yield* child
      .writeStdin(task.prompt)
      .pipe(Effect.zipRight(child.endStdin), observeProcess);
    const errors: Array<ProcessError> = [];
    if (stdinObservation._tag === "Failure") {
      errors.push(stdinObservation.error);
    }

    let terminal: ProcessExit | null = null;
    let waitObservation: ProcessObservation<ProcessExit> | undefined;
    let shutdownReport: ProcessShutdownReport | undefined;

    if (stdinObservation._tag === "Failure") {
      shutdownReport = yield* child.shutdown;
    } else {
      waitObservation = yield* Fiber.join(waitFiber);
      if (waitObservation._tag === "Success") {
        terminal = waitObservation.value;
      } else {
        errors.push(waitObservation.error);
        shutdownReport = yield* child.shutdown;
      }
    }

    if (shutdownReport !== undefined) {
      errors.push(...shutdownDiagnostics(shutdownReport));
      if (terminal === null && shutdownReport.terminal?._tag === "Exited") {
        terminal = shutdownReport.terminal.exit;
      }

      if (
        shutdownReport.terminalUnconfirmed ||
        shutdownReport.terminal?._tag === "Failed"
      ) {
        yield* Fiber.interrupt(stdoutFiber);
        yield* Fiber.interrupt(stderrFiber);
        if (waitObservation === undefined) {
          yield* Fiber.interrupt(waitFiber);
        }
      } else {
        if (waitObservation === undefined) {
          waitObservation = yield* Fiber.join(waitFiber);
          if (waitObservation._tag === "Success") {
            if (terminal === null) terminal = waitObservation.value;
          } else {
            errors.push(waitObservation.error);
          }
        }
        const stdoutObservation = yield* Fiber.join(stdoutFiber);
        const stderrObservation = yield* Fiber.join(stderrFiber);
        if (stdoutObservation._tag === "Failure") {
          errors.push(stdoutObservation.error);
        }
        if (stderrObservation._tag === "Failure") {
          errors.push(stderrObservation.error);
        }
      }
    } else {
      const stdoutObservation = yield* Fiber.join(stdoutFiber);
      const stderrObservation = yield* Fiber.join(stderrFiber);
      if (stdoutObservation._tag === "Failure") {
        errors.push(stdoutObservation.error);
      }
      if (stderrObservation._tag === "Failure") {
        errors.push(stderrObservation.error);
      }
    }

    return { terminal, errors } satisfies TaskObservation;
  });

  const execute = Effect.gen(function* () {
    const processObservation = yield* input.semaphore.withPermits(1)(
      Effect.scoped(runChild).pipe(observeProcess),
    );
    const observation: TaskObservation =
      processObservation._tag === "Success"
        ? processObservation.value
        : { terminal: null, errors: [processObservation.error] };

    for (const error of observation.errors) {
      stderr.append(`\n[${error.operation}] ${error.message}\n`);
    }
    finishCaptures();
    const stdoutSnapshot = stdout.snapshot().text;
    const stderrSnapshot = stderr.snapshot().text;
    const completed =
      observation.terminal !== null &&
      observation.errors.length === 0 &&
      observation.terminal.code === 0 &&
      observation.terminal.signal === null;

    return {
      description: task.description,
      cwd: task.cwd,
      status: completed ? "completed" : "failed",
      exitCode: observation.terminal?.code ?? null,
      signal: observation.terminal?.signal ?? null,
      output: stdoutSnapshot,
      ...(stderrSnapshot === "" ? {} : { stderr: stderrSnapshot }),
    } satisfies SubagentTaskResult;
  });

  return execute.pipe(Effect.onInterrupt(() => Effect.sync(finishCaptures)));
};

export const executeBatch = (
  input: ExecuteBatchInput,
): Effect.Effect<ReadonlyArray<SubagentTaskResult>, never, ProcessService> =>
  Effect.gen(function* () {
    const completed = yield* Ref.make(0);
    const progressMutex = yield* Effect.makeSemaphore(1);
    const tasks: ReadonlyArray<ResolvedSubagentTask> = input.tasks.map(
      (task) => ({
        ...task,
        cwd: resolve(input.parentCwd, task.cwd ?? "."),
      }),
    );
    return yield* Effect.forEach(
      tasks,
      (task) =>
        executeTask(task, input).pipe(
          Effect.tap(() =>
            progressMutex.withPermits(1)(
              Ref.updateAndGet(completed, (count) => count + 1).pipe(
                Effect.tap((count) =>
                  Effect.sync(() => {
                    try {
                      input.onTaskSettled?.(count);
                    } catch {
                      // Progress reporting cannot affect execution.
                    }
                  }),
                ),
              ),
            ),
          ),
        ),
      { concurrency: 3 },
    );
  });
