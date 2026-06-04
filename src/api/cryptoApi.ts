import { StockData } from '../types';
import { smartGetJson } from './directHttp';

/**
 * OKX 公开行情 API
 *
 * 使用原始 TLS 套接字直接请求，避免 VSCode 扩展宿主的代理拦截。
 * GET https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT
 */

const OKX_API_HOST = 'www.okx.com';

/** 并行请求限制 */
const MAX_CONCURRENCY = 5;

/**
 * 批量获取加密货币 24hr 行情
 * @param symbols 交易对符号数组，如 ['BTCUSDT', 'ETHUSDT']
 */
export async function fetchCryptos(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  // 分块并行请求，避免 socket 耗尽
  const chunks = chunkArray(symbols, MAX_CONCURRENCY);

  for (const chunk of chunks) {
    const promises = chunk.map(symbol => fetchSingle(symbol));
    const responses = await Promise.allSettled(promises);

    for (let i = 0; i < chunk.length; i++) {
      const res = responses[i];
      const symbol = chunk[i];

      if (res.status === 'rejected') {
        console.warn(`[StockBar] OKX ${symbol}: ${res.reason?.message}`);
        continue;
      }

      const data = res.value;
      if (data) result.set(symbol, data);
    }
  }

  return result;
}

/** 获取单个品种 */
async function fetchSingle(symbol: string): Promise<StockData | null> {
  try {
    // OKX 使用 BTC-USDT 格式（短横线分隔）
    const okxSymbol = symbol.replace(/(USDT|USDC|BUSD|FDUSD|DAI|TUSD)$/, '-$1');
    const { data: json } = await smartGetJson(OKX_API_HOST,`/api/v5/market/ticker?instId=${okxSymbol}`);

    if (json.code !== '0') {
      console.warn(`[StockBar] OKX ${symbol}: ${json.msg || 'err'}`);
      return null;
    }

    const ticker = json.data?.[0];
    if (!ticker) {
      console.warn(`[StockBar] OKX ${symbol}: 无数据`);
      return null;
    }

    const price = parseFloat(ticker.last);
    const prevPrice = parseFloat(ticker.open24h);

    if (isNaN(price) || isNaN(prevPrice)) {
      console.warn(`[StockBar] OKX ${symbol}: 价格异常`);
      return null;
    }

    const change = price - prevPrice;
    const changePercent = prevPrice !== 0
      ? parseFloat(((price - prevPrice) / prevPrice * 100).toFixed(2))
      : 0;

    return {
      code: `crypto:${symbol}`,
      name: symbolToName(symbol),
      price,
      change,
      changePercent,
      high: parseFloat(ticker.high24h) || price,
      low: parseFloat(ticker.low24h) || price,
      open: prevPrice,
      yestclose: prevPrice,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
    };
  } catch (err: any) {
    console.warn(`[StockBar] OKX ${symbol}: 请求失败: ${err.message}`);
    return null;
  }
}

/** 交易对符号 → 可读名称 */
function symbolToName(symbol: string): string {
  for (const qc of ['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD']) {
    if (symbol.endsWith(qc) && symbol.length > qc.length) {
      return symbol.substring(0, symbol.length - qc.length) + '/' + qc;
    }
  }
  return symbol;
}

/** 数组分块 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
