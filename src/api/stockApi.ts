import { StockData, MarketState } from '../types';
import { smartGetText, smartGet, smartGetJson } from './directHttp';

// ============================================================
// 数据源 1: 腾讯行情 API (qt.gtimg.cn)
// 适用于: A股(sh/sz/bj)、港股(hk)
//
// 请求: GET http://qt.gtimg.cn/q=sh000001,sz000001,hk00700
// 响应: v_sh000001="field1~field2~..."
//
// 关键字段索引（~ 分隔）:
//   1  - 名称
//   3  - 最新价
//   4  - 昨收
//   5  - 今开
//   30 - 时间
//   31 - 涨跌额
//   32 - 涨跌幅(%)
//   33 - 最高
//   34 - 最低
// ============================================================

const STOCK_LINE_RE = /v_([a-z0-9_]+)="([^"]*)"/g;

// ============================================================
// 数据源 2: 新浪财经美股行情 API (hq.sinajs.cn)
// 适用于: 美股(usr_) — 全时段覆盖（盘前/盘中/盘后/夜盘）
//
// 请求: GET http://hq.sinajs.cn/list=gb_aapl,gb_nvda
// 响应: var hq_str_gb_aapl="name,price,..."
//       GBK 编码，逗号分隔
//
// 关键字段索引（逗号分隔）:
//   0  - 名称
//   1  - 最新价（全时段最成交价，含夜盘）
//   2  - 涨跌幅(%)
//   3  - 行情时间（北京时间）
//   4  - 涨跌额
//   6  - 最高
//   7  - 最低
// ============================================================

/** Tencent 支持的股票前缀 */
const TENCENT_PREFIXES = ['sh', 'sz', 'bj', 'hk'];

/** 美股支持的股票前缀（优先 Yahoo v7，回退新浪） */
const YAHOO_V7_PREFIXES = ['usr_'];
const SINA_PREFIXES = ['usr_'];

/**
 * 批量获取股票行情
 * 自动根据代码前缀选择数据源
 *
 * 美股: 优先 Yahoo v7（含夜盘），失败回退新浪
 *
 * @param codes 股票代码数组
 * @returns Map<code, StockData>
 */
export async function fetchStocks(codes: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (codes.length === 0) return result;

  // 按数据源分组
  const tencentCodes: string[] = [];
  const usSymbols: string[] = [];

  for (const code of codes) {
    if (TENCENT_PREFIXES.some(p => code.startsWith(p))) {
      tencentCodes.push(code);
    } else if (YAHOO_V7_PREFIXES.some(p => code.startsWith(p))) {
      usSymbols.push(code.substring(4)); // usr_aapl → AAPL
    } else {
      // 无前缀代码（如 BTC-USD、ETH-USD）→ 直接作为 Yahoo symbol
      usSymbols.push(code);
    }
  }

  // A股/港股：腾讯行情不变
  const tencentResult = await fetchFromTencent(tencentCodes);
  for (const [code, data] of tencentResult) result.set(code, data);

  // 美股：优先 Yahoo v7（含夜盘数据）
  let v7Result = await fetchFromYahooV7(usSymbols);

  // 如果 Yahoo v7 有缺失的，或者全部为空（可能 cookie 无效），用新浪补
  const v7Fetched = new Set(v7Result.keys());
  const missing = usSymbols.filter(s => !v7Fetched.has(s.toLowerCase()));

  if (missing.length > 0) {
    console.log(`[StockBar] Yahoo v7 缺失 ${missing.length} 个，从新浪补充`);
    const sinaResult = await fetchFromSina(missing);
    for (const [symbol, data] of sinaResult) {
      if (!v7Result.has(symbol)) {
        v7Result.set(symbol, data);
      }
    }
  }

  for (const [symbol, data] of v7Result) {
    result.set(`usr_${symbol.toLowerCase()}`, data);
  }

  return result;
}

/**
 * 从腾讯 API 获取行情
 */
async function fetchFromTencent(codes: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (codes.length === 0) return result;

  try {
    const path = '/q=' + codes.join(',');
    const { text } = await smartGetText('qt.gtimg.cn', path, {
      useTls: false,
      encoding: 'gbk',
      timeoutMs: 10000,
    });

    let match: RegExpExecArray | null;
    while ((match = STOCK_LINE_RE.exec(text)) !== null) {
      const code = match[1];
      const fields = match[2].split('~');
      const data = parseTencentFields(code, fields);
      if (data) result.set(code, data);
    }
  } catch (err) {
    console.error(`[StockBar] 腾讯行情请求失败:`, err);
  }

  return result;
}

/**
 * 解析腾讯 API 返回的字段数组
 */
function parseTencentFields(code: string, fields: string[]): StockData | null {
  if (fields.length < 35) return null;

  // 跳过无效数据（字段为空或全部为 - ）
  if (fields[1] === '' || fields[3] === '' || fields[3] === '-') return null;

  const name = fields[1] || code;
  const price = parseFloat(fields[3]);
  const yestclose = parseFloat(fields[4]);

  if (isNaN(price) || isNaN(yestclose)) return null;

  const open = parseFloat(fields[5]) || 0;
  const change = parseFloat(fields[31]);
  const changePercent = parseFloat(fields[32]);
  const high = parseFloat(fields[33]) || price;
  const low = parseFloat(fields[34]) || price;
  const time = fields[30] || '';

  return {
    code,
    name,
    price,
    change: isNaN(change) ? price - yestclose : change,
    changePercent: isNaN(changePercent) && yestclose > 0
      ? ((price - yestclose) / yestclose) * 100
      : changePercent,
    high,
    low,
    open,
    yestclose,
    time: formatTencentTime(time),
  };
}

/**
 * 从新浪财经获取美股行情（全时段覆盖：盘前/盘中/盘后/夜盘）
 * 支持批量查询，一个 HTTP 请求获取所有股票数据
 */
const SINA_GB_RE = /var hq_str_gb_([a-z0-9]+)="([^"]*)";/g;

async function fetchFromSina(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  try {
    // 新浪 gb_ 前缀: usr_aapl → AAPL → gb_aapl
    const symbolList = symbols.map(s => `gb_${s.toLowerCase()}`).join(',');
    const { text } = await smartGetText('hq.sinajs.cn', `/list=${symbolList}`, {
      useTls: false,
      encoding: 'gbk',
      timeoutMs: 10000,
      headers: { 'Referer': 'http://finance.sina.com.cn' },
    });

    let match: RegExpExecArray | null;
    while ((match = SINA_GB_RE.exec(text)) !== null) {
      const symbol = match[1];
      const fields = match[2].split(',');
      const data = parseSinaFields(symbol, fields);
      if (data) result.set(symbol, data);
    }
  } catch (err) {
    console.error(`[StockBar] 新浪美股行情请求失败:`, err);
  }

  return result;
}

/**
 * 解析新浪美股返回的字段（逗号分隔、GBK 编码）
 */
function parseSinaFields(symbol: string, fields: string[]): StockData | null {
  if (fields.length < 10) return null;
  if (!fields[0] || fields[1] === '' || fields[1] === '-') return null;

  const name = symbol.toUpperCase();
  const price = parseFloat(fields[1]);
  if (isNaN(price)) return null;

  const change = parseFloat(fields[4]);
  const changePercent = parseFloat(fields[2]);
  const yestclose = !isNaN(change) ? price - change : price;

  return {
    code: symbol.toLowerCase(),
    name,
    price,
    change: isNaN(change) ? 0 : change,
    changePercent: isNaN(changePercent) ? 0 : changePercent,
    high: parseFloat(fields[6]) || price,
    low: parseFloat(fields[7]) || price,
    open: yestclose, // 新浪不提供今开价，用昨收替代
    yestclose: yestclose > 0 ? yestclose : price,
    time: fields[3] || '',
    marketState: undefined, // 新浪不含时段信息，由实际价格判断
  };
}

/**
 * ============================================================
 * 数据源 3: Yahoo Finance v7 API (query1.finance.yahoo.com)
 * 适用于: 美股(usr_) — 全时段覆盖（盘前/盘中/盘后/夜盘）
 *
 * 夜盘数据需要通过 crumb + cookie 认证获取。
 * Cookie 有效期约 1 年，获取后缓存复用。
 *
 * 请求: GET /v7/finance/quote?symbols=NVDA&fields=overnightMarketPrice,...
 *         &crumb=xxx&overnightPrice=true
 * 响应: { quoteResponse: { result: [...] } }
 * ============================================================
 */

const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** Yahoo cookie 缓存 */
let yahooCookie: string | null = null;

/**
 * 从 finance.yahoo.com 获取认证 cookie（A1）
 */
async function fetchYahooCookie(): Promise<string | null> {
  try {
    // 必须访问股票详情页才会设置 A1 cookie（首页不设置）
    const resp = await smartGet('finance.yahoo.com', '/quote/AAPL', {
      useTls: true,
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeoutMs: 20000,
    });

    const setCookie = resp.headers?.['set-cookie'];
    if (!setCookie) return null;

    // 提取 A1 cookie（多个 Set-Cookie 以 \n 合并）
    for (const line of setCookie.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('A1=')) {
        const cookie = trimmed.split(';')[0]; // A1=value
        console.log('[StockBar] Yahoo cookie 获取成功');
        return cookie;
      }
    }
  } catch (err) {
    console.error('[StockBar] Yahoo cookie 获取失败:', err);
  }
  return null;
}

/**
 * 用 cookie 获取 crumb
 */
async function fetchYahooCrumb(cookie: string): Promise<string | null> {
  try {
    const { text } = await smartGetText('query2.finance.yahoo.com', '/v1/test/getcrumb', {
      useTls: true,
      headers: { 'Cookie': cookie, 'User-Agent': YAHOO_UA },
    });
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 从 Yahoo v7 获取美股行情（含夜盘）
 * 需要有效 cookie + crumb
 */
const V7_FIELDS = [
  'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent',
  'regularMarketPreviousClose', 'regularMarketDayHigh', 'regularMarketDayLow',
  'preMarketPrice', 'preMarketChange', 'preMarketChangePercent',
  'postMarketPrice', 'postMarketChange', 'postMarketChangePercent',
  'overnightMarketPrice', 'overnightMarketChange', 'overnightMarketChangePercent',
  'marketState', 'shortName', 'currency',
].join(',');

async function fetchFromYahooV7(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  // 获取/复用 cookie
  if (!yahooCookie) {
    yahooCookie = await fetchYahooCookie();
  }
  if (!yahooCookie) return result;

  // 获取 crumb
  const crumb = await fetchYahooCrumb(yahooCookie);
  if (!crumb) return result;

  try {
    const symbolParam = symbols.join(',');
    const path = `/v7/finance/quote?symbols=${symbolParam}&fields=${V7_FIELDS}&crumb=${crumb}&overnightPrice=true&formatted=false&region=US&lang=en-US`;

    const { data } = await smartGetJson('query1.finance.yahoo.com', path, {
      useTls: true,
      headers: { 'Cookie': yahooCookie, 'User-Agent': YAHOO_UA },
    });

    const quoteData = data as YahooV7Response;
    if (quoteData.quoteResponse?.error) {
      console.warn('[StockBar] Yahoo v7 返回错误:', quoteData.quoteResponse.error);
      // Auth 失败，清除 cookie 下次重试
      if (quoteData.quoteResponse.error === 'Invalid Cookie' ||
          String(quoteData.quoteResponse.error).includes('Unauthorized')) {
        yahooCookie = null;
      }
      return result;
    }

    const quotes = quoteData.quoteResponse?.result || [];
    for (const quote of quotes) {
      const parsed = parseYahooV7Response(quote);
      if (parsed) result.set(parsed.code, parsed);
    }
  } catch (err: any) {
    console.error(`[StockBar] Yahoo v7 请求失败:`, err?.message || err);
    // 网络错误，不清除 cookie（可能只是暂时问题）
    if (err?.message?.includes('401') || err?.message?.includes('Unauthorized')) {
      yahooCookie = null;
    }
  }

  return result;
}

interface YahooV7Response {
  quoteResponse: {
    result?: Array<{
      symbol: string;
      shortName?: string;
      marketState?: string;
      regularMarketPrice?: number;
      regularMarketChange?: number;
      regularMarketChangePercent?: number;
      regularMarketPreviousClose?: number;
      regularMarketDayHigh?: number;
      regularMarketDayLow?: number;
      preMarketPrice?: number;
      preMarketChange?: number;
      preMarketChangePercent?: number;
      postMarketPrice?: number;
      postMarketChange?: number;
      postMarketChangePercent?: number;
      overnightMarketPrice?: number;
      overnightMarketChange?: number;
      overnightMarketChangePercent?: number;
      currency?: string;
    }>;
    error?: any;
  };
}

/**
 * 将 Yahoo marketState 映射为我们的 MarketState
 */
function mapMarketState(yahooState?: string): MarketState | undefined {
  switch (yahooState) {
    case 'PRE': return 'PRE';
    case 'REGULAR': return 'REGULAR';
    case 'POST': return 'POST';
    case 'OVERNIGHT': return 'OVERNIGHT';
    default: return undefined;
  }
}

/**
 * 解析 Yahoo v7 quote 响应
 */
function parseYahooV7Response(quote: NonNullable<YahooV7Response['quoteResponse']['result']>[0]): StockData | null {
  const symbol = quote.symbol;
  if (!symbol) return null;

  const regularPrice = quote.regularMarketPrice;
  if (regularPrice == null || isNaN(regularPrice)) return null;

  const marketState = quote.marketState || 'REGULAR';
  const yestclose = quote.regularMarketPreviousClose ?? regularPrice;

  // 根据交易时段选择对应价格
  let price = regularPrice;
  let change = quote.regularMarketChange ?? (price - yestclose);
  let changePercent = quote.regularMarketChangePercent ?? 0;

  if (marketState === 'OVERNIGHT' && quote.overnightMarketPrice != null) {
    price = quote.overnightMarketPrice;
    change = quote.overnightMarketChange ?? (price - yestclose);
    changePercent = quote.overnightMarketChangePercent ?? 0;
  } else if (marketState === 'POST' && quote.postMarketPrice != null) {
    price = quote.postMarketPrice;
    change = quote.postMarketChange ?? (price - yestclose);
    changePercent = quote.postMarketChangePercent ?? 0;
  } else if (marketState === 'PRE' && quote.preMarketPrice != null) {
    price = quote.preMarketPrice;
    change = quote.preMarketChange ?? (price - yestclose);
    changePercent = quote.preMarketChangePercent ?? 0;
  }

  return {
    code: symbol.toLowerCase(),
    name: symbol.toUpperCase(),
    price,
    change,
    changePercent: typeof changePercent === 'number' ? parseFloat(changePercent.toFixed(2)) : 0,
    high: quote.regularMarketDayHigh || price,
    low: quote.regularMarketDayLow || price,
    open: yestclose,
    yestclose,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    marketState: mapMarketState(marketState),
  };
}

/** Sina 美股行情正则——注意：上面已有同名声明，此处移除 */
function formatTencentTime(raw: string): string {
  if (!raw) return '';

  // 已经是标准格式 YYYY-MM-DD 或 YYYY/MM/DD
  if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(raw)) {
    return raw.replace(/[/]/g, '-');
  }

  // 紧凑格式 YYYYMMDDHHMMSS
  if (/^\d{12,14}$/.test(raw)) {
    try {
      return `${raw.substring(0, 4)}-${raw.substring(4, 6)}-${raw.substring(6, 8)} ${raw.substring(8, 10)}:${raw.substring(10, 12)}:${raw.length >= 14 ? raw.substring(12, 14) : '00'}`;
    } catch {
      return raw;
    }
  }

  return raw;
}

