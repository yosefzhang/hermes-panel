export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export function parseJson(text: string): unknown {
  return text.trim() ? JSON.parse(text) : {};
}