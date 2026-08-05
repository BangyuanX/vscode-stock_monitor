import { StockData, MarketState } from '../types';
import { isSinaCode } from '../market';
import { smartGetText, smartGetJson } from './directHttp';
import { parseSinaCnFields } from './sinaCn';

const SINA_BATCH_SIZE = 20;
const SINA_BATCH_CONCURRENCY = 2;
const BINANCE_BATCH_SIZE = 20;
const BINANCE_KLINE_CONCURRENCY = 5;
const BINANCE_KLINE_CACHE_MS = 60_000;
const BINANCE_TICKER_STALE_MS = 10 * 60_000;

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

// ============================================================
// 数据源 1: 新浪财经行情 API (hq.sinajs.cn) — HTTPS
// 适用于: A股(sh/sz/bj)、港股(hk)、美股(usr_)、外汇(fx_)
//
// 请求: GET https://hq.sinajs.cn/list=sh000001,usr_nvda,fx_susdcny
// 响应: var hq_str_sh000001="..."; var hq_str_fx_susdcny="...";
//       GBK 编码，逗号分隔
//
// A股关键字段索引（逗号分隔）:
//   0  - 名称
//   1  - 今开
//   2  - 昨收
//   3  - 最新价
//   4  - 最高
//   5  - 最低
//   8  - 成交量（手）
//   9  - 成交额（万）
//   30 - 日期
//   31 - 时间
//
// 美股关键字段索引（逗号分隔）:
//   1  - 当前价格
//   2  - 涨跌幅(%)
//   4  - 涨跌额
//   5  - 今开
//   6  - 最高
//   7  - 最低
//   21 - 盘前/盘后最新价
//   22 - 盘前/盘后涨跌幅(%)
//   23 - 盘前/盘后涨跌额
//   24 - 美东时间
//   26 - 昨日收盘价
//   35 - 前一日收盘价（盘前时段使用）
// ============================================================

// 外汇关键字段索引（逗号分隔）:
//   0  - 时间
//   1  - 买入价
//   2  - 卖出价
//   3  - 今开
//   4  - 成交量
//   5  - 最高
//   6  - 最低(?) 注：实际为前日收盘
//   7  - 前日收盘
//   8  - 名称
//   9  - 涨跌幅(%)
//   10 - 涨跌额
//   17 - 日期
// ============================================================

/** 新浪行情正则：var hq_str_sh000001="..." / var hq_str_usr_nvda="..." */
const SINA_ALL_RE = /var hq_str_([a-z0-9_]+)="([^"]*)";/g;

/** 美股前缀 */
const USR_PREFIX = 'usr_';

/**
 * 从新浪财经获取行情（A股/港股/美股，一次请求全部获取）
 */
async function fetchSinaBatch(codes: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (codes.length === 0) return result;

  try {
    // 所有代码直接拼接，新浪自动识别前缀
    const symbolList = codes.join(',');
    const { text } = await smartGetText('hq.sinajs.cn', `/list=${symbolList}`, {
      useTls: true,
      timeoutMs: 30000, // 新浪服务器响应较慢（实测 17-26s），需更大超时
      encoding: 'gbk',
      resolveDns: true, // 预解析 DNS 到 IP，绕过部分网络环境对 hostname 的干扰
      headers: {
        'Referer': 'http://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    let match: RegExpExecArray | null;
    while ((match = SINA_ALL_RE.exec(text)) !== null) {
      const code = match[1];
      const fields = match[2].split(',');

      let data: StockData | null = null;
      if (code.startsWith(USR_PREFIX)) {
        // 美股：usr_nvda
        data = parseSinaUsFields(code, fields);
      } else if (code.startsWith('fx_')) {
        // 外汇：fx_susdcny / fx_sjpycnh
        data = parseSinaForexFields(code, fields);
      } else if (code.startsWith('hk')) {
        // 港股：hk00700 / hk02513
        data = parseSinaHkFields(code, fields);
      } else {
        // A股：sh000001 / sz000001 / bj830799
        data = parseSinaCnFields(code, fields);
      }
      if (data) result.set(code, data);
    }
  } catch (err) {
    console.error(`[StockBar] 新浪行情请求失败:`, err);
  }

  return result;
}

/** 分批获取新浪行情，单批失败不会影响其他批次 */
async function fetchFromSina(codes: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  const batches = chunkArray(codes, SINA_BATCH_SIZE);
  const batchResults = await mapWithConcurrency(
    batches,
    SINA_BATCH_CONCURRENCY,
    batch => fetchSinaBatch(batch),
  );
  for (const batchResult of batchResults) {
    for (const [code, data] of batchResult) result.set(code, data);
  }
  return result;
}

/**
 * 判断美东当前交易时段
 */
function getEtSession(): MarketState {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const timeNum = et.getHours() * 100 + et.getMinutes();

  // PRE: 4:00-9:30 / REGULAR: 9:30-16:00 / POST: 16:00-20:00 / OVERNIGHT: 20:00-4:00
  if (timeNum >= 400 && timeNum < 930) return 'PRE';
  if (timeNum >= 930 && timeNum < 1600) return 'REGULAR';
  if (timeNum >= 1600 && timeNum < 2000) return 'POST';
  return 'OVERNIGHT';
}

/**
 * 解析新浪港股返回字段。
 *
 * 0=英文简称 1=中文名称 2=今开 3=昨收 4=最高 5=最低
 * 6=最新价 7=涨跌额 8=涨跌幅 17=日期 18=时间
 */
export function parseSinaHkFields(code: string, fields: string[]): StockData | null {
  if (fields.length < 19) return null;
  const price = parseFloat(fields[6]);
  const yestclose = parseFloat(fields[3]);
  if (isNaN(price) || isNaN(yestclose)) return null;

  const calculatedChange = price - yestclose;
  const parsedChange = parseFloat(fields[7]);
  const parsedChangePercent = parseFloat(fields[8]);
  const change = isNaN(parsedChange) ? calculatedChange : parsedChange;
  const changePercent = isNaN(parsedChangePercent)
    ? (yestclose > 0 ? (calculatedChange / yestclose) * 100 : 0)
    : parsedChangePercent;
  const date = fields[17]?.replace(/\//g, '-');

  return {
    code,
    name: fields[1] || fields[0] || code,
    price,
    change,
    changePercent: parseFloat(changePercent.toFixed(2)),
    high: parseFloat(fields[4]) || price,
    low: parseFloat(fields[5]) || price,
    open: parseFloat(fields[2]) || yestclose,
    yestclose,
    time: date && fields[18] ? `${date} ${fields[18]}` : (fields[18] || ''),
    delayed: true,
  };
}

/**
 * 解析新浪美股返回的字段，包含盘前/盘中/盘后时段判断
 */
function parseSinaUsFields(code: string, fields: string[]): StockData | null {
  if (fields.length < 36) return null;
  if (!fields[0] || fields[1] === '' || fields[1] === '-') return null;

  // 取 code 去掉 usr_ 前缀作为显示名
  const symbol = code.startsWith(USR_PREFIX) ? code.substring(4) : code;
  const name = symbol.toUpperCase();
  const regularPrice = parseFloat(fields[1]);
  if (isNaN(regularPrice)) return null;

  const yestclose = parseFloat(fields[26]) || regularPrice;
  const prevClose = parseFloat(fields[35]) || yestclose;
  const afterPrice = parseFloat(fields[21]);
  const afterChange = parseFloat(fields[23]);
  const afterChangePercent = parseFloat(fields[22]);

  const session = getEtSession();
  let price: number, change: number, changePercent: number;
  let effectiveYestclose: number;

  if (session === 'REGULAR') {
    price = regularPrice;
    change = parseFloat(fields[4]);
    changePercent = parseFloat(fields[2]);
    effectiveYestclose = yestclose;
  } else if (session === 'PRE' && !isNaN(afterPrice)) {
    price = afterPrice;
    change = !isNaN(afterChange) ? afterChange : price - prevClose;
    changePercent = !isNaN(afterChangePercent) ? afterChangePercent : 0;
    effectiveYestclose = prevClose;
  } else if (session === 'POST' && !isNaN(afterPrice)) {
    price = afterPrice;
    change = !isNaN(afterChange) ? afterChange : price - yestclose;
    changePercent = !isNaN(afterChangePercent) ? afterChangePercent : 0;
    effectiveYestclose = regularPrice;
  } else if (session === 'OVERNIGHT' && !isNaN(afterPrice)) {
    price = afterPrice;
    change = !isNaN(afterChange) ? afterChange : price - yestclose;
    changePercent = !isNaN(afterChangePercent) ? afterChangePercent : 0;
    effectiveYestclose = yestclose;
  } else {
    price = regularPrice;
    change = price - yestclose;
    changePercent = yestclose > 0 ? ((price - yestclose) / yestclose) * 100 : 0;
    effectiveYestclose = yestclose;
  }

  const high = parseFloat(fields[6]) || price;
  const low = parseFloat(fields[7]) || price;
  const open = parseFloat(fields[5]) || effectiveYestclose;

  const safeChange = isNaN(change) ? price - effectiveYestclose : change;
  const safeChangePercent =
    isNaN(changePercent) && effectiveYestclose > 0
      ? ((price - effectiveYestclose) / effectiveYestclose) * 100
      : changePercent;

  return {
    code, // 保留原始代码（如 usr_mrvl），与 precision 配置 key 一致
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

/**
 * 解析新浪外汇返回的字段
 */
function parseSinaForexFields(code: string, fields: string[]): StockData | null {
  if (fields.length < 12) return null;
  const price = parseFloat(fields[1]);
  if (isNaN(price)) return null;

  // 新浪外汇字段：0=时间 1=买入价 2=卖出价 3=今开 4=成交量
  // 5=最高 6=最低 7=昨收 8=前日收盘 9=名称 10=涨跌幅 11=涨跌额
  const name = fields[9] || code;
  const yestclose = parseFloat(fields[7]) || price;
  const change = parseFloat(fields[11]);
  const changePercent = parseFloat(fields[10]);
  const high = parseFloat(fields[5]) || price;
  const low = parseFloat(fields[6]) || price;
  const open = parseFloat(fields[3]) || yestclose;
  const time = fields[17] && fields[0] ? `${fields[17]} ${fields[0]}` : (fields[0] || '');

  return {
    code,
    name,
    price,
    change: isNaN(change) ? price - yestclose : change,
    changePercent: isNaN(changePercent) ? 0 : changePercent,
    high,
    low,
    open,
    yestclose: yestclose > 0 ? yestclose : price,
    time,
  };
}

// ============================================================
// 数据源 2: Binance data-api (data-api.binance.vision)
// 适用于: 加密货币(BTC-USD/BTCUSDT) 和 美股代币(MUBUSDT/NVDABUSDT)
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
  for (const quote of ['USDT', 'BUSD', 'USD', 'USDC']) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return upper.slice(0, -quote.length);
    }
  }
  return upper.replace(/-/g, '').replace(/USDT|BUSD|USD.*$/, '');
}

/**
 * 将常见代码格式转为 Binance 交易对
 * BTC/USDT → BTCUSDT（推荐格式）
 * BTC-USD → BTCUSDT（兼容）
 * crypto:BTCUSDT → BTCUSDT（兼容旧配置）
 */
function toBinanceSymbol(code: string): string {
  if (code.startsWith('crypto:')) {
    const sym = code.substring(7);
    if (!sym.endsWith('USDT') && !sym.endsWith('BUSD')) return sym + 'USDT';
    return sym;
  }
  let upper = code.toUpperCase().replace(/[/\\]/g, '').replace(/-/g, '');
  if (upper.endsWith('USD') && !upper.endsWith('USDT')) return upper + 'T';
  return upper;
}

interface BinanceDailyKline {
  open: number;
  high: number;
  low: number;
  close: number;
}

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  closeTime?: number;
}

const binanceKlineCache = new Map<string, {
  data: BinanceDailyKline;
  expiresAt: number;
}>();

const binanceTickerCache = new Map<string, {
  data: StockData;
  cachedAt: number;
}>();

function formatCstDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/\//g, '-');
}

/**
 * 从 Binance 获取日K线开盘价（东八区 8:00 / UTC 00:00 基准）
 * 用于替代 24hr 滚动窗口计算当日涨跌
 *
 * klines 返回: [openTime, open, high, low, close, volume, ...]
 * interval=1d 每根K线从 UTC 00:00 开始，对应东八区 08:00
 */
async function fetchBinanceDailyKlines(symbols: string[]): Promise<Map<string, BinanceDailyKline>> {
  const result = new Map<string, BinanceDailyKline>();
  if (symbols.length === 0) return result;

  const now = Date.now();
  const symbolsToFetch: string[] = [];
  for (const sym of new Set(symbols)) {
    const cached = binanceKlineCache.get(sym);
    if (cached && cached.expiresAt > now) {
      result.set(sym, cached.data);
    } else {
      symbolsToFetch.push(sym);
    }
  }

  await mapWithConcurrency(symbolsToFetch, BINANCE_KLINE_CONCURRENCY, async sym => {
    try {
      const resp = await smartGetJson<any[][]>(
        'data-api.binance.vision',
        `/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=1d&limit=1`,
        {
          useTls: true,
          timeoutMs: 10000,
          resolveDns: true,
          headers: { 'Accept': 'application/json' },
        },
      );
      const kline = resp.data?.[0];
      if (kline && kline.length >= 5) {
        const open = parseFloat(kline[1]);
        const high = parseFloat(kline[2]);
        const low = parseFloat(kline[3]);
        const close = parseFloat(kline[4]);
        if (!isNaN(open) && !isNaN(high) && !isNaN(low) && open > 0) {
          const data = { open, high, low, close };
          result.set(sym, data);
          binanceKlineCache.set(sym, {
            data,
            expiresAt: Date.now() + BINANCE_KLINE_CACHE_MS,
          });
        }
      }
    } catch (err) {
      console.warn(`[StockBar] Binance 日K线获取失败 (${sym}):`, err);
      const stale = binanceKlineCache.get(sym);
      if (stale) result.set(sym, stale.data);
    }
  });

  return result;
}

/** 单批获取 Binance 24 小时行情 */
async function fetchBinanceTickerBatch(symbols: string[]): Promise<BinanceTicker[]> {
  try {
    const symbolsParam = JSON.stringify(symbols);
    const resp = await smartGetJson<BinanceTicker[]>(
      'data-api.binance.vision',
      `/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`,
      {
        useTls: true,
        timeoutMs: 10000,
        resolveDns: true,
        headers: { 'Accept': 'application/json' },
      },
    );
    if (Array.isArray(resp.data)) return resp.data;
    console.warn(`[StockBar] Binance 返回格式异常 (${symbols.join(', ')})`);
  } catch (err) {
    console.error(`[StockBar] Binance 行情批次请求失败 (${symbols.join(', ')}):`, err);
  }
  return [];
}

/**
 * 从 Binance data-api 获取行情
 *
 * 涨跌计算以每日东八区 8:00（UTC 00:00）为临界点：
 *   涨跌额 = 当前价 - 当日开盘价
 *   涨跌幅 = 涨跌额 / 当日开盘价 × 100%
 * 获取日K线失败时回退到 Binance 24hr 滚动窗口。
 */
async function fetchFromBinance(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  const binancePairs = Array.from(new Set(symbols.map(s => toBinanceSymbol(s))));

  try {
    const tickerBatches = chunkArray(binancePairs, BINANCE_BATCH_SIZE);
    const batchResults = await Promise.all(tickerBatches.map(fetchBinanceTickerBatch));
    const tickers = batchResults.flat();

    // 获取日K线数据，以东八区 8:00（UTC 00:00）开盘价为涨跌基准
    const dailyKlines = await fetchBinanceDailyKlines(tickers.map(ticker => ticker.symbol));

    for (const ticker of tickers) {
      const price = parseFloat(ticker.lastPrice);
      if (isNaN(price)) continue;

      const sym = ticker.symbol;
      const kline = dailyKlines.get(sym);

      let priceChange: number;
      let priceChangePercent: number;
      let yestclose: number;
      let openPrice: number;
      let high: number;
      let low: number;

      if (kline && kline.open > 0) {
        // 使用日K线开盘价（东八区 8:00）作为当日涨跌基准
        openPrice = kline.open;
        priceChange = price - openPrice;
        priceChangePercent = (priceChange / openPrice) * 100;
        yestclose = openPrice;
        high = !isNaN(kline.high) ? kline.high : (parseFloat(ticker.highPrice) || price);
        low = !isNaN(kline.low) ? kline.low : (parseFloat(ticker.lowPrice) || price);
      } else {
        // 回退到 Binance 24hr 滚动窗口
        const tickerChange = parseFloat(ticker.priceChange);
        const tickerChangePercent = parseFloat(ticker.priceChangePercent);
        const tickerYestclose = price - (isNaN(tickerChange) ? 0 : tickerChange);
        openPrice = tickerYestclose;
        priceChange = isNaN(tickerChange) ? 0 : tickerChange;
        priceChangePercent = isNaN(tickerChangePercent) ? 0 : tickerChangePercent;
        yestclose = tickerYestclose;
        high = parseFloat(ticker.highPrice) || price;
        low = parseFloat(ticker.lowPrice) || price;
      }

      const data: StockData = {
        code: sym,
        name: extractBaseCurrency(sym),
        price,
        change: priceChange,
        changePercent: parseFloat(priceChangePercent.toFixed(2)),
        high,
        low,
        open: openPrice,
        yestclose: yestclose > 0 ? yestclose : price,
        time: formatCstDateTime(
          typeof ticker.closeTime === 'number' && Number.isFinite(ticker.closeTime)
            ? ticker.closeTime
            : Date.now(),
        ),
        marketState: 'REGULAR',
      };
      result.set(sym, data);
      binanceTickerCache.set(sym, { data, cachedAt: Date.now() });
    }

    // Binance/网络短暂抖动时保留最近一次成功行情，避免所有币种同时闪成错误占位。
    const now = Date.now();
    for (const sym of binancePairs) {
      if (result.has(sym)) continue;
      const cached = binanceTickerCache.get(sym);
      if (!cached) continue;
      if (now - cached.cachedAt > BINANCE_TICKER_STALE_MS) {
        binanceTickerCache.delete(sym);
        continue;
      }
      result.set(sym, { ...cached.data, stale: true });
    }
  } catch (err) {
    console.error(`[StockBar] Binance 行情请求失败:`, err);
  }

  return result;
}

// ============================================================
// 数据源 3: 交易所 ETF IOPV
// 深交所: https://www.szse.cn/api/market/ssjjhq/getTimeData?code={code}
// 上交所: TODO（需要对应 API）
// ============================================================

/**
 * 从交易所官方 API 获取 ETF 实时参考净值（IOPV）
 * 仅支持深交所（sz 前缀），返回 netValue 字段
 */
async function fetchIopv(code: string): Promise<number | null> {
  try {
    const numCode = code.replace(/^(sh|sz|bj)/, '');
    // 仅深交所支持
    if (!code.startsWith('sz')) return null;

    const resp = await smartGetText(
      'www.szse.cn',
      `/api/market/ssjjhq/getTimeData?random=${Math.random()}&marketId=1&code=${numCode}`,
      {
        useTls: true,
        timeoutMs: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Referer': 'https://www.szse.cn/market/trend/index.html',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
    );
    const parsed = JSON.parse(resp.text);
    const netValue = parsed?.data?.netValue;
    if (netValue && parseFloat(netValue) > 0) {
      return parseFloat(netValue);
    }
    return null;
  } catch (err) {
    console.log(`[StockBar] IOPV 获取失败 (${code}):`, err);
    return null;
  }
}

// ============================================================
// 路由 & 主入口
// ============================================================

/**
 * 批量获取行情
 *
 * - sh/sz/bj/hk/usr_/fx_ → 新浪 HTTPS（统一数据源）
 * - 其他（BTC/USDT、MUBUSDT 等）→ Binance data-api
 * - premiumCodes 中的代码额外从东财获取 IOPV（溢价率用）
 *
 * @param codes 股票代码数组
 * @param premiumCodes 需要显示溢价率的代码列表
 * @returns Map<code, StockData>
 */
export async function fetchStocks(codes: string[], premiumCodes?: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (codes.length === 0) return result;

  const sinaCodes: string[] = [];
  const binanceCodes: string[] = [];

  for (const code of codes) {
    if (isSinaCode(code)) {
      sinaCodes.push(code);
    } else {
      // 无前缀代码（BTC-USD、BTCUSDT、MUBUSDT 等）→ Binance
      binanceCodes.push(code);
    }
  }

  // 不同数据源并行获取；各数据源内部负责分批和并发限制
  const [sinaResult, binanceResult] = await Promise.all([
    fetchFromSina(sinaCodes),
    fetchFromBinance(binanceCodes),
  ]);

  for (const [code, data] of sinaResult) result.set(code, data);

  // 加密货币/美股代币：Binance data-api
  for (const originalCode of binanceCodes) {
    const data = binanceResult.get(toBinanceSymbol(originalCode));
    if (data) result.set(originalCode, { ...data, code: originalCode });
  }

  // 用户指定的 ETF 溢价率代码：从东方财富获取 IOPV
  if (premiumCodes && premiumCodes.length > 0) {
    for (const code of premiumCodes) {
      const stock = result.get(code);
      if (!stock || stock.error) continue; // 没有行情数据则跳过
      const iopv = await fetchIopv(code);
      if (iopv && iopv > 0) {
        stock.iopv = iopv;
      }
    }
  }

  return result;
}
