const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '每日总资产.gs'),
  'utf8'
);

test('daily total assets reads the current portfolio total cell', () => {
  assert.match(source, /const SOURCE_SHEET = '百万攒股计划';/);
  assert.match(source, /const SOURCE_CELL = 'B5';/);
  assert.match(source, /sourceSheet\.getRange\(SOURCE_CELL\)\.getValue\(\)/);
  assert.doesNotMatch(source, /const SOURCE_CELL = 'E3';/);
});

test('daily total assets keeps idempotent upsert and derived formulas', () => {
  assert.match(source, /同一天重复执行时更新原记录，不会新增重复日期/);
  assert.match(source, /targetRow = i \+ 2/);
  assert.match(source, /setFormula\(`=B\$\{targetRow\}-B\$\{targetRow - 1\}`\)/);
  assert.match(
    source,
    /`=IFERROR\(C\$\{targetRow\}\/B\$\{targetRow - 1\},\"\"\)`/
  );
});
