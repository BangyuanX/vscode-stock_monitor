import assert from 'node:assert/strict';
import test from 'node:test';
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
