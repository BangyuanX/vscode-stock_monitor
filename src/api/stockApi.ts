import { StockData, MarketState } from '../types';
import { smartGetText, smartGetJson } from './directHttp';

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

/** 新浪支持的股票前缀 */
const SINA_PREFIXES = ['sh', 'sz', 'bj', 'hk', 'usr_', 'fx_'];

/** 美股前缀 */
const USR_PREFIX = 'usr_';

/**
 * 从新浪财经获取行情（A股/港股/美股，一次请求全部获取）
 */
async function fetchFromSina(codes: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (codes.length === 0) return result;

  try {
    // 所有代码直接拼接，新浪自动识别前缀
    const symbolList = codes.join(',');
    const { text } = await smartGetText('hq.sinajs.cn', `/list=${symbolList}`, {
      useTls: true,
      timeoutMs: 10000,
      encoding: 'gbk',
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
      } else {
        // A股/港股：sh000001 / sz000001 / hk00700
        data = parseSinaCnFields(code, fields);
      }
      if (data) result.set(code, data);
    }
  } catch (err) {
    console.error(`[StockBar] 新浪行情请求失败:`, err);
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
 * 解析新浪 A股/港股 返回字段
 */
function parseSinaCnFields(code: string, fields: string[]): StockData | null {
  if (fields.length < 33) return null;
  if (!fields[0] || fields[3] === '' || fields[3] === '-') return null;

  const name = fields[0] || code;
  const price = parseFloat(fields[3]);
  const yestclose = parseFloat(fields[2]);
  if (isNaN(price) || isNaN(yestclose)) return null;

  const open = parseFloat(fields[1]) || yestclose;
  const high = parseFloat(fields[4]) || price;
  const low = parseFloat(fields[5]) || price;
  const change = price - yestclose;
  const changePercent = yestclose > 0 ? (change / yestclose) * 100 : 0;

  // 时间：fields[30]=日期 fields[31]=时间
  const time = fields[30] && fields[31] ? `${fields[30]} ${fields[31]}` : '';

  return {
    code,
    name,
    price,
    change,
    changePercent: parseFloat(changePercent.toFixed(2)),
    high,
    low,
    open,
    yestclose,
    time,
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
  if (fields.length < 10) return null;
  const price = parseFloat(fields[1]);
  if (isNaN(price)) return null;

  const name = fields[8] || code;
  const yestclose = parseFloat(fields[7]) || price;
  const change = parseFloat(fields[10]);
  const changePercent = parseFloat(fields[9]);
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
 * BTC-USD → BTCUSDT,  BTC/USDT → BTCUSDT,  crypto:BTCUSDT → BTCUSDT
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

/**
 * 从 Binance data-api 获取行情
 */
async function fetchFromBinance(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  const binancePairs = symbols.map(s => toBinanceSymbol(s));

  try {
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

      const sym = ticker.symbol;
      result.set(sym, {
        code: sym,
        name: extractBaseCurrency(sym),
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
 * - sh/sz/bj/hk/usr_ → 新浪 HTTPS（统一数据源）
 * - 其他（BTC-USD、MUBUSDT 等）→ Binance data-api
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
    if (SINA_PREFIXES.some(p => code.startsWith(p))) {
      sinaCodes.push(code);
    } else {
      // 无前缀代码（BTC-USD、BTCUSDT、MUBUSDT 等）→ Binance
      binanceCodes.push(code);
    }
  }

  // 所有传统股票：新浪 HTTPS（一次请求）
  const sinaResult = await fetchFromSina(sinaCodes);
  for (const [code, data] of sinaResult) result.set(code, data);

  // 加密货币/美股代币：Binance data-api
  const binanceResult = await fetchFromBinance(binanceCodes);
  for (const [sym, data] of binanceResult) {
    const originalCode = binanceCodes.find(c => toBinanceSymbol(c) === sym);
    if (originalCode) {
      data.code = originalCode;
      result.set(originalCode, data);
    } else {
      result.set(sym, data);
    }
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
