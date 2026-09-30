export function finiteInput(value: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
