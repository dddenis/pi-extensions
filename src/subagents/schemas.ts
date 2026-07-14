import path from "node:path";
import { DateTime, Option, Schema } from "effect";

const trim = (value: string): string => value.trim();

const SINGLE_LINE_PATTERN = /^[^\r\n]+$/;
const hasNoTerminalControls = (value: string): boolean =>
  Array.from(value).every((codePoint) => {
    const code = codePoint.codePointAt(0);
    return code === undefined || (code > 0x1f && (code < 0x7f || code > 0x9f));
  });

const isCanonicalIsoTimestamp = (value: string): boolean =>
  DateTime.make(value).pipe(
    Option.map((dateTime) => DateTime.formatIso(dateTime) === value),
    Option.getOrElse(() => false),
  );

const NonEmptyTrimmedStringSchema = Schema.transform(
  Schema.String,
  Schema.String.pipe(Schema.minLength(1)),
  {
    strict: true,
    decode: trim,
    encode: (value) => value,
  },
);

const NonEmptyTrimmedSingleLineStringSchema = Schema.transform(
  Schema.String,
  Schema.String.pipe(Schema.minLength(1), Schema.pattern(SINGLE_LINE_PATTERN)),
  {
    strict: true,
    decode: trim,
    encode: (value) => value,
  },
);

const AbsolutePathSchema = Schema.transform(
  Schema.String,
  Schema.String.pipe(
    Schema.minLength(1),
    Schema.pattern(SINGLE_LINE_PATTERN),
    Schema.filter((value) => path.isAbsolute(value), {
      description: "an absolute path",
    }),
  ),
  {
    strict: true,
    decode: trim,
    encode: (value) => value,
  },
);

const IsoTimestampSchema = Schema.String.pipe(
  Schema.pattern(SINGLE_LINE_PATTERN),
  Schema.filter(isCanonicalIsoTimestamp, {
    description: "a canonical UTC ISO timestamp string",
  }),
);

const SIGNAL_VALUES = [
  "SIGABRT",
  "SIGALRM",
  "SIGBREAK",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINFO",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGLOST",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUNUSED",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
] as const;

const SignalSchema = Schema.NullOr(Schema.Literal(...SIGNAL_VALUES));

const ToolListSchema = Schema.transform(
  NonEmptyTrimmedSingleLineStringSchema,
  Schema.Array(NonEmptyTrimmedSingleLineStringSchema).pipe(
    Schema.minItems(1),
    Schema.filter((value) => new Set(value).size === value.length, {
      description: "a unique tool allowlist",
    }),
  ),
  {
    strict: true,
    decode: (value) => value.split(",").map((item) => item.trim()),
    encode: (value) => value.join(", "),
  },
);

const DiagnosticsSchema = Schema.Array(NonEmptyTrimmedSingleLineStringSchema);

const stringArray = (value: ReadonlyArray<string>): ReadonlyArray<string> =>
  Object.freeze([...value]);

const strictOptions = { onExcessProperty: "error" } as const;

const makeDecoder = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknownSync(schema, strictOptions);

const makeJsonDecoder = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknownSync(Schema.parseJson(schema), strictOptions);

export const COMPLETION_SUMMARY_MAX_CODE_POINTS = 500;

export const SemanticStatusSchema = Schema.Literal(
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
);

export const TerminalStatusSchema = Schema.Union(
  SemanticStatusSchema,
  Schema.Literal("FAILED", "ABORTED"),
);

export const RunStatusSchema = Schema.Union(
  Schema.Literal("STARTING", "RUNNING"),
  TerminalStatusSchema,
);

export const ThinkingLevelSchema = Schema.Literal(
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
);

export type SemanticStatus = Schema.Schema.Type<typeof SemanticStatusSchema>;
export type TerminalStatus = Schema.Schema.Type<typeof TerminalStatusSchema>;
export type RunStatus = Schema.Schema.Type<typeof RunStatusSchema>;
export type ThinkingLevel = Schema.Schema.Type<typeof ThinkingLevelSchema>;

export interface SubagentTaskRequest {
  readonly agent: string;
  readonly task: string;
  readonly cwd?: string;
}

export interface SubagentRequest {
  readonly tasks: ReadonlyArray<SubagentTaskRequest>;
}

export interface AgentFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly tools?: ReadonlyArray<string>;
}

export interface RunArtifacts {
  readonly runId: string;
  readonly runDirectory: string;
  readonly manifestPath: string;
  readonly taskPath: string;
  readonly systemPromptPath: string;
  readonly eventsPath: string;
  readonly stderrPath: string;
  readonly statusPath: string;
}

export interface RunManifestTask {
  readonly index: number;
  readonly cwd: string;
}

export interface RunManifestAgent {
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly tools?: ReadonlyArray<string>;
  readonly providerExtensions: ReadonlyArray<string>;
  readonly definitionPath: string;
}

export interface RunManifest {
  readonly runId: string;
  readonly createdAt: string;
  readonly task: RunManifestTask;
  readonly agent: RunManifestAgent;
  readonly artifacts: RunArtifacts;
}

export interface RunStatusRecord {
  readonly status: RunStatus;
  readonly updatedAt: string;
  readonly summary?: string;
  readonly reportPath?: string;
  readonly diagnostics?: ReadonlyArray<string>;
}

export interface CompletionResult {
  readonly status: SemanticStatus;
  readonly summary: string;
  readonly reportPath?: string;
}

export interface RunUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly turns: number;
}

export interface RunResult {
  readonly runId: string;
  readonly agent: string;
  readonly status: TerminalStatus;
  readonly summary: string;
  readonly reportPath?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly usage: RunUsage;
  readonly artifacts: RunArtifacts;
  readonly diagnostics: ReadonlyArray<string>;
}

export type SubagentToolDetails = CompletionResult;

const TaskRequestSchema: Schema.Schema<SubagentTaskRequest> = Schema.Struct({
  agent: NonEmptyTrimmedSingleLineStringSchema,
  task: NonEmptyTrimmedStringSchema,
  cwd: Schema.optional(NonEmptyTrimmedSingleLineStringSchema),
});

export const SubagentRequestSchema: Schema.Schema<SubagentRequest> =
  Schema.Struct({
    tasks: Schema.Array(TaskRequestSchema).pipe(
      Schema.minItems(1),
      Schema.maxItems(3),
    ),
  });

export const AgentFrontmatterSchema = Schema.Struct({
  name: NonEmptyTrimmedSingleLineStringSchema,
  description: NonEmptyTrimmedSingleLineStringSchema,
  model: Schema.optional(NonEmptyTrimmedSingleLineStringSchema),
  thinking: Schema.optional(ThinkingLevelSchema),
  tools: Schema.optional(ToolListSchema),
});

const SummarySchema = Schema.transform(
  Schema.String.pipe(
    Schema.filter(hasNoTerminalControls, {
      description: "text without terminal control characters",
    }),
  ),
  Schema.String.pipe(
    Schema.minLength(1),
    Schema.filter(
      (value) => Array.from(value).length <= COMPLETION_SUMMARY_MAX_CODE_POINTS,
      {
        description: `text of at most ${COMPLETION_SUMMARY_MAX_CODE_POINTS} Unicode code points`,
      },
    ),
    Schema.pattern(SINGLE_LINE_PATTERN),
    Schema.filter(hasNoTerminalControls, {
      description: "text without terminal control characters",
    }),
  ),
  {
    strict: true,
    decode: trim,
    encode: (value) => value,
  },
);

export const RunArtifactsSchema: Schema.Schema<RunArtifacts> = Schema.Struct({
  runId: NonEmptyTrimmedSingleLineStringSchema,
  runDirectory: AbsolutePathSchema,
  manifestPath: AbsolutePathSchema,
  taskPath: AbsolutePathSchema,
  systemPromptPath: AbsolutePathSchema,
  eventsPath: AbsolutePathSchema,
  stderrPath: AbsolutePathSchema,
  statusPath: AbsolutePathSchema,
});

const RunManifestTaskSchema: Schema.Schema<RunManifestTask> = Schema.Struct({
  index: Schema.NonNegativeInt,
  cwd: AbsolutePathSchema,
});

const RunManifestAgentSchema: Schema.Schema<RunManifestAgent> = Schema.Struct({
  name: NonEmptyTrimmedSingleLineStringSchema,
  description: NonEmptyTrimmedSingleLineStringSchema,
  model: NonEmptyTrimmedSingleLineStringSchema,
  thinking: ThinkingLevelSchema,
  tools: Schema.optional(Schema.Array(NonEmptyTrimmedSingleLineStringSchema)),
  providerExtensions: Schema.Array(AbsolutePathSchema),
  definitionPath: AbsolutePathSchema,
});

export const RunManifestSchema: Schema.Schema<RunManifest> = Schema.Struct({
  runId: NonEmptyTrimmedSingleLineStringSchema,
  createdAt: IsoTimestampSchema,
  task: RunManifestTaskSchema,
  agent: RunManifestAgentSchema,
  artifacts: RunArtifactsSchema,
});

export const RunStatusRecordSchema: Schema.Schema<RunStatusRecord> =
  Schema.Struct({
    status: RunStatusSchema,
    updatedAt: IsoTimestampSchema,
    summary: Schema.optional(SummarySchema),
    reportPath: Schema.optional(AbsolutePathSchema),
    diagnostics: Schema.optional(DiagnosticsSchema),
  });

export const CompletionResultSchema: Schema.Schema<CompletionResult> =
  Schema.Struct({
    status: SemanticStatusSchema,
    summary: SummarySchema,
    reportPath: Schema.optional(AbsolutePathSchema),
  });

export const RunUsageSchema: Schema.Schema<RunUsage> = Schema.Struct({
  input: Schema.NonNegativeInt,
  output: Schema.NonNegativeInt,
  cacheRead: Schema.NonNegativeInt,
  cacheWrite: Schema.NonNegativeInt,
  cost: Schema.NonNegative,
  turns: Schema.NonNegativeInt,
});

export const RunResultSchema: Schema.Schema<RunResult> = Schema.Struct({
  runId: NonEmptyTrimmedSingleLineStringSchema,
  agent: NonEmptyTrimmedSingleLineStringSchema,
  status: TerminalStatusSchema,
  summary: SummarySchema,
  reportPath: Schema.optional(AbsolutePathSchema),
  exitCode: Schema.NullOr(Schema.Int),
  signal: SignalSchema,
  usage: RunUsageSchema,
  artifacts: RunArtifactsSchema,
  diagnostics: DiagnosticsSchema,
});

export const SubagentToolDetailsSchema: Schema.Schema<SubagentToolDetails> =
  CompletionResultSchema;

const freezeTaskRequest = (value: SubagentTaskRequest): SubagentTaskRequest =>
  Object.freeze({
    agent: value.agent,
    task: value.task,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
  });

const freezeSubagentRequest = (value: SubagentRequest): SubagentRequest =>
  Object.freeze({
    tasks: Object.freeze(value.tasks.map(freezeTaskRequest)),
  });

const freezeAgentFrontmatter = (value: AgentFrontmatter): AgentFrontmatter =>
  Object.freeze({
    name: value.name,
    description: value.description,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
    ...(value.tools === undefined ? {} : { tools: stringArray(value.tools) }),
  });

const freezeRunArtifacts = (value: RunArtifacts): RunArtifacts =>
  Object.freeze({
    runId: value.runId,
    runDirectory: value.runDirectory,
    manifestPath: value.manifestPath,
    taskPath: value.taskPath,
    systemPromptPath: value.systemPromptPath,
    eventsPath: value.eventsPath,
    stderrPath: value.stderrPath,
    statusPath: value.statusPath,
  });

const freezeRunManifestTask = (value: RunManifestTask): RunManifestTask =>
  Object.freeze({
    index: value.index,
    cwd: value.cwd,
  });

const freezeRunManifestAgent = (value: RunManifestAgent): RunManifestAgent =>
  Object.freeze({
    name: value.name,
    description: value.description,
    model: value.model,
    thinking: value.thinking,
    ...(value.tools === undefined ? {} : { tools: stringArray(value.tools) }),
    providerExtensions: stringArray(value.providerExtensions),
    definitionPath: value.definitionPath,
  });

const freezeRunManifest = (value: RunManifest): RunManifest =>
  Object.freeze({
    runId: value.runId,
    createdAt: value.createdAt,
    task: freezeRunManifestTask(value.task),
    agent: freezeRunManifestAgent(value.agent),
    artifacts: freezeRunArtifacts(value.artifacts),
  });

const freezeRunStatusRecord = (value: RunStatusRecord): RunStatusRecord =>
  Object.freeze({
    status: value.status,
    updatedAt: value.updatedAt,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(value.reportPath === undefined ? {} : { reportPath: value.reportPath }),
    ...(value.diagnostics === undefined
      ? {}
      : { diagnostics: stringArray(value.diagnostics) }),
  });

const freezeCompletionResult = (value: CompletionResult): CompletionResult =>
  Object.freeze({
    status: value.status,
    summary: value.summary,
    ...(value.reportPath === undefined ? {} : { reportPath: value.reportPath }),
  });

const freezeRunUsage = (value: RunUsage): RunUsage =>
  Object.freeze({
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    cost: value.cost,
    turns: value.turns,
  });

const freezeRunResult = (value: RunResult): RunResult =>
  Object.freeze({
    runId: value.runId,
    agent: value.agent,
    status: value.status,
    summary: value.summary,
    ...(value.reportPath === undefined ? {} : { reportPath: value.reportPath }),
    exitCode: value.exitCode,
    signal: value.signal,
    usage: freezeRunUsage(value.usage),
    artifacts: freezeRunArtifacts(value.artifacts),
    diagnostics: stringArray(value.diagnostics),
  });

const decodeSubagentRequestValue = makeDecoder(SubagentRequestSchema);
const decodeAgentFrontmatterValue = makeDecoder(AgentFrontmatterSchema);
const decodeRunManifestValue = makeDecoder(RunManifestSchema);
const decodeRunManifestJsonValue = makeJsonDecoder(RunManifestSchema);
const decodeRunStatusRecordValue = makeDecoder(RunStatusRecordSchema);
const decodeRunStatusRecordJsonValue = makeJsonDecoder(RunStatusRecordSchema);
const decodeCompletionValue = makeDecoder(CompletionResultSchema);
const decodeRunUsageValue = makeDecoder(RunUsageSchema);
const decodeRunResultValue = makeDecoder(RunResultSchema);
const decodeSubagentToolDetailsValue = makeDecoder(SubagentToolDetailsSchema);

export const decodeSubagentRequest = (value: unknown): SubagentRequest =>
  freezeSubagentRequest(decodeSubagentRequestValue(value));

export const decodeTasks = decodeSubagentRequest;

export const decodeAgentFrontmatter = (value: unknown): AgentFrontmatter =>
  freezeAgentFrontmatter(decodeAgentFrontmatterValue(value));

export const decodeRunManifest = (value: unknown): RunManifest =>
  freezeRunManifest(decodeRunManifestValue(value));

export const decodeRunManifestJson = (value: unknown): RunManifest =>
  freezeRunManifest(decodeRunManifestJsonValue(value));

export const decodeRunStatusRecord = (value: unknown): RunStatusRecord =>
  freezeRunStatusRecord(decodeRunStatusRecordValue(value));

export const decodeRunStatusRecordJson = (value: unknown): RunStatusRecord =>
  freezeRunStatusRecord(decodeRunStatusRecordJsonValue(value));

export const decodeCompletion = (value: unknown): CompletionResult =>
  freezeCompletionResult(decodeCompletionValue(value));

export const decodeRunUsage = (value: unknown): RunUsage =>
  freezeRunUsage(decodeRunUsageValue(value));

export const decodeRunResult = (value: unknown): RunResult =>
  freezeRunResult(decodeRunResultValue(value));

export const decodeSubagentToolDetails = (
  value: unknown,
): SubagentToolDetails =>
  freezeCompletionResult(decodeSubagentToolDetailsValue(value));
