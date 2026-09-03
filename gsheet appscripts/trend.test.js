const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTrend() {
  const properties = new Map();
  const source = fs.readFileSync(path.join(__dirname, 'trend.gs'), 'utf8');
  const context = vm.createContext({
    console,
    Date,
    JSON,
    Math,
    RegExp,
    String,
    Number,
    Object,
    Array,
    isFinite,
    isNaN,
    encodeURIComponent,
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            return properties.has(key) ? properties.get(key) : null;
          },
          setProperty(key, value) {
            properties.set(key, value);
          }
        };
      }
    }
  });

  vm.runInContext(
    source +
      '\n;globalThis.__trendTest = {' +
      'resolveInstrument_,' +
      'parseOpenFundNavResponse_,' +
      'saveOpenFundNavQuote_,' +
      'getCachedOpenFundNavQuote_' +
      '};',
    context,
    { filename: 'trend.gs' }
  );

  return context.__trendTest;
}

test('market suffix routes mainland securities without a category column', () => {
  const trend = loadTrend();
  const fund = trend.resolveInstrument_('022951.OF');
  const etf = trend.resolveInstrument_('159696.SZ');
  const stock = trend.resolveInstrument_('600036.SH');

  assert.equal(fund.source, 'OPEN_FUND_NAV');
  assert.equal(fund.standardCode, '022951.OF');
  assert.equal(fund.displayName, '华泰柏瑞中证红利低波ETF联接Y');
  assert.equal(etf.source, 'SINA');
  assert.equal(etf.apiSymbol, 'sz159696');
  assert.equal(etf.standardCode, '159696.SZ');
  assert.equal(stock.apiSymbol, 'sh600036');
});

test('legacy six-digit inputs remain compatible during migration', () => {
  const trend = loadTrend();
  const fund = trend.resolveInstrument_('016452');
  const etf = trend.resolveInstrument_('159696');

  assert.equal(fund.source, 'OPEN_FUND_NAV');
  assert.equal(etf.source, 'SINA');
  assert.equal(fund.standardCode, '016452.OF');
  assert.equal(etf.standardCode, '159696.SZ');
});

test('official NAV rows are mapped to the shared quote fields', () => {
  const trend = loadTrend();
  const inst = trend.resolveInstrument_('016452.OF');
  const quote = trend.parseOpenFundNavResponse_(
    {
      ErrCode: 0,
      Data: {
        LSJZList: [
          { FSRQ: '2026-08-31', DWJZ: '2.2876', JZZZL: '0.10' },
          { FSRQ: '2026-08-28', DWJZ: '2.2854', JZZZL: '-0.70' }
        ]
      }
    },
    inst
  );

  assert.equal(quote.price, 2.2876);
  assert.equal(quote.prevClose, 2.2854);
  assert.equal(quote.changePct, 0.001);
  assert.equal(quote.phase, '已公布净值(QDII)');
  assert.match(quote.status, /非盘中估值/);
});

test('a failed refresh can reuse the last successful fund NAV', () => {
  const trend = loadTrend();
  const inst = trend.resolveInstrument_('016452.OF');
  const quote = trend.parseOpenFundNavResponse_(
    {
      ErrCode: 0,
      Data: {
        LSJZList: [
          { FSRQ: '2026-08-31', DWJZ: '2.2876', JZZZL: '0.10' },
          { FSRQ: '2026-08-28', DWJZ: '2.2854', JZZZL: '-0.70' }
        ]
      }
    },
    inst
  );

  trend.saveOpenFundNavQuote_(inst, quote);
  const cached = trend.getCachedOpenFundNavQuote_(inst, 'HTTP 503');

  assert.equal(cached.price, 2.2876);
  assert.equal(cached.prevClose, 2.2854);
  assert.equal(cached.phase, '上次表格净值(QDII)');
  assert.match(cached.status, /沿用行情页最近一次成功数据/);
});
