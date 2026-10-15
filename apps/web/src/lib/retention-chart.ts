export interface RetentionPoint {
  x: number;
  y: number;
  missing: boolean;
}

/** Chart y for a 0..1 ratio. 90% with the stats viewBox lands at 32. */
export function retentionY(ratio: number, top = 20, height = 120): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  return top + (1 - clamped) * height;
}

/** A missing day lifts the pen. The stroke does not cross the gap. */
export function retentionStroke(points: RetentionPoint[]): string {
  let path = '';
  let penDown = false;
  for (const point of points) {
    if (point.missing) {
      penDown = false;
      continue;
    }
    path += `${penDown ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
    penDown = true;
  }
  return path.trim();
}
