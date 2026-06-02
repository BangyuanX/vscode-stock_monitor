import * as https from 'https';
import { StockData } from '../types';

/**
 * OKX 公开行情 API
 *
 * 使用 https 模块直接请求，避免 VSCode 扩展宿主中 fetch 实现的差异。
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
    const json = await httpsGet(`/api/v5/market/ticker?instId=${okxSymbol}`);
    if (!json) return null;

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
    console.warn(`[StockBar] OKX ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * HTTPS GET 请求，返回解析后的 JSON
 */
function httpsGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: OKX_API_HOST,
        path,
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: 8000,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const data = buf.toString('utf8');

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`));
            return;
          }

          // 检查是否是 JSON
          const trimmed = data.trim();
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            reject(new Error(`非JSON响应: ${data.substring(0, 100)}`));
            return;
          }

          try {
            resolve(JSON.parse(trimmed));
          } catch (e: any) {
            reject(new Error(`JSON解析失败: ${data.substring(0, 80)}`));
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
