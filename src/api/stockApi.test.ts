import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateDayRangePosition,
  calculateRangeReferencePosition,
  comparePriceToBasis,
} from '../dayRange';
import { buildTooltip, formatChange, formatPercent } from '../types';
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
  assert.match(tooltip, /涨跌\t\+0\.200 \(\+2\.00%\)/);
  assert.match(tooltip, /时间\t/);
  assert.doesNotMatch(tooltip, /现价\t|今开\t|昨收\t|最高\t|最低\t|更新\t/);

  const premiumTooltip = buildTooltip({ ...data, iopv: 10 });
  assert.match(premiumTooltip, /溢价\t\+2\.00% \(10\.000\)/);
  assert.doesNotMatch(premiumTooltip, /📈|IOPV\t/);

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
  const tooltip = buildTooltip(data);
  assert.match(tooltip, /尚未开市或停牌/);
  assert.match(tooltip, /涨跌\t±0\.000 \(±0\.00%\)/);
});

test('零涨跌额使用正负号占位，避免与基准价格粘连', () => {
  assert.equal(formatChange(0, 3), '±0.000');
  assert.equal(formatChange(-0, 3), '±0.000');
  assert.equal(formatChange(0.0001, 3), '±0.000');
  assert.equal(formatChange(0.001, 3), '+0.001');
  assert.equal(formatChange(-0.001, 3), '-0.001');
});

test('零涨跌幅使用正负号占位，保持侧边栏百分比对齐', () => {
  assert.equal(formatPercent(0), '±0.00%');
  assert.equal(formatPercent(-0), '±0.00%');
  assert.equal(formatPercent(0.001), '±0.00%');
  assert.equal(formatPercent(0.01), '+0.01%');
  assert.equal(formatPercent(-0.01), '-0.01%');
});

test('日内价格位置按最低价和最高价计算并限制在区间内', () => {
  assert.equal(calculateDayRangePosition(15, 10, 20), 50);
  assert.equal(calculateDayRangePosition(5, 10, 20), 0);
  assert.equal(calculateDayRangePosition(25, 10, 20), 100);
  assert.equal(calculateDayRangePosition(10, 10, 10), 50);
  assert.equal(calculateDayRangePosition(Number.NaN, 10, 20), undefined);
  assert.equal(calculateDayRangePosition(15, 20, 10), undefined);
});

test('日内低、现、高价格分别相对涨跌基准判断颜色', () => {
  assert.equal(comparePriceToBasis(24.80, 25), 'fall');
  assert.equal(comparePriceToBasis(25.10, 25), 'rise');
  assert.equal(comparePriceToBasis(25.30, 25), 'rise');
  assert.equal(comparePriceToBasis(25, 25), 'flat');
  assert.equal(comparePriceToBasis(25, 0), 'flat');
});

test('昨收标记在日内区间内定位，跳空时钉在对应边缘', () => {
  assert.deepEqual(calculateRangeReferencePosition(25, 24, 26), {
    position: 50,
    placement: 'inside',
  });
  assert.deepEqual(calculateRangeReferencePosition(23, 24, 26), {
    position: 0,
    placement: 'left',
  });
  assert.deepEqual(calculateRangeReferencePosition(27, 24, 26), {
    position: 100,
    placement: 'right',
  });
  assert.deepEqual(calculateRangeReferencePosition(25, 25, 25), {
    position: 50,
    placement: 'inside',
  });
});
