/** 计算现价在日内最低价到最高价之间的位置，结果限制在 0–100。 */
export function calculateDayRangePosition(
  current: number,
  low: number,
  high: number,
): number | undefined {
  if (![current, low, high].every(Number.isFinite) || high < low) return undefined;
  if (high === low) return 50;
  return Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100));
}
