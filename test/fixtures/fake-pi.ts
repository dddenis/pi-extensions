#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { GENERAL_AGENT_ROLE_PROMPT } from "../../src/subagents/general-agent";

const args = process.argv.slice(2);

const rejectInvocation = (code: string, message: string): never => {
  process.stderr.write(
    `FAKE_PI invocation-error code=${code} message=${message}\n`,
  );
  process.exit(64);
};

const requireValue = (
  value: string | undefined,
  code: string,
  message: string,
): string =>
  value === undefined || value.length === 0
    ? rejectInvocation(code, message)
    : value;

const optionValues = (name: string): ReadonlyArray<string> =>
  args.flatMap((argument, index) =>
    argument === name && args[index + 1] !== undefined
      ? [args[index + 1] as string]
      : [],
  );

const toolOptions = optionValues("--tools");
if (toolOptions.length !== 1) {
  rejectInvocation(
    "tools-option-count",
    `expected exactly one --tools, received ${toolOptions.length}`,
  );
}
const activeToolNames = requireValue(
  toolOptions[0],
  "tools-option-value",
  "--tools requires one value",
)
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
if (
  activeToolNames.filter((name) => name === "complete_subagent").length !== 1
) {
  rejectInvocation(
    "completion-tool-count",
    "complete_subagent must appear exactly once",
  );
}
if (activeToolNames.includes("subagent")) {
  rejectInvocation("nested-subagent-active", "subagent must be inactive");
}
if (!args.includes("--no-extensions")) {
  rejectInvocation(
    "normal-extension-discovery",
    "--no-extensions must disable normal discovery",
  );
}
const extensionPaths = optionValues("--extension");

const taskReferences = args.filter((argument) => argument.startsWith("@"));
if (taskReferences.length !== 1) {
  rejectInvocation(
    "task-reference-count",
    `expected exactly one @task.md reference, received ${taskReferences.length}`,
  );
}
const taskPath = requireValue(
  taskReferences[0]?.slice(1),
  "task-reference-value",
  "task reference has no path",
);
if (!path.isAbsolute(taskPath)) {
  rejectInvocation("task-reference-absolute", "task path must be absolute");
}
if (path.basename(taskPath) !== "task.md") {
  rejectInvocation("task-reference-name", "task path must end in task.md");
}

const promptOption = "--append-system-prompt";
const promptOptionIndexes = args.flatMap((argument, index) =>
  argument === promptOption ? [index] : [],
);
if (promptOptionIndexes.length !== 1) {
  rejectInvocation(
    "prompt-option-count",
    `expected exactly one ${promptOption}, received ${promptOptionIndexes.length}`,
  );
}
const promptOptionIndex = promptOptionIndexes[0];
const systemPromptPath = requireValue(
  promptOptionIndex === undefined ? undefined : args[promptOptionIndex + 1],
  "prompt-option-value",
  `${promptOption} requires one path value`,
);
if (!path.isAbsolute(systemPromptPath)) {
  rejectInvocation(
    "prompt-path-absolute",
    "system prompt path must be absolute",
  );
}
if (path.basename(systemPromptPath) !== "system-prompt.md") {
  rejectInvocation(
    "prompt-path-name",
    "system prompt path must end in system-prompt.md",
  );
}
if (path.dirname(taskPath) !== path.dirname(systemPromptPath)) {
  rejectInvocation(
    "run-directory-mismatch",
    "task and system prompt must share one run directory",
  );
}

const readRequired = (filePath: string, code: string): string => {
  try {
    return readFileSync(filePath, "utf8");
  } catch (cause) {
    return rejectInvocation(
      code,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
};

const taskText = readRequired(taskPath, "task-read");
const systemPromptText = readRequired(systemPromptPath, "prompt-read");
const nestedDelegationPrompt =
  "Do not launch subagents or delegate this task. Complete it yourself.";
const structuredCompletionPrompt =
  "Before finishing, call complete_subagent exactly once as your sole final tool call. Use status DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED; provide a concise single-line summary; and provide an absolute reportPath when a report is required.";
const allowedRolePrompts = [
  "Handle the delegated task and report the result.",
  GENERAL_AGENT_ROLE_PROMPT,
];
const promptValidated = allowedRolePrompts.some(
  (rolePrompt) =>
    systemPromptText ===
    `${rolePrompt}\n\n${nestedDelegationPrompt}\n\n${structuredCompletionPrompt}\n`,
);
if (!promptValidated) {
  rejectInvocation(
    "prompt-content",
    "system prompt does not match generated role/nesting/completion content",
  );
}

const taskBody = taskText.trim();
const promptBody = systemPromptText.trim();
const directTaskBody = args.some(
  (argument) => taskBody.length > 0 && argument.includes(taskBody),
);
if (directTaskBody) {
  rejectInvocation("direct-task-body", "task body appeared directly in argv");
}
const directPromptBody = args.some(
  (argument) => promptBody.length > 0 && argument.includes(promptBody),
);
if (directPromptBody) {
  rejectInvocation(
    "direct-prompt-body",
    "system prompt body appeared directly in argv",
  );
}

const lines = taskText.split(/\r?\n/u);
const mode = requireValue(lines[0]?.trim(), "mode-missing", "missing mode");
const id = requireValue(lines[1]?.trim(), "id-missing", "missing child id");
if (!/^[A-Za-z0-9._-]+$/u.test(id)) {
  rejectInvocation("id-invalid", "child id must be sidecar-safe");
}
const delayDirective = lines.find((line) => line.startsWith("delay="));
const delayValue = delayDirective?.slice("delay=".length);
const delay = delayValue === undefined ? 80 : Number(delayValue);
if (
  ![
    "success",
    "blocked",
    "missing-completion",
    "malformed",
    "nonzero",
    "launch-delay",
    "retained-output",
    "stall",
  ].includes(mode)
) {
  rejectInvocation("mode-unsupported", `unsupported mode ${mode}`);
}
if (!Number.isFinite(delay) || delay < 0) {
  rejectInvocation("delay-invalid", `invalid delay ${String(delayValue)}`);
}

const runDirectory = path.dirname(taskPath);
const statusPath = path.join(runDirectory, "status.json");
const sandbox = path.dirname(path.dirname(path.dirname(runDirectory)));
const sidecarPath = path.join(sandbox, "observations", `${id}.jsonl`);
const identity = randomUUID();

const observe = (
  event: string,
  extra: Readonly<Record<string, string | number | boolean>> = {},
): void => {
  appendFileSync(
    sidecarPath,
    `${JSON.stringify({
      event,
      identity,
      id,
      mode,
      at: Date.now(),
      pid: process.pid,
      ...extra,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
};

const statusAtSignal = (): string => {
  try {
    const value: unknown = JSON.parse(readFileSync(statusPath, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      typeof value.status === "string"
    ) {
      return value.status;
    }
    return "INVALID";
  } catch {
    return "UNREADABLE";
  }
};

process.on("exit", (code) => {
  observe("exit", { code });
});

process.on("SIGTERM", () => {
  const action = mode === "stall" ? "stall" : "exit";
  const status = statusAtSignal();
  observe("sigterm", { action, status });
  process.stderr.write(
    `FAKE_PI sigterm identity=${identity} action=${action} status=${status}\n`,
  );
  if (mode !== "stall") {
    setTimeout(() => process.exit(0), 5);
  }
});

observe("validation", {
  taskPath,
  systemPromptPath,
  taskReferenceCount: taskReferences.length,
  promptOptionCount: promptOptionIndexes.length,
  taskAbsolute: path.isAbsolute(taskPath),
  promptAbsolute: path.isAbsolute(systemPromptPath),
  sameRunDirectory: path.dirname(taskPath) === path.dirname(systemPromptPath),
  promptValidated,
  directTaskBody,
  directPromptBody,
  toolNames: activeToolNames.join(","),
  extensionPaths: extensionPaths.join(","),
  completionToolCount: activeToolNames.filter(
    (name) => name === "complete_subagent",
  ).length,
  subagentActive: activeToolNames.includes("subagent"),
  normalExtensionsDisabled: args.includes("--no-extensions"),
});
observe("ready");
process.stderr.write(
  `FAKE_PI ready identity=${identity} validation=passed id=${id}\n`,
);

const emit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const finalUsage = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 23,
  cost: {
    input: 0.11,
    output: 0.07,
    cacheRead: 0.03,
    cacheWrite: 0.02,
    total: 0.23,
  },
};

const sessionEvent = {
  type: "session",
  version: 3,
  id: `fake-session-${id}`,
  timestamp: new Date().toISOString(),
  cwd: process.cwd(),
};
const expandedTaskPrompt = `<file name="${taskPath}">\n${taskText}\n</file>\n`;
const userMessage = {
  role: "user",
  content: expandedTaskPrompt,
  timestamp: Date.now(),
};

const emitRunStart = (): void => {
  emit(sessionEvent);
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: userMessage });
  emit({ type: "message_end", message: userMessage });
};

const assistantMessage = (
  content: ReadonlyArray<unknown>,
  stopReason: "stop" | "toolUse",
  timestamp: number,
  usage: typeof finalUsage,
) => ({
  role: "assistant",
  content,
  api: "fake-pi-json",
  provider: "fake-provider",
  model: "fake-model",
  usage,
  stopReason,
  timestamp,
});

const emitCompletion = (status: "DONE" | "BLOCKED", summary: string): void => {
  const assistantTimestamp = Date.now();
  const toolCallId = `complete-${id}`;
  const argumentsValue = { status, summary };
  const toolCall = {
    type: "toolCall",
    id: toolCallId,
    name: "complete_subagent",
    arguments: argumentsValue,
  };
  const assistantStart = assistantMessage(
    [],
    "toolUse",
    assistantTimestamp,
    emptyUsage,
  );
  const assistantEnd = assistantMessage(
    [toolCall],
    "toolUse",
    assistantTimestamp,
    finalUsage,
  );
  emit({ type: "message_start", message: assistantStart });
  emit({
    type: "message_update",
    message: assistantEnd,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall,
      partial: assistantEnd,
    },
  });
  emit({ type: "message_end", message: assistantEnd });
  emit({
    type: "tool_execution_start",
    toolCallId,
    toolName: "complete_subagent",
    args: argumentsValue,
  });
  const completionResult = {
    content: [
      { type: "text", text: `Subagent completion recorded: ${status}` },
    ],
    details: { status, summary },
    terminate: true,
  };
  emit({
    type: "tool_execution_end",
    toolCallId,
    toolName: "complete_subagent",
    result: completionResult,
    isError: false,
  });
  const toolResultMessage = {
    role: "toolResult",
    toolCallId,
    toolName: "complete_subagent",
    content: completionResult.content,
    details: completionResult.details,
    isError: false,
    timestamp: Date.now(),
  };
  emit({ type: "message_start", message: toolResultMessage });
  emit({ type: "message_end", message: toolResultMessage });
  emit({
    type: "turn_end",
    message: assistantEnd,
    toolResults: [toolResultMessage],
  });
  emit({
    type: "agent_end",
    messages: [userMessage, assistantEnd, toolResultMessage],
    willRetry: false,
  });
  emit({ type: "agent_settled" });
};

const emitMissingCompletion = (): void => {
  const assistantTimestamp = Date.now();
  const assistantStart = assistantMessage(
    [],
    "stop",
    assistantTimestamp,
    emptyUsage,
  );
  const text = { type: "text", text: `No completion for ${id}` };
  const assistantEnd = assistantMessage(
    [text],
    "stop",
    assistantTimestamp,
    finalUsage,
  );
  emit({ type: "message_start", message: assistantStart });
  emit({
    type: "message_update",
    message: assistantEnd,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: text.text,
      partial: assistantEnd,
    },
  });
  emit({ type: "message_end", message: assistantEnd });
  emit({ type: "turn_end", message: assistantEnd, toolResults: [] });
  emit({
    type: "agent_end",
    messages: [userMessage, assistantEnd],
    willRetry: false,
  });
  emit({ type: "agent_settled" });
};

const finish = async (): Promise<void> => {
  process.stderr.write(`FAKE_PI start identity=${identity} id=${id}\n`);
  emitRunStart();

  if (mode === "stall") {
    await new Promise<void>(() => undefined);
    return;
  }

  await Bun.sleep(delay);

  switch (mode) {
    case "success":
    case "launch-delay":
      emitCompletion("DONE", `Fake Pi completed ${id}`);
      break;
    case "retained-output": {
      emitCompletion("DONE", `Fake Pi completed ${id}`);
      const descendant = spawn(
        process.execPath,
        ["-e", "setTimeout(() => undefined, 500)"],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      descendant.unref();
      observe("descendant", { descendantPid: descendant.pid ?? -1 });
      break;
    }
    case "blocked":
      emitCompletion("BLOCKED", `Fake Pi blocked ${id}`);
      break;
    case "missing-completion":
      emitMissingCompletion();
      break;
    case "malformed":
      process.stdout.write("{malformed-json\n");
      break;
    case "nonzero":
      process.stderr.write(`FAKE_PI nonzero identity=${identity} id=${id}\n`);
      process.exitCode = 23;
      break;
  }
  observe("end");
  process.stderr.write(`FAKE_PI end identity=${identity} id=${id}\n`);
};

await finish();
