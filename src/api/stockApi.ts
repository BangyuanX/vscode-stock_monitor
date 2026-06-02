import * as iconv from 'iconv-lite';
import { StockData } from '../types';

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

const TENCENT_API = 'http://qt.gtimg.cn/q=';
const STOCK_LINE_RE = /v_([a-z0-9_]+)="([^"]*)"/g;

// ============================================================
// 数据源 2: Yahoo Finance API (公开免费，无需 API Key)
// 适用于: 美股(usr_)
//
// 请求: GET https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d
// 响应: JSON, 含 meta.regularMarketPrice, meta.chartPreviousClose 等
// ============================================================

const YAHOO_API = 'https://query1.finance.yahoo.com/v8/finance/chart/';

/** Tencent 支持的股票前缀 */
const TENCENT_PREFIXES = ['sh', 'sz', 'bj', 'hk'];

/** Yahoo Finance 支持的股票前缀 */
const YAHOO_PREFIXES = ['usr_'];

/**
 * 批量获取股票行情
 * 自动根据代码前缀选择数据源
 *
 * @param codes 股票代码数组
 * @returns Map<code, StockData>
 */
export async function fetchStocks(codes: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (codes.length === 0) return result;

  // 按数据源分组
  const tencentCodes: string[] = [];
  const yahooCodes: string[] = [];

  for (const code of codes) {
    if (TENCENT_PREFIXES.some(p => code.startsWith(p))) {
      tencentCodes.push(code);
    } else if (YAHOO_PREFIXES.some(p => code.startsWith(p))) {
      // Yahoo 需要从 usr_aapl → AAPL
      yahooCodes.push(code.substring(4));
    }
  }

  // 并行获取多源数据
  const [tencentResult, yahooResult] = await Promise.all([
    fetchFromTencent(tencentCodes),
    fetchFromYahoo(yahooCodes),
  ]);

  // 合并结果
  for (const [code, data] of tencentResult) result.set(code, data);
  for (const [symbol, data] of yahooResult) {
    // 转回带前缀的代码
    const prefixedCode = `usr_${symbol.toLowerCase()}`;
    result.set(prefixedCode, data);
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
    const url = TENCENT_API + codes.join(',');
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = iconv.decode(buffer, 'gbk');

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
 * 从 Yahoo Finance 获取美股行情
 */
async function fetchFromYahoo(symbols: string[]): Promise<Map<string, StockData>> {
  const result = new Map<string, StockData>();
  if (symbols.length === 0) return result;

  // Yahoo 不支持批量查询，串行获取
  for (const symbol of symbols) {
    try {
      const url = `${YAHOO_API}${symbol}?interval=1d&range=1d`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
      });

      if (!response.ok) {
        console.warn(`[StockBar] Yahoo ${symbol} 请求失败: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const parsed = parseYahooResponse(symbol, data);
      if (parsed) result.set(symbol, parsed);

      // 礼貌性延时，避免触发 Yahoo 频率限制
      await delay(300);
    } catch (err) {
      console.error(`[StockBar] Yahoo ${symbol} 请求异常:`, err);
    }
  }

  return result;
}

/**
 * 解析 Yahoo Finance API 响应
 */
interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        regularMarketPrice: number;
        chartPreviousClose: number;
        regularMarketDayHigh: number;
        regularMarketDayLow: number;
        regularMarketTime: number;
      };
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: number[];
          high: number[];
          low: number[];
          close: number[];
          volume: number[];
        }>;
      };
    }> | null;
    error: { code: string; description: string } | null;
  };
}

function parseYahooResponse(symbol: string, raw: YahooChartResponse): StockData | null {
  if (raw.chart.error || !raw.chart.result || raw.chart.result.length === 0) {
    console.warn(`[StockBar] Yahoo ${symbol} 返回错误:`, raw.chart.error);
    return null;
  }

  const meta = raw.chart.result[0].meta;
  const quote = raw.chart.result[0].indicators.quote[0];
  const timestamps = raw.chart.result[0].timestamp;

  const price = meta.regularMarketPrice;
  const yestclose = meta.chartPreviousClose;

  if (isNaN(price) || isNaN(yestclose)) return null;

  const change = price - yestclose;
  const changePercent = yestclose > 0 ? (change / yestclose) * 100 : 0;

  // 取最新一条 K 线的开盘价
  const lastIdx = quote.open.length - 1;
  const open = lastIdx >= 0 ? (quote.open[lastIdx] || price) : price;

  const high = meta.regularMarketDayHigh || price;
  const low = meta.regularMarketDayLow || price;

  // 格式化时间
  const time = meta.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toLocaleString('zh-CN', { hour12: false })
    : '';

  return {
    code: symbol,
    name: symbol.toUpperCase(),
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
 * 统一格式化腾讯 API 的时间
 */
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
