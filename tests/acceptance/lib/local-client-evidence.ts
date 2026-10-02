import { record, stringValue, type Json } from "./local-budget"

const MARKER = "LOCAL_TOOL_42"

/** Only synthetic acceptance content is retained; reasoning and arbitrary text are omitted. */
export function textEvidence(value: unknown): Json {
  let text = JSON.stringify(value ?? null)
  if (typeof value === "string") text = value
  else if (Array.isArray(value)) {
    const parts: Array<unknown> = value.flatMap(
      (part: unknown): Array<unknown> =>
        Array.isArray(part) ? (part as Array<unknown>) : [part],
    )
    text = parts.map((part) => stringValue(record(part).text)).join("\n")
  }
  return {
    characters: text.length,
    markerPresent: text.includes(MARKER),
    exactMarker: text.trim() === MARKER,
    blocked: /reject|denied|not allowed|blocked|policy/iu.test(text),
    exitCodeZero: /"?exit_code"?\s*:\s*0|Process exited with code 0/u.test(
      text,
    ),
    shellCall:
      /exec_command/u.test(text)
      && /Get-Content -Raw|type marker\.txt/u.test(text),
    markerReadCommand:
      /(?:^|\s-Command\s+["']?)Get-Content\s+-Raw\s+["']?\.\\marker\.txt["']?$/iu.test(
        text.trim(),
      ) || /(?:^|\s\/c\s+["']?)type\s+marker\.txt["']?$/iu.test(text.trim()),
    emptyPagesValidation: /pages/iu.test(text) && /invalid|empty/iu.test(text),
    ...(text.length <= 200 && /^[\s\d|→:_A-Z-]*$/u.test(text) ?
      { syntheticText: text }
    : {}),
  }
}

export function readArguments(value: unknown): Json {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return { validJson: false }
    }
  }
  const args = record(parsed)
  const file = stringValue(args.file_path).replaceAll("\\", "/")
  return {
    validJson: typeof parsed === "object" && parsed !== null,
    keys: Object.keys(args).sort(),
    markerPath: file === "marker.txt" || file.endsWith("/marker.txt"),
    ...Object.fromEntries(
      ["offset", "limit", "pages"]
        .filter((key) => Object.hasOwn(args, key))
        .map((key) => [
          key,
          (
            typeof args[key] === "number"
            || (typeof args[key] === "string" && /^[\d,-]*$/u.test(args[key]))
          ) ?
            args[key]
          : "[omitted]",
        ]),
    ),
  }
}

export function projectClientEvents(events: Array<Json>): Array<Json> {
  const result: Array<Json> = []
  for (const event of events) {
    const item = record(
      event.item ?? (event.type === "response_item" ? event.payload : event),
    )
    const type = stringValue(item.type)
    if (event.type === "result")
      result.push({
        type: "result",
        isError: event.is_error,
        subtype: event.subtype,
        final: textEvidence(event.result),
        usage: event.usage,
      })
    if (type === "agent_message")
      result.push({ type, final: textEvidence(item.text) })
    if (
      [
        "command_execution",
        "custom_tool_call",
        "custom_tool_call_output",
      ].includes(type)
    ) {
      result.push({
        type,
        id: item.id,
        callId: item.call_id,
        name: item.name,
        status: item.status,
        exitCode: item.exit_code,
        command: textEvidence(item.command ?? item.input),
        output: textEvidence(item.aggregated_output ?? item.output),
      })
    }
    const message = record(event.message)
    if (Array.isArray(message.content))
      for (const raw of message.content) {
        const block = record(raw)
        if (block.type === "tool_use" && block.name === "Read")
          result.push({
            type: "read_call",
            id: block.id,
            arguments: readArguments(block.input),
          })
        if (block.type === "tool_result")
          result.push({
            type: "read_result",
            callId: block.tool_use_id,
            isError: block.is_error === true,
            output: textEvidence(block.content),
          })
      }
    if (
      ["error", "turn.completed", "turn.failed"].includes(
        stringValue(event.type),
      )
    )
      result.push({
        type: event.type,
        usage: event.usage,
        error: textEvidence(event.error ?? event.message),
      })
  }
  return result.slice(0, 100)
}

export function clientVerdict(
  client: "claude" | "codex",
  evidence: Array<Json>,
): Json {
  const calls = evidence.filter((event) => event.type === "read_call")
  const results = evidence.filter((event) => event.type === "read_result")
  const commands = evidence.filter(
    (event) => event.type === "command_execution",
  )
  const custom = evidence.filter((event) => event.type === "custom_tool_call")
  const outputs = evidence.filter(
    (event) => event.type === "custom_tool_call_output",
  )
  const blocked = [...commands, ...outputs].some(
    (event) =>
      record(event.output).blocked === true || event.status === "blocked",
  )
  const execution =
    client === "claude" ?
      calls.length > 0
      && results.some(
        (event) =>
          event.isError === false
          && record(event.output).markerPresent === true
          && calls.some((call) => call.id === event.callId),
      )
    : commands.some(
        (event) =>
          event.exitCode === 0
          && event.status === "completed"
          && record(event.command).markerReadCommand === true
          && record(event.output).markerPresent === true,
      )
      || outputs.some(
        (event) =>
          record(event.output).markerPresent === true
          && record(event.output).exitCodeZero === true
          && !record(event.output).blocked
          && custom.some(
            (call) =>
              call.callId === event.callId
              && call.callId !== undefined
              && record(call.command).shellCall === true,
          ),
      )
  const validArguments =
    client === "claude" ?
      calls.length > 0
      && calls.every(
        (event) =>
          record(event.arguments).validJson === true
          && record(event.arguments).markerPath === true
          && record(event.arguments).pages !== "",
      )
      && !results.some((event) => event.isError === true)
    : execution
  const finals = evidence.filter(
    (event) => event.type === "result" || event.type === "agent_message",
  )
  return {
    validArguments,
    toolExecution: execution,
    exactFinal: record(finals.at(-1)?.final).exactMarker === true,
    blocked,
  }
}

export function projectWireEvent(event: Json): Json {
  const response = record(event.response ?? event)
  const item = record(event.item)
  return {
    type: event.type,
    status: response.status,
    usage: response.usage,
    ...(item.type === "function_call" && item.name === "Read" ?
      {
        readCall: {
          id: item.call_id,
          arguments: readArguments(item.arguments),
        },
      }
    : {}),
  }
}
