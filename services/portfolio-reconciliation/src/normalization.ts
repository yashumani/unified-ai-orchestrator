const MULTISPACE = /\s+/gu;
const NON_LABEL = /[^a-z0-9+#. -]+/gu;

export function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(NON_LABEL, " ")
    .replace(MULTISPACE, " ")
    .trim();
}

export function normalizeLabels(values: readonly string[]): string[] {
  return [
    ...new Set(values.map(normalizeLabel).filter((value) => value.length > 0))
  ].sort((left, right) => left.localeCompare(right));
}

export function jaccardSimilarity(
  leftValues: readonly string[],
  rightValues: readonly string[]
): { score: number; shared: string[] } {
  const left = new Set(normalizeLabels(leftValues));
  const right = new Set(normalizeLabels(rightValues));
  const union = new Set([...left, ...right]);
  const shared = [...left]
    .filter((value) => right.has(value))
    .sort((first, second) => first.localeCompare(second));
  return {
    score: union.size === 0 ? 0 : shared.length / union.size,
    shared
  };
}
