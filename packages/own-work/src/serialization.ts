export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

export function stringifySortedJson(value: unknown, indentation = 2): string {
  return `${JSON.stringify(sortJsonValue(value), null, indentation)}\n`;
}

export function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}
