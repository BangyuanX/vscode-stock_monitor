import { StockData } from '../types';
import { smartGetText, smartGet, smartGetJson } from './directHttp';

// ============================================================
// 数据源: Yahoo Finance v7 API (query1.finance.yahoo.com)
// 适用于: 加密货币 — 使用 Yahoo 标准格式（如 BTC-USD）
//
// 请求: GET /v7/finance/quote?symbols=BTC-USD,ETH-USD&fields=...
//         &crumb=xxx
// 响应: { quoteResponse: { result: [...] } }
// ============================================================

const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** Yahoo cookie 缓存 */
let yahooCookie: string | null = null;

/**
 * 获取 Yahoo 认证 cookie
 */
async function fetchYahooCookie(): Promise<string | null> {
  try {
    const resp = await smartGet('finance.yahoo.com', '/quote/BTC-USD', {
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

    for (const line of setCookie.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('A1=')) {
        return trimmed.split(';')[0];
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

/** Yahoo v7 quote 字段列表 */
const V7_FIELDS = [
  'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent',
  'regularMarketPreviousClose', 'shortName', 'marketState',
].join(',');

interface YahooV7Quote {
  symbol: string;
  shortName?: string;
  marketState?: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketPreviousClose?: number;
}

interface YahooV7Response {
  quoteResponse: {
    result?: YahooV7Quote[];
    error?: any;
  };
}

/**
 * 批量获取加密货币行情（通过 Yahoo v7）
 *
 * @param symbols 加密货币代码数组，Yahoo 标准格式
 *                 如 ['BTC-USD', 'ETH-USD']
 * @returns Map<symbol, StockData>
 */
export async function fetchCryptos(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  // 获取/复用 cookie
  if (!yahooCookie) {
    yahooCookie = await fetchYahooCookie();
  }
  if (!yahooCookie) {
    console.warn('[StockBar] Yahoo cookie 获取失败，跳过加密货币');
    return result;
  }

  // 获取 crumb
  const crumb = await fetchYahooCrumb(yahooCookie);
  if (!crumb) return result;

  try {
    const symbolParam = symbols.join(',');
    const path = `/v7/finance/quote?symbols=${symbolParam}&fields=${V7_FIELDS}&crumb=${crumb}&formatted=false&region=US&lang=en-US`;

    const { data } = await smartGetJson('query1.finance.yahoo.com', path, {
      useTls: true,
      headers: { 'Cookie': yahooCookie, 'User-Agent': YAHOO_UA },
    });

    const quoteData = data as YahooV7Response;
    if (quoteData.quoteResponse?.error) {
      console.warn('[StockBar] Yahoo 加密货币返回错误:', quoteData.quoteResponse.error);
      if (String(quoteData.quoteResponse.error).includes('Unauthorized')) {
        yahooCookie = null;
      }
      return result;
    }

    const quotes = quoteData.quoteResponse?.result || [];
    for (const quote of quotes) {
      const parsed = parseYahooQuote(quote);
      if (parsed) result.set(parsed.code, parsed);
    }
  } catch (err: any) {
    console.error(`[StockBar] Yahoo 加密货币请求失败:`, err?.message || err);
    if (err?.message?.includes('Unauthorized')) {
      yahooCookie = null;
    }
  }

  return result;
}

/**
 * 解析 Yahoo v7 quote 为 StockData
 */
function parseYahooQuote(quote: YahooV7Quote): StockData | null {
  const symbol = quote.symbol;
  if (!symbol) return null;

  const price = quote.regularMarketPrice;
  if (price == null || isNaN(price)) return null;

  const yestclose = quote.regularMarketPreviousClose ?? price;
  const change = quote.regularMarketChange ?? (price - yestclose);
  const changePercent = quote.regularMarketChangePercent ?? 0;

  return {
    code: symbol.toLowerCase(),
    name: quote.shortName || symbol,
    price,
    change,
    changePercent: typeof changePercent === 'number' ? parseFloat(changePercent.toFixed(2)) : 0,
    high: price,
    low: price,
    open: yestclose,
    yestclose,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  };
}
