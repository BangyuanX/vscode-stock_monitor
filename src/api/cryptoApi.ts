import * as https from 'https';
import { StockData } from '../types';

/**
 * Bybit 公开行情 API
 *
 * 使用 https 模块直接请求，避免 VSCode 扩展宿主中 fetch 实现的差异。
 * GET https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT
 */

const BYBIT_API_HOST = 'api.bybit.com';

/** 并行请求限制 */
const MAX_CONCURRENCY = 5;

/**
 * 批量获取加密货币 24hr 行情
 * @param symbols 交易对符号数组，如 ['BTCUSDT', 'ETHUSDT']
 */
export async function fetchCryptos(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  // 分批并行请求
  const chunks = chunkArray(symbols, MAX_CONCURRENCY);

  for (const chunk of chunks) {
    const promises = chunk.map(symbol => fetchSingle(symbol));
    const responses = await Promise.allSettled(promises);

    for (let i = 0; i < chunk.length; i++) {
      const res = responses[i];
      const symbol = chunk[i];

      if (res.status === 'rejected') {
        console.warn(`[StockBar] Bybit ${symbol}:`, res.reason?.message);
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
    const json = await httpsGet(`/v5/market/tickers?category=spot&symbol=${symbol}`);
    if (!json) return null;

    if (json.retCode !== 0) {
      console.warn(`[StockBar] Bybit ${symbol}: ${json.retMsg || 'err'}`);
      return null;
    }

    const ticker = json.result?.list?.[0];
    if (!ticker) {
      console.warn(`[StockBar] Bybit ${symbol}: 无数据`);
      return null;
    }

    const price = parseFloat(ticker.lastPrice);
    const prevPrice = parseFloat(ticker.prevPrice24h);

    if (isNaN(price) || isNaN(prevPrice)) {
      console.warn(`[StockBar] Bybit ${symbol}: 价格异常`);
      return null;
    }

    const change = price - prevPrice;
    const changePercent = parseFloat(ticker.price24hPcnt) * 100;

    return {
      code: `crypto:${symbol}`,
      name: symbolToName(symbol),
      price,
      change,
      changePercent: parseFloat(changePercent.toFixed(2)),
      high: parseFloat(ticker.highPrice24h) || price,
      low: parseFloat(ticker.lowPrice24h) || price,
      open: prevPrice,
      yestclose: prevPrice,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
    };
  } catch (err: any) {
    console.warn(`[StockBar] Bybit ${symbol}:`, err.message);
    return null;
  }
}

/**
 * HTTPS GET 请求，返回解析后的 JSON
 */
function httpsGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let rawHex = '';
    const req = https.get(
      {
        hostname: BYBIT_API_HOST,
        path: path,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: 8000,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          rawHex = buf.slice(0, 50).toString('hex');
          const data = buf.toString('utf8');

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`));
            return;
          }

          // 检查是否是 JSON
          const trimmed = data.trim();
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            reject(new Error(`非JSON响应: ${data.substring(0, 100)} (hex: ${rawHex})`));
            return;
          }

          try {
            resolve(JSON.parse(trimmed));
          } catch (e: any) {
            reject(new Error(`JSON解析失败 pos=${e.message} 前50字符: ${data.substring(0, 80)}`));
          }
        });
      },
    );
    req.on('error', (e) => reject(new Error(`请求失败: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
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
