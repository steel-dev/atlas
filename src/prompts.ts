export function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function todayLine(todayISO: string): string {
  return `Today's date is ${todayISO}. Interpret "current", "recent", and "latest" relative to this date, not your training data; for any time-bound question, seek the most recent figures available.`;
}
