export type PriceTrend = 'rise' | 'fall' | 'flat';

/** 比较单个价格与涨跌基准，供日内低、现、高分别着色。 */
export function comparePriceToBasis(price: number, basis: number): PriceTrend {
  if (!Number.isFinite(price) || !Number.isFinite(basis) || basis <= 0) return 'flat';
  if (price > basis) return 'rise';
  if (price < basis) return 'fall';
  return 'flat';
}

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
