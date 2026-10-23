interface PartialToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

interface CompletedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Finalize streamed indexed calls once, preserving their stream order. */
export function finalizeToolCalls(
  callsByIndex: ReadonlyMap<number, PartialToolCall>,
): CompletedToolCall[] {
  return [...callsByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({ ...call, id: call.id ?? `call_${Date.now()}` }))
    .filter((call): call is CompletedToolCall => Boolean(call.name));
}
