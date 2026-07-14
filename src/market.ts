/** 侧边栏使用的市场分类 */
export type MarketCategory = 'cn' | 'hk' | 'us' | 'crypto' | 'forex' | 'other';

/** 固定的侧边栏分组顺序与显示名称 */
export const MARKET_GROUPS: ReadonlyArray<{
  category: MarketCategory;
  label: string;
}> = [
  { category: 'cn', label: 'A股' },
  { category: 'hk', label: '港股' },
  { category: 'us', label: '美股' },
  { category: 'crypto', label: '加密货币' },
  { category: 'forex', label: '外汇' },
  { category: 'other', label: '其他' },
];

const BINANCE_PAIR_RE = /^[a-z0-9.]+(?:[/\\-][a-z0-9.]+|(?:usdt|usdc|busd|usd))$/i;

/**
 * 按用户配置代码识别市场。
 *
 * 未识别代码仍会保留在“其他”分组，避免配置错误时标的从侧边栏消失。
 */
export function classifyMarket(code: string): MarketCategory {
  const normalized = code.trim().toLowerCase();
  if (/^(sh|sz|bj)/.test(normalized)) return 'cn';
  if (normalized.startsWith('hk')) return 'hk';
  if (normalized.startsWith('usr_')) return 'us';
  if (normalized.startsWith('fx_')) return 'forex';
  if (BINANCE_PAIR_RE.test(normalized)) return 'crypto';
  return 'other';
}

/** 新浪行情支持的市场代码 */
export function isSinaCode(code: string): boolean {
  const category = classifyMarket(code);
  return category === 'cn' || category === 'hk' || category === 'us' || category === 'forex';
}

/** 按侧边栏市场分组展开代码，同时保留每个分组内的输入顺序 */
export function orderCodesByMarket(codes: readonly string[]): string[] {
  return MARKET_GROUPS.flatMap(group =>
    codes.filter(code => classifyMarket(code) === group.category),
  );
}
