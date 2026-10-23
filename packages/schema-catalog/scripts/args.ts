export function argValue(args: readonly string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
}
