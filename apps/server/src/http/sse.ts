interface SseWriter {
  write(chunk: string): unknown;
}

export function writeSseData(writer: SseWriter, data: unknown): void {
  writer.write(`data: ${JSON.stringify(data)}\n\n`);
}
