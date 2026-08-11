import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDayRangePosition } from '../dayRange';
import { buildTooltip } from '../types';
import { parseSinaCnFields } from './sinaCn';

function createCnFields(overrides: Record<number, string> = {}): string[] {
  const fields = Array.from({ length: 33 }, () => '0');
  fields[0] = '测试股票';
  fields[1] = '10.10';
  fields[2] = '10.00';
  fields[3] = '10.20';
  fields[4] = '10.30';
  fields[5] = '9.90';
  fields[30] = '2026-08-05';
  fields[31] = '10:00:00';
  for (const [index, value] of Object.entries(overrides)) {
    fields[Number(index)] = value;
  }
  return fields;
}

test('A 股正常行情保留最新价和涨跌额', () => {
  const data = parseSinaCnFields('sh600000', createCnFields());

  assert.ok(data);
  assert.equal(data.price, 10.20);
  assert.ok(Math.abs(data.change - 0.20) < Number.EPSILON * 10);
  assert.equal(data.usingPreviousClose, false);

  const tooltip = buildTooltip(data);
  assert.match(tooltip, /涨跌\t10\.000\+0\.200 \(\+2\.00%\)/);
  assert.match(tooltip, /时间\t/);
  assert.doesNotMatch(tooltip, /现价\t|今开\t|昨收\t|最高\t|最低\t|更新\t/);

  const premiumTooltip = buildTooltip({ ...data, iopv: 10 });
  assert.match(premiumTooltip, /溢价\t\+2\.00% \(10\.000\)/);
  assert.doesNotMatch(premiumTooltip, /📈|IOPV\t/);

  const cryptoTooltip = buildTooltip({ ...data, changeBasis: 'open', open: 9.80 });
  assert.match(cryptoTooltip, /涨跌\t9\.800\+0\.200/);
});

test('A 股最新价为 0 时按昨收显示并将涨跌归零', () => {
  const data = parseSinaCnFields('sh600000', createCnFields({
    1: '0.00',
    3: '0.00',
    4: '0.00',
    5: '0.00',
    31: '09:15:00',
  }));

  assert.ok(data);
  assert.equal(data.price, 10.00);
  assert.equal(data.change, 0);
  assert.equal(data.changePercent, 0);
  assert.equal(data.open, 10.00);
  assert.equal(data.high, 10.00);
  assert.equal(data.low, 10.00);
  assert.equal(data.usingPreviousClose, true);
  assert.match(buildTooltip(data), /尚未开市或停牌/);
});

test('日内价格位置按最低价和最高价计算并限制在区间内', () => {
  assert.equal(calculateDayRangePosition(15, 10, 20), 50);
  assert.equal(calculateDayRangePosition(5, 10, 20), 0);
  assert.equal(calculateDayRangePosition(25, 10, 20), 100);
  assert.equal(calculateDayRangePosition(10, 10, 10), 50);
  assert.equal(calculateDayRangePosition(Number.NaN, 10, 20), undefined);
  assert.equal(calculateDayRangePosition(15, 20, 10), undefined);
});
