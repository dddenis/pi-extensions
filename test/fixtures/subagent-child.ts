import { once } from "node:events";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";

const FixtureControlSchema = Schema.Struct({
  taskId: Schema.optional(Schema.String),
  capturePath: Schema.optional(Schema.String),
  activeDirectory: Schema.optional(Schema.String),
  startedDirectory: Schema.optional(Schema.String),
  releaseDirectory: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.Array(Schema.String)),
  stderr: Schema.optional(Schema.Array(Schema.String)),
  stdoutRepeat: Schema.optional(Schema.Number),
  stderrRepeat: Schema.optional(Schema.Number),
  delayMs: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.Literal("SIGINT", "SIGTERM", "SIGKILL")),
});

const raw = await Bun.stdin.text();
const parsed: unknown = JSON.parse(raw.trim());
const control = Schema.decodeUnknownSync(FixtureControlSchema)(parsed);
const taskId = control.taskId ?? "task";

const markerPath = async (
  directory: string | undefined,
): Promise<string | undefined> => {
  if (directory === undefined) return undefined;
  await mkdir(directory, { recursive: true });
  const path = join(directory, taskId);
  await writeFile(path, "started\n", "utf8");
  return path;
};

const waitForRelease = async (): Promise<void> => {
  if (control.releaseDirectory === undefined) return;
  const path = join(control.releaseDirectory, taskId);
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      await delay(10);
    }
  }
};

const writeRepeated = async (
  stream: NodeJS.WriteStream,
  chunks: ReadonlyArray<string>,
  repeat: number,
): Promise<void> => {
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const chunk of chunks) {
      if (!stream.write(chunk)) await once(stream, "drain");
    }
  }
};

if (control.capturePath !== undefined) {
  await writeFile(control.capturePath, raw, "utf8");
}

const activePath = await markerPath(control.activeDirectory);
await markerPath(control.startedDirectory);

try {
  await waitForRelease();
  await Promise.all([
    writeRepeated(
      process.stdout,
      control.stdout ?? [],
      Math.max(0, Math.floor(control.stdoutRepeat ?? 1)),
    ),
    writeRepeated(
      process.stderr,
      control.stderr ?? [],
      Math.max(0, Math.floor(control.stderrRepeat ?? 1)),
    ),
  ]);
  await delay(Math.max(0, control.delayMs ?? 0));
  if (control.signal !== undefined) {
    process.kill(process.pid, control.signal);
    await new Promise<never>(() => undefined);
  }
  process.exitCode = Math.trunc(control.exitCode ?? 0);
} finally {
  if (activePath !== undefined) {
    await rm(activePath, { force: true });
  }
}
