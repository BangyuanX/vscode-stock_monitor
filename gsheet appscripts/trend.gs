/**
 * A股 / ETF / 场内基金 / 国债逆回购 / 币安现货 / 美股与美股ETF 行情更新脚本
 *
 * v4 说明：
 * 1. 删除合约行情：BTC/USDT:USDT、BTC/USD:BTC 等输入会被标记为“合约行情已删除”。
 * 2. 删除盘前价、盘后价、涨跌额、成交量、成交额列；最新价直接取最新可用价格。
 * 3. 美股改为优先使用 Yahoo Finance v8 chart + includePrePost=true 的最新可用价格。
 *    - 盘前 / 盘后时，最新价优先取盘前盘后最新 1分钟 bar 或 Yahoo 返回的 pre/post price。
 *    - 盘中时，最新价取常规交易最新价。
 *    - 休市时，最新价取最近一个可用价格，通常是盘后价或常规收盘价。
 * 4. Yahoo 失败时，使用 Stooq CSV 兜底；Stooq 通常是延迟/EOD，不含盘前盘后。
 * 5. A股 / ETF / 场内基金尚未开市或停牌时，如果新浪最新价为0、昨收有效，
 *    最新价暂按昨收写入，涨跌幅记为0，避免下游盈亏公式产生虚假亏损。
 *
 * A列输入规范：
 *
 * 1. A股 / ETF / 国债逆回购：
 *    只写6位数字
 *    示例：
 *    600519
 *    510300
 *    204001
 *
 * 2. 币安现货，使用 CCXT spot symbol：
 *    BASE/QUOTE
 *    示例：
 *    BTC/USDT
 *    BNB/USDT
 *    MUBARAK/USDT
 *
 * 3. 美股 / 美股ETF：
 *    直接写 ticker
 *    示例：
 *    MRVL
 *    QQQ
 *    SPY
 *    AAPL
 *    NVDA
 *
 * 4. 已删除：
 *    合约行情：BTC/USDT:USDT、BTC/USD:BTC 等
 *
 * 表格用法：
 * 1. 工作表名称为「行情」
 * 2. A列从第2行开始填写代码
 * 3. 首次运行 setupSheet()
 * 4. 手动运行 updateMarketQuotes()
 * 5. 需要自动刷新时，运行 createOneMinuteTrigger()
 */

const CONFIG = {
  SHEET_NAME: '行情',
  START_ROW: 2,
  CODE_COL: 1,
  OUTPUT_START_COL: 2,

  // 新浪行情接口：A股 / ETF / 国债逆回购
  SINA_BASE_URL: 'https://hq.sinajs.cn/list=',
  SINA_BATCH_SIZE: 80,
  SINA_RESPONSE_ENCODING: 'GBK',

  // 币安现货行情接口
  BINANCE_SPOT_24HR_URL: 'https://data-api.binance.vision/api/v3/ticker/24hr',
  BINANCE_SPOT_BATCH_SIZE: 80,

  // Yahoo Finance chart 接口：美股 / ETF
  // v7/finance/quote 在 Apps Script 里经常返回 401；v8/chart 相对更稳定。
  // query1 偶尔不可用时，会再尝试 query2。
  YAHOO_CHART_BASE_URLS: [
    'https://query1.finance.yahoo.com/v8/finance/chart',
    'https://query2.finance.yahoo.com/v8/finance/chart'
  ],
  YAHOO_BATCH_SIZE: 40,

  // 美股备用源：Stooq CSV。通常延迟且不含盘前/盘后，但可作为 Yahoo 失败时兜底。
  STOOQ_QUOTE_URL: 'https://stooq.com/q/l/'
};

const HEADERS = [
  '输入代码',
  '标准代码',
  '名称',
  '市场类型',
  '交易阶段',
  '最新价/利率',
  '涨跌幅',
  '开盘',
  '昨收/24h开盘',
  '最高',
  '最低',
  '行情时间',
  '数据状态',
  '脚本刷新时间'
];

// 旧版最多到 S 列。缩表后清理多余旧列，避免残留“盘前价/盘后价/成交量/成交额”等旧数据。
const LEGACY_MAX_COLUMNS = 19;

// B列开始的输出字段顺序，必须与 HEADERS 第2列起保持一致
const OUTPUT_FIELDS = [
  'standardCode',
  'name',
  'marketName',
  'phase',
  'price',
  'changePct',
  'open',
  'prevClose',
  'high',
  'low',
  'quoteTime',
  'status',
  'refreshTime'
];

/**
 * 初始化表头和格式
 *
 * 注意：
 * 这里会自动调整一次列宽。
 * 后续 updateMarketQuotes() 自动刷新时不会调整列宽。
 */
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  clearLegacyColumns_(sheet, Math.max(sheet.getLastRow() - CONFIG.START_ROW + 1, 1));
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.setFrozenRows(1);
  applyFormats_(sheet, Math.max(sheet.getLastRow() - CONFIG.START_ROW + 1, 1));

  // 只在初始化时自动调整列宽
  sheet.autoResizeColumns(1, HEADERS.length);
}

/**
 * 主函数：读取A列代码，批量获取行情，写回表格
 *
 * 注意：
 * 这个函数不会自动调整列宽。
 */
function updateMarketQuotes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getActiveSheet();

  ensureHeaders_(sheet);

  const lastRow = sheet.getLastRow();

  if (lastRow < CONFIG.START_ROW) {
    return;
  }

  const numRows = lastRow - CONFIG.START_ROW + 1;

  // 用 displayValues，避免 000001 变成 1
  const rawCodes = sheet
    .getRange(CONFIG.START_ROW, CONFIG.CODE_COL, numRows, 1)
    .getDisplayValues()
    .map(row => row[0]);

  const instruments = rawCodes.map(code => resolveInstrument_(code));

  const sinaCodes = [];
  const binanceSpotInstruments = [];
  const yahooInstruments = [];

  instruments.forEach(inst => {
    if (!inst) {
      return;
    }

    if (inst.source === 'SINA') {
      sinaCodes.push(inst.apiSymbol);
    }

    if (inst.source === 'BINANCE_SPOT') {
      binanceSpotInstruments.push(inst);
    }

    if (inst.source === 'YAHOO_US') {
      yahooInstruments.push(inst);
    }
  });

  const sinaQuoteMap = fetchSinaQuotes_([...new Set(sinaCodes)]);
  const binanceQuoteMap = fetchBinanceSpotQuotes_(binanceSpotInstruments);
  const yahooQuoteMap = fetchYahooQuotes_(yahooInstruments);

  const now = new Date();
  const outputWidth = HEADERS.length - 1;

  const rows = instruments.map((inst, index) => {
    const rawCode = String(rawCodes[index] || '').trim();

    if (!rawCode) {
      return new Array(outputWidth).fill('');
    }

    if (!inst) {
      return makeOutputRow_(null, {
        status: '代码无法识别；A股请写6位数字，币安现货请写BASE/QUOTE，美股请写ticker'
      }, now);
    }

    if (inst.source === 'UNSUPPORTED_CONTRACT') {
      return makeOutputRow_(inst, {
        status: inst.reason || '合约行情已删除；当前版本不再获取合约行情'
      }, now);
    }

    let quote = null;

    if (inst.source === 'SINA') {
      quote = sinaQuoteMap[inst.key];
    }

    if (inst.source === 'BINANCE_SPOT') {
      quote = binanceQuoteMap[inst.key];
    }

    if (inst.source === 'YAHOO_US') {
      quote = yahooQuoteMap[inst.key];
    }

    if (!quote) {
      quote = makeErrorQuote_(inst, '接口无数据/代码错误/暂不支持');
    }

    return makeOutputRow_(inst, quote, now);
  });

  sheet
    .getRange(CONFIG.START_ROW, CONFIG.OUTPUT_START_COL, rows.length, outputWidth)
    .setValues(rows);

  clearLegacyColumns_(sheet, rows.length);
  applyFormats_(sheet, rows.length);
}

/**
 * 创建每分钟自动刷新触发器
 */
function createOneMinuteTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'updateMarketQuotes') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('updateMarketQuotes')
    .timeBased()
    .everyMinutes(1)
    .create();
}

/**
 * 删除自动刷新触发器
 */
function deleteQuoteTriggers() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'updateMarketQuotes') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/**
 * 打开表格时添加菜单
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('行情工具')
    .addItem('初始化表头', 'setupSheet')
    .addItem('立即刷新行情', 'updateMarketQuotes')
    .addItem('创建每分钟刷新', 'createOneMinuteTrigger')
    .addItem('删除自动刷新', 'deleteQuoteTriggers')
    .addToUi();
}

/**
 * 识别输入代码
 */
function resolveInstrument_(input) {
  const raw = String(input || '').trim();

  if (!raw) {
    return null;
  }

  // A股 / ETF / 国债逆回购：只接受6位数字
  if (/^\d{6}$/.test(raw)) {
    const sinaCode = inferSinaCodeBySixDigit_(raw);

    if (!sinaCode) {
      return null;
    }

    return {
      source: 'SINA',
      key: sinaCode,
      apiSymbol: sinaCode,
      standardCode: raw,
      displayName: '',
      marketName: 'A股/基金/债券'
    };
  }

  // CCXT风格：
  // - 币安现货：BTC/USDT
  // - 合约：BTC/USDT:USDT、BTC/USD:BTC 当前版本删除，不再请求
  if (looksLikeCcxtSymbol_(raw)) {
    if (String(raw).indexOf(':') >= 0 || String(raw).indexOf('：') >= 0) {
      const normalized = String(raw)
        .trim()
        .toUpperCase()
        .replace(/：/g, ':')
        .replace(/\s+/g, '');

      return {
        source: 'UNSUPPORTED_CONTRACT',
        standardCode: normalized,
        displayName: normalized,
        marketName: '合约行情已删除',
        reason: '合约行情已删除；当前版本只保留币安现货 BASE/QUOTE'
      };
    }

    const crypto = parseCcxtSpotSymbol_(raw);

    if (crypto) {
      return crypto;
    }
  }

  // 美股 / 美股ETF：MRVL、QQQ、SPY、BRK.B 等
  const us = parseUsTicker_(raw);

  if (us) {
    return us;
  }

  return null;
}

/**
 * 根据6位代码推断新浪市场前缀
 */
function inferSinaCodeBySixDigit_(code) {
  const s = String(code || '').trim();

  if (!/^\d{6}$/.test(s)) {
    return null;
  }

  /**
   * 国债逆回购：
   * - 204xxx：上交所 GC 系列
   * - 1318xx：深交所 R 系列
   */
  if (/^204/.test(s)) {
    return 'sh' + s;
  }

  if (/^1318/.test(s)) {
    return 'sz' + s;
  }

  /**
   * 上海：
   * - 6xxxxx：沪市股票
   * - 5xxxxx：沪市 ETF、基金、REITs、债券 ETF 等
   * - 9xxxxx：沪市 B股等
   */
  if (/^[569]/.test(s)) {
    return 'sh' + s;
  }

  /**
   * 深圳：
   * - 0xxxxx：深市主板
   * - 1xxxxx：深市 ETF、LOF、基金等
   * - 2xxxxx：深市 B股
   * - 3xxxxx：创业板
   */
  if (/^[0123]/.test(s)) {
    return 'sz' + s;
  }

  /**
   * 北交所：
   * - 4xxxxx / 8xxxxx / 92xxxx：北交所常见代码段
   */
  if (/^(4|8|92)/.test(s)) {
    return 'bj' + s;
  }

  return null;
}

/**
 * 判断是否像 CCXT symbol
 */
function looksLikeCcxtSymbol_(input) {
  const s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?$/.test(s);
}

/**
 * 解析 CCXT 风格的币安现货 symbol
 *
 * 支持：
 * BTC/USDT
 * BNB/USDT
 * MUBARAK/USDT
 */
function parseCcxtSpotSymbol_(input) {
  const ccxtSymbol = String(input || '')
    .trim()
    .toUpperCase()
    .replace(/：/g, ':')
    .replace(/\s+/g, '');

  const match = ccxtSymbol.match(/^([A-Z0-9]+)\/([A-Z0-9]+)$/);

  if (!match) {
    return null;
  }

  const base = match[1];
  const quote = match[2];
  const apiSymbol = base + quote;
  const standardCode = base + '/' + quote;
  const key = 'BINANCE_SPOT:' + apiSymbol;

  return {
    source: 'BINANCE_SPOT',
    key,
    apiSymbol,
    standardCode,
    base,
    quote,
    displayName: standardCode + ' 现货',
    marketName: '币安现货'
  };
}

/**
 * 解析美股 / 美股ETF ticker
 *
 * 支持：
 * MRVL
 * QQQ
 * SPY
 * BRK.B
 * BRK-B
 *
 * Yahoo Finance 对 BRK.B 这类通常使用 BRK-B。
 */
function parseUsTicker_(input) {
  const raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '');

  if (!raw) {
    return null;
  }

  // 支持用户写 US:MRVL / NASDAQ:QQQ / NYSE:BRK.B
  let ticker = raw;

  const prefixed = raw.match(/^(US|NASDAQ|NYSE|AMEX|ARCA):([A-Z]{1,10}(?:[.-][A-Z]{1,3})?)$/);

  if (prefixed) {
    ticker = prefixed[2];
  }

  // 避免把明显不是美股ticker的字符串识别进去
  if (!/^[A-Z]{1,10}(?:[.-][A-Z]{1,3})?$/.test(ticker)) {
    return null;
  }

  // Yahoo 使用 - 表示部分带点代码，例如 BRK.B -> BRK-B
  const yahooSymbol = ticker.replace('.', '-');
  const standardCode = ticker.replace('-', '.');
  const key = 'YAHOO_US:' + yahooSymbol;

  return {
    source: 'YAHOO_US',
    key,
    apiSymbol: yahooSymbol,
    yahooSymbol,
    standardCode,
    displayName: standardCode,
    marketName: '美股/ETF'
  };
}

/**
 * 请求 Yahoo Finance 美股行情
 */
function fetchYahooQuotes_(instruments) {
  const map = {};

  if (!instruments || instruments.length === 0) {
    return map;
  }

  const uniqueBySymbol = {};

  instruments.forEach(inst => {
    if (inst && inst.yahooSymbol) {
      uniqueBySymbol[inst.yahooSymbol] = inst;
    }
  });

  const symbols = Object.keys(uniqueBySymbol);

  if (symbols.length === 0) {
    return map;
  }

  const chunks = chunk_(symbols, CONFIG.YAHOO_BATCH_SIZE);

  chunks.forEach(chunk => {
    const requests = chunk.map(symbol => ({
      url: buildYahooChartUrl_(CONFIG.YAHOO_CHART_BASE_URLS[0], symbol),
      method: 'get',
      muteHttpExceptions: true,
      headers: getYahooHeaders_()
    }));

    const responses = UrlFetchApp.fetchAll(requests);

    responses.forEach((response, index) => {
      const symbol = chunk[index];
      const inst = uniqueBySymbol[symbol];
      const statusCode = response.getResponseCode();
      const text = response.getContentText();

      let quote = null;

      if (statusCode === 200) {
        quote = parseYahooChartQuote_(safeJsonParse_(text), inst);
      }

      // query1 失败时再尝试 query2；二者都失败再走 Stooq。
      if (!quote && CONFIG.YAHOO_CHART_BASE_URLS.length > 1) {
        quote = fetchYahooChartQuoteFromFallbackBases_(inst, 1);
      }

      if (quote) {
        map[inst.key] = quote;
        return;
      }

      const stooqQuote = fetchStooqQuote_(inst);

      if (stooqQuote) {
        map[inst.key] = stooqQuote;
        return;
      }

      map[inst.key] = makeErrorQuote_(
        inst,
        'Yahoo美股请求失败：HTTP ' + statusCode + '，且Stooq备用源无数据；' + String(text || '').slice(0, 160)
      );
    });
  });

  return map;
}

function buildYahooChartUrl_(baseUrl, symbol) {
  return (
    String(baseUrl).replace(/\/$/, '') +
    '/' +
    encodeURIComponent(symbol) +
    '?range=1d&interval=1m&includePrePost=true&events=div%2Csplits&lang=en-US&region=US'
  );
}

function getYahooHeaders_() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'application/json,text/plain,*/*',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com'
  };
}

function fetchYahooChartQuoteFromFallbackBases_(inst, startIndex) {
  for (let i = startIndex; i < CONFIG.YAHOO_CHART_BASE_URLS.length; i++) {
    const baseUrl = CONFIG.YAHOO_CHART_BASE_URLS[i];

    try {
      const response = UrlFetchApp.fetch(buildYahooChartUrl_(baseUrl, inst.yahooSymbol), {
        method: 'get',
        muteHttpExceptions: true,
        headers: getYahooHeaders_()
      });

      if (response.getResponseCode() !== 200) {
        continue;
      }

      const quote = parseYahooChartQuote_(safeJsonParse_(response.getContentText()), inst);

      if (quote) {
        return quote;
      }
    } catch (err) {
      // 继续尝试下一个 baseUrl
    }
  }

  return null;
}

/**
 * 解析 Yahoo Finance v8 chart
 *
 * 关键逻辑：
 * - includePrePost=true 后，timestamp / close 里通常会包含盘前、盘中、盘后 1分钟bar。
 * - 最新价不再强行使用 meta.regularMarketPrice；而是从“chart最新bar、preMarketPrice、postMarketPrice、regularMarketPrice”里按时间取最新。
 * - 开盘/最高/最低尽量使用常规交易时段的日内数据，避免被最后1分钟bar污染。
 */
function parseYahooChartQuote_(data, inst) {
  if (
    !data ||
    !data.chart ||
    data.chart.error ||
    !Array.isArray(data.chart.result) ||
    data.chart.result.length === 0
  ) {
    return null;
  }

  const result = data.chart.result[0];
  const meta = result.meta || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const periods = meta.currentTradingPeriod || {};
  const quoteArr =
    result.indicators &&
    Array.isArray(result.indicators.quote) &&
    result.indicators.quote.length > 0
      ? result.indicators.quote[0]
      : {};

  const closes = Array.isArray(quoteArr.close) ? quoteArr.close : [];
  const opens = Array.isArray(quoteArr.open) ? quoteArr.open : [];
  const highs = Array.isArray(quoteArr.high) ? quoteArr.high : [];
  const lows = Array.isArray(quoteArr.low) ? quoteArr.low : [];
  const volumes = Array.isArray(quoteArr.volume) ? quoteArr.volume : [];

  const latestBar = findLatestValidBar_(timestamps, closes);
  const regularStats = computeRegularSessionStats_(timestamps, opens, highs, lows, volumes, periods.regular);

  const candidates = [];

  if (latestBar) {
    candidates.push({
      price: latestBar.price,
      quoteTime: latestBar.quoteTime,
      phase: getYahooPhaseForTimestamp_(latestBar.timestamp, periods, meta.marketState || ''),
      source: 'Yahoo最新1分钟bar'
    });
  }

  addYahooCandidate_(candidates, toNumber_(meta.preMarketPrice), meta.preMarketTime, '盘前', 'Yahoo盘前字段');
  addYahooCandidate_(candidates, toNumber_(meta.postMarketPrice), meta.postMarketTime, '盘后', 'Yahoo盘后字段');
  addYahooCandidate_(candidates, toNumber_(meta.regularMarketPrice), meta.regularMarketTime, '盘中/常规', 'Yahoo常规字段');

  const selected = pickLatestQuoteCandidate_(candidates);

  if (!selected) {
    return null;
  }

  const prevClose = firstNumber_(meta.previousClose, meta.chartPreviousClose);
  const price = selected.price;

  let change = '';
  let changePct = '';

  if (isFiniteNumber_(price) && isFiniteNumber_(prevClose) && prevClose !== 0) {
    change = price - prevClose;
    changePct = change / prevClose;
  }

  let preMarketPrice = toNumber_(meta.preMarketPrice);
  let postMarketPrice = toNumber_(meta.postMarketPrice);

  if (preMarketPrice === '' && selected.phase === '盘前') {
    preMarketPrice = price;
  }

  if (postMarketPrice === '' && selected.phase === '盘后') {
    postMarketPrice = price;
  }

  const marketState = translateYahooMarketState_(meta.marketState || '');
  const phase = selected.phase || marketState || '最新可用';

  const open = firstNumber_(meta.regularMarketOpen, regularStats.open);
  const high = firstNumber_(meta.regularMarketDayHigh, regularStats.high);
  const low = firstNumber_(meta.regularMarketDayLow, regularStats.low);
  const volume = firstNumber_(meta.regularMarketVolume, regularStats.volume);

  return {
    name: meta.longName || meta.shortName || inst.displayName,
    marketName: '美股/ETF',
    phase,
    price,
    change,
    changePct,
    open,
    prevClose,
    high,
    low,
    volume,
    amount: '',
    preMarketPrice,
    postMarketPrice,
    quoteTime: selected.quoteTime,
    status: 'OK；Yahoo chart源；最新价来源=' + selected.source + '；marketState=' + (meta.marketState || '')
  };
}

function addYahooCandidate_(candidates, price, unixSeconds, phase, source) {
  if (!isFiniteNumber_(price)) {
    return;
  }

  const quoteTime = toDateFromUnixSeconds_(unixSeconds);

  if (!quoteTime) {
    return;
  }

  candidates.push({
    price,
    quoteTime,
    phase,
    source
  });
}

function findLatestValidBar_(timestamps, closes) {
  for (let i = closes.length - 1; i >= 0; i--) {
    const price = toNumber_(closes[i]);

    if (!isFiniteNumber_(price)) {
      continue;
    }

    const timestamp = Number(timestamps[i]);

    if (!isFinite(timestamp) || timestamp <= 0) {
      continue;
    }

    return {
      index: i,
      timestamp,
      quoteTime: new Date(timestamp * 1000),
      price
    };
  }

  return null;
}

function getYahooPhaseForTimestamp_(timestamp, periods, fallbackState) {
  if (isTimestampInPeriod_(timestamp, periods.pre)) {
    return '盘前';
  }

  if (isTimestampInPeriod_(timestamp, periods.regular)) {
    return '盘中/常规';
  }

  if (isTimestampInPeriod_(timestamp, periods.post)) {
    return '盘后';
  }

  return translateYahooMarketState_(fallbackState) || '最新可用';
}

function isTimestampInPeriod_(timestamp, period) {
  if (!period) {
    return false;
  }

  const start = Number(period.start);
  const end = Number(period.end);

  if (!isFinite(start) || !isFinite(end)) {
    return false;
  }

  return Number(timestamp) >= start && Number(timestamp) <= end;
}

function computeRegularSessionStats_(timestamps, opens, highs, lows, volumes, regularPeriod) {
  const result = {
    open: '',
    high: '',
    low: '',
    volume: ''
  };

  let totalVolume = 0;
  let hasVolume = false;

  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = Number(timestamps[i]);

    if (!isTimestampInPeriod_(timestamp, regularPeriod)) {
      continue;
    }

    const open = toNumber_(opens[i]);
    const high = toNumber_(highs[i]);
    const low = toNumber_(lows[i]);
    const volume = toNumber_(volumes[i]);

    if (result.open === '' && isFiniteNumber_(open)) {
      result.open = open;
    }

    if (isFiniteNumber_(high)) {
      result.high = result.high === '' ? high : Math.max(result.high, high);
    }

    if (isFiniteNumber_(low)) {
      result.low = result.low === '' ? low : Math.min(result.low, low);
    }

    if (isFiniteNumber_(volume)) {
      totalVolume += volume;
      hasVolume = true;
    }
  }

  result.volume = hasVolume ? totalVolume : '';
  return result;
}

/**
 * Stooq 备用源：主要用于 Yahoo 失败时兜底。
 * 返回字段通常是延迟行情 / 当日或上一交易日 OHLCV，不提供盘前盘后。
 */
function fetchStooqQuote_(inst) {
  if (!inst || !inst.standardCode) {
    return null;
  }

  const ticker = String(inst.standardCode || '').toLowerCase().replace('.', '-') + '.us';
  const url =
    CONFIG.STOOQ_QUOTE_URL +
    '?s=' +
    encodeURIComponent(ticker) +
    '&f=sd2t2ohlcv&h&e=csv';

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/csv,text/plain,*/*'
      }
    });

    if (response.getResponseCode() !== 200) {
      return null;
    }

    const rows = Utilities.parseCsv(response.getContentText());

    if (!rows || rows.length < 2) {
      return null;
    }

    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const row = rows[1];

    function get(name) {
      const idx = header.indexOf(String(name).toLowerCase());
      return idx >= 0 ? row[idx] : '';
    }

    const closeRaw = get('Close');

    if (!closeRaw || String(closeRaw).toUpperCase() === 'N/D') {
      return null;
    }

    const date = get('Date');
    const time = get('Time');
    const quoteTimeText = [date, time].filter(Boolean).join(' ');

    return {
      name: inst.displayName,
      marketName: '美股/ETF',
      phase: 'Stooq备用',
      price: toNumber_(closeRaw),
      change: '',
      changePct: '',
      open: toNumber_(get('Open')),
      prevClose: '',
      high: toNumber_(get('High')),
      low: toNumber_(get('Low')),
      volume: toNumber_(get('Volume')),
      amount: '',
      preMarketPrice: '',
      postMarketPrice: '',
      quoteTime: quoteTimeText,
      status: 'OK；Yahoo失败后使用Stooq备用源；可能延迟且无盘前/盘后'
    };
  } catch (err) {
    return null;
  }
}

/**
 * 批量请求币安现货行情
 */
function fetchBinanceSpotQuotes_(instruments) {
  const map = {};

  if (!instruments || instruments.length === 0) {
    return map;
  }

  const uniqueBySymbol = {};

  instruments.forEach(inst => {
    if (inst && inst.apiSymbol) {
      uniqueBySymbol[inst.apiSymbol] = inst;
    }
  });

  const symbols = Object.keys(uniqueBySymbol);

  if (symbols.length === 0) {
    return map;
  }

  const chunks = chunk_(symbols, CONFIG.BINANCE_SPOT_BATCH_SIZE);

  const requests = chunks.map(chunk => ({
    url:
      CONFIG.BINANCE_SPOT_24HR_URL +
      '?symbols=' +
      encodeURIComponent(JSON.stringify(chunk)),
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    }
  }));

  const responses = UrlFetchApp.fetchAll(requests);

  responses.forEach((response, chunkIndex) => {
    const statusCode = response.getResponseCode();
    const text = response.getContentText();

    if (statusCode !== 200) {
      chunks[chunkIndex].forEach(symbol => {
        const inst = uniqueBySymbol[symbol];
        map[inst.key] = makeErrorQuote_(inst, normalizeBinanceErrorMessage_(statusCode, text, inst));
      });
      return;
    }

    const data = safeJsonParse_(text);

    if (!data) {
      chunks[chunkIndex].forEach(symbol => {
        const inst = uniqueBySymbol[symbol];
        map[inst.key] = makeErrorQuote_(inst, '币安现货返回无法解析');
      });
      return;
    }

    if (data.code && data.msg) {
      chunks[chunkIndex].forEach(symbol => {
        const inst = uniqueBySymbol[symbol];
        map[inst.key] = makeErrorQuote_(inst, '币安现货错误：' + data.code + ' ' + data.msg);
      });
      return;
    }

    const arr = Array.isArray(data) ? data : [data];

    arr.forEach(item => {
      const symbol = String(item.symbol || '').toUpperCase();
      const inst = uniqueBySymbol[symbol];

      if (!inst) {
        return;
      }

      map[inst.key] = parseBinance24hrTicker_(item, inst);
    });

    // 对没有返回的 symbol 标记错误
    chunks[chunkIndex].forEach(symbol => {
      const inst = uniqueBySymbol[symbol];

      if (!map[inst.key]) {
        map[inst.key] = makeErrorQuote_(inst, '币安现货无返回；可能交易对错误或暂不支持');
      }
    });
  });

  return map;
}

/**
 * 解析币安错误信息
 */
function normalizeBinanceErrorMessage_(statusCode, text, inst) {
  const shortText = String(text || '').slice(0, 160);

  if (
    statusCode === 451 ||
    shortText.toLowerCase().indexOf('restricted location') >= 0
  ) {
    return inst.marketName + '接口地区限制，Apps Script 当前出口不可访问';
  }

  return '币安现货请求失败：HTTP ' + statusCode + '，' + shortText;
}

/**
 * 解析币安现货 24hr ticker
 */
function parseBinance24hrTicker_(data, inst) {
  const price = toNumber_(data.lastPrice || data.price);
  const open = toNumber_(data.openPrice);
  const high = toNumber_(data.highPrice);
  const low = toNumber_(data.lowPrice);
  const volume = toNumber_(data.volume);
  const amount = toNumber_(data.quoteVolume || '');

  let change = toNumber_(data.priceChange);
  let changePct = '';

  if (data.priceChangePercent !== undefined && data.priceChangePercent !== '') {
    const pct = Number(data.priceChangePercent);
    changePct = isFinite(pct) ? pct / 100 : '';
  }

  if (change === '' && isFiniteNumber_(price) && isFiniteNumber_(open)) {
    change = price - open;
  }

  const quoteTime = data.closeTime || data.time ? new Date(Number(data.closeTime || data.time)) : '';

  return {
    name: inst.displayName,
    marketName: inst.marketName,
    phase: '24小时',
    price,
    change,
    changePct,
    open,
    prevClose: open,
    high,
    low,
    volume,
    amount,
    preMarketPrice: '',
    postMarketPrice: '',
    quoteTime,
    status: 'OK'
  };
}

/**
 * 批量请求新浪行情
 */
function fetchSinaQuotes_(codes) {
  const map = {};

  if (!codes || codes.length === 0) {
    return map;
  }

  const chunks = chunk_(codes, CONFIG.SINA_BATCH_SIZE);

  const requests = chunks.map(chunk => ({
    url: CONFIG.SINA_BASE_URL + chunk.join(','),
    method: 'get',
    headers: {
      Referer: 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0'
    },
    muteHttpExceptions: true
  }));

  const responses = UrlFetchApp.fetchAll(requests);

  responses.forEach((response, index) => {
    const statusCode = response.getResponseCode();

    if (statusCode !== 200) {
      chunks[index].forEach(code => {
        const inst = {
          displayName: '',
          marketName: 'A股/基金/债券'
        };

        map[code] = makeErrorQuote_(inst, '新浪行情请求失败：HTTP ' + statusCode);
      });
      return;
    }

    const text = response.getContentText(CONFIG.SINA_RESPONSE_ENCODING);
    const parsed = parseSinaResponse_(text);

    Object.keys(parsed).forEach(code => {
      map[code] = parsed[code];
    });
  });

  return map;
}

/**
 * 解析新浪返回文本
 */
function parseSinaResponse_(text) {
  const map = {};
  const regex = /var hq_str_([a-zA-Z0-9_]+)="([^"]*)";/g;

  let match;

  while ((match = regex.exec(text)) !== null) {
    const code = String(match[1] || '').toLowerCase();
    const body = match[2];

    if (!body) {
      continue;
    }

    const fields = body.split(',');

    /**
     * 新浪常见字段顺序：
     * 0  名称
     * 1  开盘
     * 2  昨收
     * 3  当前价 / 当前利率
     * 4  最高
     * 5  最低
     * 6  买一，已不输出
     * 7  卖一，已不输出
     * 8  成交量
     * 9  成交额
     * 30 日期
     * 31 时间
     * 32 状态
     */
    const name = fields[0] || '';
    const open = toNumber_(fields[1]);
    const prevClose = toNumber_(fields[2]);
    const reportedPrice = toNumber_(fields[3]);
    const high = toNumber_(fields[4]);
    const low = toNumber_(fields[5]);
    const volume = toNumber_(fields[8]);
    const amount = toNumber_(fields[9]);
    const date = fields[30] || '';
    const time = fields[31] || '';
    const rawStatus = fields[32] || '';

    // 新浪在尚未开市或停牌时可能返回最新价 0，但昨收仍然有效。
    // 将这种 0 值视为“暂无成交”，避免表格和下游盈亏公式把它当成真实价格。
    const usingPreviousClose =
      isFiniteNumber_(reportedPrice) &&
      reportedPrice <= 0 &&
      isFiniteNumber_(prevClose) &&
      prevClose > 0;
    const price = usingPreviousClose ? prevClose : reportedPrice;

    let change = '';
    let changePct = '';

    if (isFiniteNumber_(price) && isFiniteNumber_(prevClose) && prevClose !== 0) {
      change = price - prevClose;
      changePct = change / prevClose;
    }

    let status = 'OK';

    if (!name) {
      status = '无名称/可能代码错误';
    } else if (usingPreviousClose) {
      status = '暂无有效最新价（可能尚未开市或停牌）；当前按昨收显示';
    } else if (rawStatus && rawStatus !== '00') {
      status = '状态码：' + rawStatus;
    }

    map[code] = {
      name,
      marketName: 'A股/基金/债券',
      phase: '',
      open,
      prevClose,
      price,
      high,
      low,
      volume,
      amount,
      preMarketPrice: '',
      postMarketPrice: '',
      change,
      changePct,
      quoteTime: [date, time].filter(Boolean).join(' '),
      status
    };
  }

  return map;
}

/**
 * 生成错误行情对象
 */
function makeErrorQuote_(inst, status) {
  return {
    name: inst && inst.displayName ? inst.displayName : '',
    marketName: inst && inst.marketName ? inst.marketName : '',
    phase: '',
    price: '',
    change: '',
    changePct: '',
    open: '',
    prevClose: '',
    high: '',
    low: '',
    volume: '',
    amount: '',
    preMarketPrice: '',
    postMarketPrice: '',
    quoteTime: '',
    status: status || ''
  };
}

/**
 * 将 inst + quote 统一转换成表格输出行
 */
function makeOutputRow_(inst, quote, refreshTime) {
  quote = quote || {};

  const rowObj = {
    standardCode: inst && inst.standardCode ? inst.standardCode : '',
    name: valueOrEmpty_(quote.name) || (inst && inst.displayName ? inst.displayName : ''),
    marketName: valueOrEmpty_(quote.marketName) || (inst && inst.marketName ? inst.marketName : ''),
    phase: valueOrEmpty_(quote.phase),
    price: valueOrEmpty_(quote.price),
    changePct: valueOrEmpty_(quote.changePct),
    open: valueOrEmpty_(quote.open),
    prevClose: valueOrEmpty_(quote.prevClose),
    high: valueOrEmpty_(quote.high),
    low: valueOrEmpty_(quote.low),
    quoteTime: valueOrEmpty_(quote.quoteTime),
    status: valueOrEmpty_(quote.status),
    refreshTime
  };

  return OUTPUT_FIELDS.map(field => valueOrEmpty_(rowObj[field]));
}

/**
 * 表头保障
 *
 * 注意：
 * 这里不会自动调整列宽。
 */
function ensureHeaders_(sheet) {
  const currentHeaders = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const needSetup = HEADERS.some((header, i) => currentHeaders[i] !== header);

  if (needSetup) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    clearLegacyColumns_(sheet, Math.max(sheet.getLastRow() - CONFIG.START_ROW + 1, 1));
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.setFrozenRows(1);
  }
}

/**
 * 应用数字格式
 *
 * 注意：
 * 这里不会自动调整列宽。
 */
function applyFormats_(sheet, numRows) {
  if (numRows <= 0) {
    return;
  }

  const startRow = CONFIG.START_ROW;

  // F 最新价/利率
  sheet.getRange(startRow, 6, numRows, 1).setNumberFormat('#,##0.########');

  // G 涨跌幅
  sheet.getRange(startRow, 7, numRows, 1).setNumberFormat('0.00%');

  // H:K 开盘、昨收/24h开盘、最高、最低
  sheet.getRange(startRow, 8, numRows, 4).setNumberFormat('#,##0.########');

  // L 行情时间
  sheet.getRange(startRow, 12, numRows, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');

  // N 脚本刷新时间
  sheet.getRange(startRow, 14, numRows, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
}

/**
 * 清理旧版多余列内容。
 * v3 及之前使用到 S 列；v4 只使用到 N 列。
 */
function clearLegacyColumns_(sheet, numRows) {
  const firstUnusedCol = HEADERS.length + 1;
  const extraCols = LEGACY_MAX_COLUMNS - HEADERS.length;

  if (extraCols <= 0) {
    return;
  }

  sheet.getRange(1, firstUnusedCol, 1, extraCols).clearContent();

  if (numRows > 0) {
    sheet.getRange(CONFIG.START_ROW, firstUnusedCol, numRows, extraCols).clearContent();
  }
}

/**
 * Yahoo marketState 转中文
 */
function translateYahooMarketState_(state) {
  const s = String(state || '').toUpperCase();

  if (s === 'PRE' || s === 'PREPRE') {
    return '盘前';
  }

  if (s === 'REGULAR') {
    return '盘中/常规';
  }

  if (s === 'POST' || s === 'POSTPOST') {
    return '盘后';
  }

  if (s === 'CLOSED') {
    return '休市';
  }

  return s || '';
}

/**
 * 从多个候选报价中取时间最新的一个
 */
function pickLatestQuoteCandidate_(candidates) {
  const valid = candidates.filter(item => item && item.price !== '' && item.quoteTime instanceof Date);

  if (valid.length === 0) {
    return null;
  }

  valid.sort((a, b) => b.quoteTime.getTime() - a.quoteTime.getTime());
  return valid[0];
}

/**
 * 转数字
 */
function toNumber_(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const n = Number(value);
  return isFinite(n) ? n : '';
}

/**
 * 返回第一个有效数字
 */
function firstNumber_() {
  for (let i = 0; i < arguments.length; i++) {
    const n = toNumber_(arguments[i]);

    if (isFiniteNumber_(n)) {
      return n;
    }
  }

  return '';
}

/**
 * 判断是否为有效数字
 */
function isFiniteNumber_(value) {
  return typeof value === 'number' && isFinite(value);
}

/**
 * Unix秒转 Date
 */
function toDateFromUnixSeconds_(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const n = Number(value);

  if (!isFinite(n) || n <= 0) {
    return '';
  }

  return new Date(n * 1000);
}

/**
 * 安全解析 JSON
 */
function safeJsonParse_(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

/**
 * 数组切块
 */
function chunk_(arr, size) {
  const result = [];

  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }

  return result;
}

/**
 * 保留 0 / Date / false，只有 null / undefined 转空字符串
 */
function valueOrEmpty_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return value;
}
