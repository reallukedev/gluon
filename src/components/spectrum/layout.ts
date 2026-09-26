/**
 * Places spectrum callouts on up to `rows` label rows. Each label hangs from its group's left edge
 * (`left`) and takes the first row where it clears the previous label on that row by `gap`. Only
 * when every row is still occupied does it take the row that frees up soonest, and the label it
 * lands after is capped (`max`) so the two names never run together.
 */
export function placeLabels(items: { left: number; width: number }[], rows: number, gap: number): { row: number; max: number | null }[] {
  const ends: number[] = [];
  const lastOnRow: number[] = [];
  const out = items.map(() => ({ row: 0, max: null as number | null }));
  items.forEach((it, i) => {
    let row = 0;
    while (row < rows && (ends[row] ?? -Infinity) + gap > it.left) row++;
    if (row === rows) {
      row = ends.indexOf(Math.min(...ends));
      const prev = lastOnRow[row];
      if (prev !== undefined) out[prev]!.max = Math.max(0, it.left - items[prev]!.left - gap / 2);
    }
    out[i]!.row = row;
    ends[row] = it.left + it.width;
    lastOnRow[row] = i;
  });
  return out;
}
