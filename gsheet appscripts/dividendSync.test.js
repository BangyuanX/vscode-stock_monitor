const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDividendSync() {
  const source = fs.readFileSync(path.join(__dirname, 'dividendSync.gs'), 'utf8');
  const context = vm.createContext({
    Date,
    JSON,
    Number,
    String,
    RegExp,
    Array,
    Math,
    isNaN,
    Utilities: {
      formatDate(value) {
        return value.toISOString().slice(0, 10).replace(/-/g, '');
      }
    }
  });

  vm.runInContext(
    source + '\n;globalThis.__dividendTest = {' +
      'dividendNormalizeEvent_,' +
      'dividendBuildEventId_,' +
      'dividendApiDateToDate_,' +
      'dividendCalculateReinvestShares_,' +
      'dividendInferAssetType_' +
      '};',
    context,
    { filename: 'dividendSync.gs' }
  );
  return context.__dividendTest;
}

test('fund dividend keeps reinvestment dates and deterministic event id', () => {
  const sync = loadDividendSync();
  const config = { code: '022951.OF' };
  const event = sync.dividendNormalizeEvent_({
    ann_date: '20260801',
    imp_anndate: '20260810',
    div_proc: '实施',
    record_date: '20260815',
    ex_date: '20260816',
    net_ex_date: '20260816',
    account_date: '20260818',
    div_cash: 0.05
  }, config, false);

  assert.equal(event.cashPerUnit, 0.05);
  assert.equal(event.accountDate, '20260818');
  assert.equal(event.eventId, '022951.OF|20260815|0.05000000|0.00000000');
});

test('stock dividends include stock distribution ratio in event id', () => {
  const sync = loadDividendSync();
  const event = sync.dividendNormalizeEvent_({
    imp_ann_date: '20260810',
    div_proc: '实施',
    record_date: '20260815',
    cash_div_tax: 0.2,
    stk_div: 0.1
  }, { code: '600036.SH' }, true);

  assert.equal(event.eventId, '600036.SH|20260815|0.20000000|0.10000000');
});

test('canonical suffix determines asset type', () => {
  const sync = loadDividendSync();

  assert.equal(sync.dividendInferAssetType_('022951.OF'), '场外基金');
  assert.equal(sync.dividendInferAssetType_('513820.SH'), 'ETF');
  assert.equal(sync.dividendInferAssetType_('600036.SH'), '股票');
});

test('reinvestment rounds cash to cents before converting to bank shares', () => {
  const sync = loadDividendSync();

  const events = [
    [1.6473, 21.78],
    [1.6360, 21.99],
    [1.6057, 22.47],
    [1.5348, 23.59],
    [1.6051, 22.62]
  ];
  let holdings = 7173.16;

  events.forEach(([nav, expectedShares]) => {
    const shares = sync.dividendCalculateReinvestShares_(holdings, 0.005, nav);
    assert.equal(shares, expectedShares);
    holdings = Math.round((holdings + shares) * 100) / 100;
  });

  assert.equal(holdings, 7285.61);
  assert.equal(sync.dividendCalculateReinvestShares_(0, 0.005, 1.6051), '');
  assert.equal(sync.dividendCalculateReinvestShares_(7173.16, 0.005, ''), '');
});

test('reinvestment transaction cash flow is explicitly zero', () => {
  const source = fs.readFileSync(path.join(__dirname, 'dividendSync.gs'), 'utf8');
  assert.match(source, /=\\\"红利再投\\\",0,-G/);
});

test('bank-verified dividend rows keep their reviewed progress and source', () => {
  const source = fs.readFileSync(path.join(__dirname, 'dividendSync.gs'), 'utf8');
  assert.match(source, /existingSource && existingSource !== 'Tushare' && existingProgress/);
  assert.match(source, /existingSource \|\| 'Tushare'/);
  assert.match(
    source,
    /setValue\(holdings\);\s*\n\s*if \(existingSource === 'Tushare'\)/
  );
});

test('all distribution methods scan from the first transaction date', () => {
  const source = fs.readFileSync(path.join(__dirname, 'dividendSync.gs'), 'utf8');
  const body = source.match(/function dividendHistoryCutoff_\(config\) \{([\s\S]*?)\n\}/)[1];

  assert.match(body, /dividendFirstTransactionDate_\(config\)/);
  assert.doesNotMatch(body, /distributionMethod/);
});
