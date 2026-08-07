/** 交易时段 */
export type MarketState = 'PRE' | 'REGULAR' | 'POST' | 'OVERNIGHT' | 'CLOSED';

/** 单个品种的行情数据（统一格式，无论来源） */
export interface StockData {
  code: string;
  name: string;
  price: number;
  change: number;        // 涨跌额
  changePercent: number; // 涨跌幅（如 -0.88）
  high: number;          // 最高价
  low: number;           // 最低价
  open: number;          // 开盘价
  yestclose: number;     // 昨收价
  time: string;          // 行情时间
  marketState?: MarketState; // 交易时段（盘前/盘中/盘后）
  /** 获取失败时的错误信息（非空表示该品种获取失败） */
  error?: string;
  /** ETF 实时参考净值（IOPV），用于计算溢价率 */
  iopv?: number;
  /** 数据源明确提供的是延迟行情 */
  delayed?: boolean;
  /** 本轮刷新失败，当前显示最近一次成功获取的缓存行情 */
  stale?: boolean;
  /** 数据源尚无有效最新价（如未开市或停牌），当前价暂按昨收显示 */
  usingPreviousClose?: boolean;
}

/** 格式化后的展示数据 */
export interface TickerDisplay {
  code: string;
  name: string;
  price: string;
  change: string;
  percent: string;
  icon: string;
  session: string;    // 交易时段标记（🌅/🌙/空）
  premium: string;    // ETF 溢价率（如 +8.67%）
}

/** 支持的模板占位符 */
export type FormatField = 'icon' | 'name' | 'price' | 'change' | 'percent' | 'code' | 'session' | 'premium';

/** 品种类型 */
export type TickerType = 'stock' | 'crypto';

/** 解析后的配置 */
export interface AppConfig {
  stockCodes: string[];        // 股票代码（sh/sz/hk/usr_）
  statusBarCodes: string[] | null; // null 表示状态栏沿用前 maxItems 个
  cryptoSymbols: string[];     // 加密货币交易对（BTCUSDT）
  interval: number;            // 刷新间隔（秒）
  format: string;              // 模板字符串
  formatFields: FormatField[]; // 模板中使用的字段
  maxItems: number;
  riseColor: string;
  fallColor: string;
  flatColor: string;
  precision: Record<string, number>; // 代码 → 小数位数
  defaultPrecision: number;          // 默认小数位数
  premiumCodes: string[];            // 需要显示 ETF 溢价率的代码列表
  priceScale: Record<string, number>; // 代码 → 显示乘数（如 fx_sjpycnh: 100）
}

/** 标准化的模板占位符配置（用于构建格式化输出） */
export const FORMAT_FIELDS: Record<FormatField, string> = {
  icon: '${icon}',
  name: '${name}',
  price: '${price}',
  change: '${change}',
  percent: '${percent}',
  code: '${code}',
  session: '${session}',
  premium: '${premium}',
};

/** 获取交易时段图标 */
export function getSessionIcon(state?: MarketState): string {
  if (state === 'PRE') return '🌅';
  if (state === 'POST') return '🌙';
  if (state === 'OVERNIGHT') return '🌃';
  return '';
}

/** 将同比变化量映射为涨跌图标 */
export function getIcon(change: number): string {
  if (change > 0) return '📈';
  if (change < 0) return '📉';
  return '➡️';
}

/** 格式化数值（自动处理小数位数，可选覆盖） */
export function formatPrice(price: number, precision?: number): string {
  if (precision !== undefined) return price.toFixed(precision);
  // 自动判断：高价（>100）2位，中价（>1）3位，低价（<1）4位
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(3);
  return price.toFixed(4);
}

/** 格式化涨跌额，带正负号 */
export function formatChange(change: number): string {
  return (change > 0 ? '+' : '') + change.toFixed(2);
}

/** 格式化涨跌幅，带正负号和百分号 */
export function formatPercent(percent: number): string {
  return (percent > 0 ? '+' : '') + percent.toFixed(2) + '%';
}

/** 格式化所有字段为显示对象 */
export function formatTicker(data: StockData, precision?: number, scale?: number): TickerDisplay {
  const multiplier = scale || 1;
  const displayPrice = data.price * multiplier;
  return {
    code: data.code,
    name: data.name,
    price: formatPrice(displayPrice, precision),
    change: formatChange(data.change * multiplier),
    percent: formatPercent(data.changePercent),
    icon: getIcon(data.changePercent),
    session: getSessionIcon(data.marketState),
    premium: data.iopv ? formatPercent((data.price / data.iopv - 1) * 100) : '',
  };
}

/** 按模板格式化显示文本 */
export function applyFormat(template: string, display: TickerDisplay): string {
  return template
    .replace(/\$\{icon\}/g, display.icon)
    .replace(/\$\{name\}/g, display.name)
    .replace(/\$\{price\}/g, display.price)
    .replace(/\$\{change\}/g, display.change)
    .replace(/\$\{percent\}/g, display.percent)
    .replace(/\$\{code\}/g, display.code)
    .replace(/\$\{session\}/g, display.session)
    .replace(/\$\{premium\}/g, display.premium);
}

/** 从模板字符串中提取使用的字段 */
export function extractFormatFields(template: string): FormatField[] {
  const fields: FormatField[] = [];
  const fieldMap: [RegExp, FormatField][] = [
    [/\$\{icon\}/g, 'icon'],
    [/\$\{name\}/g, 'name'],
    [/\$\{price\}/g, 'price'],
    [/\$\{change\}/g, 'change'],
    [/\$\{percent\}/g, 'percent'],
    [/\$\{code\}/g, 'code'],
    [/\$\{session\}/g, 'session'],
    [/\$\{premium\}/g, 'premium'],
  ];
  for (const [re, field] of fieldMap) {
    re.lastIndex = 0;
    if (re.test(template)) {
      fields.push(field);
    }
  }
  return fields;
}

/** 格式化时间，统一为东八区 CST (YYYY-MM-DD HH:MM:SS) */
function formatCstTime(raw?: string): string {
  if (raw && /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).replace(/\//g, '-');
}

/** 构建悬停提示文本 */
export function buildTooltip(data: StockData, precision?: number, scale?: number): string {
  const multiplier = scale || 1;
  const price = data.price * multiplier;
  const change = data.change * multiplier;
  const high = data.high * multiplier;
  const low = data.low * multiplier;
  const open = data.open * multiplier;
  const yestclose = data.yestclose * multiplier;
  const icon = getIcon(data.changePercent);
  const lines = [
    `${data.name}（${data.code}）`,
    `---`,
  ];

  if (data.delayed) {
    lines.push('🟡 D 延迟行情（通常至少延迟约 15 分钟）');
  }

  if (data.stale) {
    lines.push('⚠️ 行情暂时无法刷新，当前显示最近一次成功数据');
  }

  if (data.usingPreviousClose) {
    lines.push('⏸ 暂无有效最新价（可能尚未开市或停牌），当前按昨收显示');
  }

  if (data.marketState && data.marketState !== 'REGULAR') {
    const stateLabel = data.marketState === 'PRE' ? '盘前' : data.marketState === 'POST' ? '盘后' : '夜盘';
    lines.push(`阶段\t${stateLabel}`);
    lines.push(`现价\t${icon} ${formatPrice(price, precision)}`);
    lines.push(`涨跌\t${formatChange(change)}  (${formatPercent(data.changePercent)})`);
    lines.push(`昨收\t${formatPrice(yestclose, precision)}`);
  } else {
    lines.push(`现价\t${icon} ${formatPrice(price, precision)}`);
    lines.push(`涨跌\t${formatChange(change)}  (${formatPercent(data.changePercent)})`);
    lines.push(`今开\t${formatPrice(open, precision)}`);
    lines.push(`昨收\t${formatPrice(yestclose, precision)}`);
    lines.push(`最高\t${formatPrice(high, precision)}`);
    lines.push(`最低\t${formatPrice(low, precision)}`);
  }

  lines.push(`时间\t${formatCstTime(data.time)}`);

  // ETF 溢价率（需配置 premiumCodes 从交易所获取 IOPV）
  if (data.iopv && data.iopv > 0) {
    const premium = ((data.price - data.iopv) / data.iopv) * 100;
    const premiumIcon = premium > 0 ? '📈' : premium < 0 ? '📉' : '➡️';
    lines.push(`溢价\t${premiumIcon} ${formatPercent(premium)}`);
    lines.push(`IOPV\t${formatPrice(data.iopv * multiplier, precision)}`);
  }

  return lines.join('\n');
}
