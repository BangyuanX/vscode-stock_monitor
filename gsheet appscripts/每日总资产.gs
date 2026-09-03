const SPREADSHEET_ID = '1g-SkAccuVV8hfe-Z_mGizxCJeFN1II11UQgTKHoEefE';
const SOURCE_SHEET = '百万攒股计划';
const SOURCE_CELL = 'B5';
const LOG_SHEET = '每日总资产';

/**
 * 每日记录总资产。
 * 同一天重复执行时更新原记录，不会新增重复日期。
 */
function recordDailyTotalAssets() {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const timeZone = ss.getSpreadsheetTimeZone();

    const sourceSheet = ss.getSheetByName(SOURCE_SHEET);
    if (!sourceSheet) {
      throw new Error(`找不到工作表：${SOURCE_SHEET}`);
    }

    SpreadsheetApp.flush();

    const totalAssets = sourceSheet.getRange(SOURCE_CELL).getValue();
    if (typeof totalAssets !== 'number' || !Number.isFinite(totalAssets)) {
      throw new Error(
        `${SOURCE_SHEET}!${SOURCE_CELL} 不是有效数字，当前值：${totalAssets}`
      );
    }

    const logSheet =
      ss.getSheetByName(LOG_SHEET) || createLogSheet_(ss);

    ensureHeaders_(logSheet);

    const today = Utilities.formatDate(
      new Date(),
      timeZone,
      'yyyy-MM-dd'
    );

    const lastRow = Math.max(logSheet.getLastRow(), 1);
    let targetRow = null;

    if (lastRow >= 2) {
      const dates = logSheet
        .getRange(2, 1, lastRow - 1, 1)
        .getValues();

      for (let i = 0; i < dates.length; i++) {
        if (normalizeDate_(dates[i][0], timeZone) === today) {
          targetRow = i + 2;
          break;
        }
      }
    }

    // 当天不存在时，在末尾追加。
    if (targetRow === null) {
      targetRow = Math.max(lastRow + 1, 2);
    }

    const [year, month, day] = today.split('-').map(Number);

    // Google Sheets 日期序列：1970-01-01 对应 25569。
    const dateSerial =
      Date.UTC(year, month - 1, day) / 86400000 + 25569;

    logSheet.getRange(targetRow, 1).setValue(dateSerial);
    logSheet.getRange(targetRow, 2).setValue(totalAssets);

    if (targetRow === 2) {
      logSheet.getRange(targetRow, 3, 1, 2).clearContent();
    } else {
      logSheet
        .getRange(targetRow, 3)
        .setFormula(`=B${targetRow}-B${targetRow - 1}`);

      logSheet
        .getRange(targetRow, 4)
        .setFormula(
          `=IFERROR(C${targetRow}/B${targetRow - 1},"")`
        );
    }

    // 设置显示格式。
    logSheet
      .getRange(targetRow, 1)
      .setNumberFormat('yyyy-mm-dd');

    logSheet
      .getRange(targetRow, 2, 1, 2)
      .setNumberFormat('¥#,##0.00;-¥#,##0.00');

    logSheet
      .getRange(targetRow, 4)
      .setNumberFormat('0.00%;-0.00%');

    SpreadsheetApp.flush();

    console.log(`${today} 总资产已记录：${totalAssets}`);
  } finally {
    lock.releaseLock();
  }
}

function createLogSheet_(ss) {
  const sheet = ss.insertSheet(LOG_SHEET);
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 1, 110);
  sheet.setColumnWidths(2, 2, 130);
  sheet.setColumnWidth(4, 120);
  return sheet;
}

function ensureHeaders_(sheet) {
  sheet
    .getRange('A1:D1')
    .setValues([[
      '日期',
      '总资产',
      '较前日变化',
      '较前日变化率'
    ]])
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setBackground('#e6e6e6');

  sheet.setFrozenRows(1);
}

function normalizeDate_(value, timeZone) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  }

  return String(value)
    .trim()
    .slice(0, 10)
    .replace(/\//g, '-');
}
