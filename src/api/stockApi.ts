import { StockData, MarketState } from '../types';
import { smartGetText, smartGetJson } from './directHttp';

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
const TENCENT_PREFIXES = ['sh', 'sz', 'bj', 'hk'];

// ============================================================
// 数据源 2: 新浪财经美股行情 API (hq.sinajs.cn) — HTTP
// 适用于: 美股(usr_) — 全时段覆盖（盘前/盘中/盘后）
//
// 请求: GET http://hq.sinajs.cn/list=usr_nvda,usr_aapl
// 响应: var hq_str_usr_nvda="name,price,..."
//       GBK 编码，逗号分隔
//
// 关键字段索引（逗号分隔）:
//   1  - 当前价格
//   2  - 涨跌幅(%)
//   4  - 涨跌额
//   5  - 今开
//   6  - 最高
//   7  - 最低
//   21 - 盘前/盘后最新价
//   22 - 盘前/盘后涨跌幅(%)
//   23 - 盘前/盘后涨跌额
//   24 - 美东时间（字符串）
//   26 - 昨日收盘价
//   35 - 前一日收盘价（盘前时段使用）
// ============================================================

/** 美股支持的股票前缀 */
const USR_PREFIXES = ['usr_'];

/** 新浪美股行情正则：var hq_str_usr_nvda="..." */
const SINA_US_RE = /var hq_str_usr_([a-z0-9]+)="([^"]*)";/g;

/**
 * 从新浪财经获取美股行情（全时段覆盖：盘前/盘中/盘后）
 * 使用 HTTPS 协议，公司网络通常可用
 */
async function fetchFromSinaUs(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  try {
    // 新浪 usr_ 前缀: NVDA → usr_nvda
    const symbolList = symbols.map(s => `usr_${s.toLowerCase()}`).join(',');
    const { text } = await smartGetText('hq.sinajs.cn', `/list=${symbolList}`, {
      useTls: false, // 公司网络封锁新浪 HTTPS 但放行 HTTP
      timeoutMs: 10000,
      encoding: 'gbk',
      headers: {
        'Referer': 'http://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    let match: RegExpExecArray | null;
    while ((match = SINA_US_RE.exec(text)) !== null) {
      const symbol = match[1];
      const fields = match[2].split(',');
      const data = parseSinaUsFields(symbol, fields);
      if (data) result.set(symbol, data);
    }
  } catch (err) {
    console.error(`[StockBar] 新浪美股行情请求失败:`, err);
  }

  return result;
}

/** 判断美东当前交易时段 */
function getEtSession(): MarketState {
  // 获取美东当前时间（America/New_York）
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = et.getHours();
  const min = et.getMinutes();
  const timeNum = hour * 100 + min;

  // 美东时段:
  //   PRE:       4:00 -  9:30
  //   REGULAR:   9:30 - 16:00
  //   POST:     16:00 - 20:00
  //   OVERNIGHT:20:00 -  4:00 (次日凌晨)
  if (timeNum >= 400 && timeNum < 930) return 'PRE';
  if (timeNum >= 930 && timeNum < 1600) return 'REGULAR';
  if (timeNum >= 1600 && timeNum < 2000) return 'POST';
  return 'OVERNIGHT';
}

/**
 * 解析新浪美股返回的字段（逗号分隔、GBK 编码）
 * 包含盘前/盘中/盘后时段判断
 */
function parseSinaUsFields(symbol: string, fields: string[]): StockData | null {
  if (fields.length < 36) return null;
  if (!fields[0] || fields[1] === '' || fields[1] === '-') return null;

  const name = symbol.toUpperCase();
  const regularPrice = parseFloat(fields[1]);
  if (isNaN(regularPrice)) return null;

  const yestclose = parseFloat(fields[26]) || regularPrice;
  const prevClose = parseFloat(fields[35]) || yestclose; // 盘前时段的昨收
  const afterPrice = parseFloat(fields[21]); // 盘前/盘后价格
  const afterChange = parseFloat(fields[23]);
  const afterChangePercent = parseFloat(fields[22]);

  // 根据美东时段选择价格来源
  const session = getEtSession();
  let price: number, change: number, changePercent: number;
  let effectiveYestclose: number;

  if (session === 'REGULAR') {
    // 盘中：用实时价格
    price = regularPrice;
    change = parseFloat(fields[4]);
    changePercent = parseFloat(fields[2]);
    effectiveYestclose = yestclose;
  } else if (session === 'PRE' && !isNaN(afterPrice)) {
    // 盘前：用盘前价格，昨收用前一日收盘价
    price = afterPrice;
    change = !isNaN(afterChange) ? afterChange : price - prevClose;
    changePercent = !isNaN(afterChangePercent) ? afterChangePercent : 0;
    effectiveYestclose = prevClose;
  } else if (session === 'POST' && !isNaN(afterPrice)) {
    // 盘后：用盘后价格，昨收用当日收盘价
    price = afterPrice;
    change = !isNaN(afterChange) ? afterChange : price - yestclose;
    changePercent = !isNaN(afterChangePercent) ? afterChangePercent : 0;
    effectiveYestclose = regularPrice;
  } else if (session === 'OVERNIGHT' && !isNaN(afterPrice)) {
    // 夜盘：用盘后/夜盘价格
    price = afterPrice;
    change = !isNaN(afterChange) ? afterChange : price - yestclose;
    changePercent = !isNaN(afterChangePercent) ? afterChangePercent : 0;
    effectiveYestclose = yestclose;
  } else {
    // 兜底：用盘中价格
    price = regularPrice;
    change = price - yestclose;
    changePercent = yestclose > 0 ? ((price - yestclose) / yestclose) * 100 : 0;
    effectiveYestclose = yestclose;
  }

  const high = parseFloat(fields[6]) || price;
  const low = parseFloat(fields[7]) || price;
  const open = parseFloat(fields[5]) || effectiveYestclose;

  // 处理 NaN
  const safeChange = isNaN(change) ? price - effectiveYestclose : change;
  const safeChangePercent =
    isNaN(changePercent) && effectiveYestclose > 0
      ? ((price - effectiveYestclose) / effectiveYestclose) * 100
      : changePercent;

  return {
    code: symbol.toLowerCase(),
    name,
    price,
    change: safeChange,
    changePercent: typeof safeChangePercent === 'number' ? parseFloat(safeChangePercent.toFixed(2)) : 0,
    high,
    low,
    open,
    yestclose: effectiveYestclose,
    time: fields[24] || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    marketState: session,
  };
}

// ============================================================
// 数据源 3: Binance data-api (data-api.binance.vision)
// 适用于: 加密货币(BTC-USD/BTCUSDT) 和 美股代币(MUBUSDT/NVDABUSDT)
//
// 请求: GET /api/v3/ticker/price?symbol=BTCUSDT
// 响应: {"symbol":"BTCUSDT","price":"63457.75"}
//
// 请求: GET /api/v3/ticker/24hr?symbols=["BTCUSDT","BNBUSDT"]
// 响应: [{symbol, lastPrice, priceChange, priceChangePercent, highPrice, lowPrice}]
// ============================================================


/**
 * 从交易对中提取基础货币名用于显示
 * BTCUSDT → BTC,  BTC-USD → BTC,  MUBUSDT → MU,  NVDABUSDT → NVDA
 */
function extractBaseCurrency(symbol: string): string {
  const upper = symbol.toUpperCase();
  // 去掉常见的报价货币后缀
  for (const quote of ['USDT', 'BUSD', 'USD', 'USDC']) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return upper.slice(0, -quote.length);
    }
  }
  // 去掉 - （如 BTC-USD → BTCUSD → BTC）
  return upper.replace(/-/g, '').replace(/USDT|BUSD|USD.*$/, '');
}

/**
 * 将常见代码格式转为 Binance 交易对
 * BTC-USD → BTCUSDT,  BTCUSDT → BTCUSDT,  BTC/USDT → BTCUSDT,  crypto:BTCUSDT → BTCUSDT
 */
function toBinanceSymbol(code: string): string {
  // crypto:BTCUSDT → BTCUSDT
  if (code.startsWith('crypto:')) {
    const sym = code.substring(7);
    if (!sym.endsWith('USDT') && !sym.endsWith('BUSD')) return sym + 'USDT';
    return sym;
  }
  // BTC/USDT → BTCUSDT
  let upper = code.toUpperCase().replace(/[/\\]/g, '');
  // BTC-USD → BTCUSDT
  upper = upper.replace(/-/g, '');
  if (upper.endsWith('USD') && !upper.endsWith('USDT')) return upper + 'T';
  return upper;
}

/**
 * 从 Binance data-api 获取行情
 * 一次性批量查询所有交易对
 */
async function fetchFromBinance(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  // 转为 Binance 交易对格式
  const binancePairs = symbols.map(s => toBinanceSymbol(s));

  try {
    // 批量查询 24hr ticker
    const symbolsParam = JSON.stringify(binancePairs);
    const resp = await smartGetJson<Array<{
      symbol: string;
      lastPrice: string;
      priceChange: string;
      priceChangePercent: string;
      highPrice: string;
      lowPrice: string;
      volume: string;
    }>>('data-api.binance.vision', `/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`, {
      useTls: true,
      timeoutMs: 10000,
      headers: { 'Accept': 'application/json' },
    });

    const tickers = resp.data;
    if (!Array.isArray(tickers)) {
      console.warn(`[StockBar] Binance 返回格式异常`);
      return result;
    }

    for (const ticker of tickers) {
      const price = parseFloat(ticker.lastPrice);
      if (isNaN(price)) continue;

      const priceChange = parseFloat(ticker.priceChange);
      const priceChangePercent = parseFloat(ticker.priceChangePercent);
      const high = parseFloat(ticker.highPrice) || price;
      const low = parseFloat(ticker.lowPrice) || price;
      const yestclose = price - (isNaN(priceChange) ? 0 : priceChange);
      const changePercent = isNaN(priceChangePercent) ? 0 : priceChangePercent;

      // 用原始配置代码作为 key（由调用方映射）
      const sym = ticker.symbol;
      result.set(sym, {
        code: sym,
        name: extractBaseCurrency(sym), // BTCUSDT → BTC, MUBUSDT → MU
        price,
        change: isNaN(priceChange) ? 0 : priceChange,
        changePercent,
        high,
        low,
        open: yestclose,
        yestclose: yestclose > 0 ? yestclose : price,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        marketState: 'REGULAR',
      });
    }
  } catch (err) {
    console.error(`[StockBar] Binance 行情请求失败:`, err);
  }

  return result;
}

// ============================================================
// 路由 & 主入口
// ============================================================

/**
 * 批量获取股票行情
 * 自动根据代码前缀选择数据源
 *
 * - sh/sz/bj/hk → 腾讯 API
 * - usr_ → 新浪 HTTPS（含盘前/盘后/夜盘）
 * - 其他（crypto:/USDT/BUSD 等）→ Binance data-api
 *
 * @param codes 股票代码数组
 * @returns Map<code, StockData>
 */
export async function fetchStocks(codes: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (codes.length === 0) return result;

  // 按数据源分组
  const tencentCodes: string[] = [];
  const sinaUsCodes: string[] = [];
  const binanceCodes: string[] = [];
  const origToResult = new Map<string, string>(); // 原始代码 → 结果 key

  for (const code of codes) {
    if (TENCENT_PREFIXES.some(p => code.startsWith(p))) {
      tencentCodes.push(code);
    } else if (USR_PREFIXES.some(p => code.startsWith(p))) {
      // usr_nvda → nvda（新浪接口使用 usr_nvda）
      const sinaSym = code.substring(4);
      sinaUsCodes.push(sinaSym);
      origToResult.set(sinaSym.toLowerCase(), code);
    } else {
      // 无前缀代码（BTC-USD、BTCUSDT、MUBUSDT 等）→ Binance
      binanceCodes.push(code);
    }
  }

  // A股/港股：腾讯行情
  const tencentResult = await fetchFromTencent(tencentCodes);
  for (const [code, data] of tencentResult) result.set(code, data);

  // 美股：新浪 HTTPS
  const sinaResult = await fetchFromSinaUs(sinaUsCodes);
  for (const [sym, data] of sinaResult) {
    const originalCode = origToResult.get(sym.toLowerCase());
    if (originalCode) {
      data.code = originalCode;
      result.set(originalCode, data);
    } else {
      result.set(`usr_${sym.toLowerCase()}`, data);
    }
  }

  // 加密货币/美股代币：Binance data-api
  const binanceResult = await fetchFromBinance(binanceCodes);
  for (const [sym, data] of binanceResult) {
    // 将 Binance 返回的 BTCUSDT 映射回用户配置的代码
    // 输入 BTC-USD → toBinanceSymbol → BTCUSDT → 结果 key 是 BTCUSDT
    // 查找原始代码：匹配 binanceCodes 中对应项
    const originalCode = binanceCodes.find(c => toBinanceSymbol(c) === sym);
    if (originalCode) {
      data.code = originalCode;
      result.set(originalCode, data);
    } else {
      result.set(sym, data);
    }
  }

  return result;
}

// ============================================================
// 腾讯行情（不变）
// ============================================================

/**
 * 从腾讯 API 获取行情
 */
async function fetchFromTencent(codes: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (codes.length === 0) return result;

  try {
    const path = '/q=' + codes.join(',');
    const { text } = await smartGetText('qt.gtimg.cn', path, {
      useTls: true,
      encoding: 'gbk',
      timeoutMs: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
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
