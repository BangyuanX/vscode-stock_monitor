/**
 * Tushare 分红增量同步。
 *
 * 安全边界：
 * 1. TUSHARE_TOKEN 只从 Apps Script 的 Script Properties 读取，不写入代码或表格。
 * 2. 只把“实施”阶段的分红写入正式明细，预案不参与收益计算。
 * 3. 红利再投会按登记日持仓、每份分红和确认净值生成零现金流份额记录；
 *    已有关联事件的交易行不会被覆盖，便于用户按银行实际到账份额修正。
 */

const DIVIDEND_SYNC_CONFIG = {
  MASTER_SHEET: '红利ETF分红明细',
  CONFIG_SHEET: '分红监控配置',
  LOG_SHEET: '分红同步日志',
  TRANSACTION_SHEET: '交易明细',
  PORTFOLIO_SHEET: '百万攒股计划',
  TOKEN_PROPERTY: 'TUSHARE_TOKEN',
  API_URL: 'https://api.tushare.pro',
  LOOKBACK_DAYS: 45,
  TIMEZONE: 'Asia/Shanghai'
};

const DIVIDEND_EXTRA_HEADERS = [
  '资产类型',
  '分红方式',
  '方案进度',
  '账户',
  '数据来源',
  '实际现金到账',
  '再投确认净值',
  '再投新增份额（实际/理论）',
  '再投到账日',
  '事件ID',
  '最后同步时间'
];

const DIVIDEND_CONFIG_HEADERS = [
  '启用',
  '统一代码',
  '名称',
  '资产类型',
  'Tushare代码',
  '账户',
  '分红方式',
  '备注'
];

const DIVIDEND_LOG_HEADERS = [
  '运行时间',
  '结果',
  '检查品种数',
  '新增事件数',
  '更新事件数',
  '说明'
];

const DIVIDEND_DEFAULT_WATCHLIST = [
  [true, '513530.SH', '港股通红利ETF华泰柏瑞', 'ETF', '513530.SH', '', '现金', ''],
  [true, '513820.SH', '港股通红利ETF汇添富', 'ETF', '513820.SH', '', '现金', ''],
  [true, '561580.SH', '央企红利ETF华泰柏瑞', 'ETF', '561580.SH', '', '现金', ''],
  [true, '600036.SH', '招商银行', '股票', '600036.SH', '', '现金', ''],
  [true, '600900.SH', '长江电力', '股票', '600900.SH', '', '现金', ''],
  [true, '000895.SZ', '双汇发展', '股票', '000895.SZ', '', '现金', ''],
  [true, '022951.OF', '华泰柏瑞中证红利低波ETF联接Y', '场外基金', '022951.OF', '个人养老金', '红利再投', '实际入账份额以养老金账户确认为准']
];

function setupDividendMonitoring() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configSheet = dividendEnsureSheet_(ss, DIVIDEND_SYNC_CONFIG.CONFIG_SHEET, 100, 8);
  const logSheet = dividendEnsureSheet_(ss, DIVIDEND_SYNC_CONFIG.LOG_SHEET, 500, 6);
  const masterSheet = ss.getSheetByName(DIVIDEND_SYNC_CONFIG.MASTER_SHEET);
  const transactionSheet = ss.getSheetByName(DIVIDEND_SYNC_CONFIG.TRANSACTION_SHEET);
  const portfolioSheet = ss.getSheetByName(DIVIDEND_SYNC_CONFIG.PORTFOLIO_SHEET);

  if (!masterSheet || !transactionSheet || !portfolioSheet) {
    throw new Error('缺少“红利ETF分红明细”“交易明细”或“百万攒股计划”工作表');
  }

  dividendSetupConfigSheet_(configSheet);
  dividendSetupLogSheet_(logSheet);
  dividendSetupMasterSheet_(masterSheet);
  dividendSetupTransactionSheet_(transactionSheet);
  dividendSetupPersonalPensionSection_(portfolioSheet);
}

function syncDividendsDaily() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    throw new Error('已有分红同步任务正在运行');
  }

  const startedAt = new Date();
  let checked = 0;
  let inserted = 0;
  let updated = 0;
  const errors = [];

  try {
    setupDividendMonitoring();

    const token = PropertiesService.getScriptProperties().getProperty(
      DIVIDEND_SYNC_CONFIG.TOKEN_PROPERTY
    );

    if (!token) {
      throw new Error('Script Properties 中尚未设置 TUSHARE_TOKEN');
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const master = ss.getSheetByName(DIVIDEND_SYNC_CONFIG.MASTER_SHEET);
    const configs = dividendReadEnabledConfigs_(
      ss.getSheetByName(DIVIDEND_SYNC_CONFIG.CONFIG_SHEET)
    );
    const existing = dividendReadExistingEvents_(master);

    configs.forEach(config => {
      checked += 1;

      try {
        const events = dividendFetchImplementedEvents_(config, token);

        events.forEach(event => {
          const rowNumber = existing[event.eventId];

          if (rowNumber) {
            dividendUpdateSyncedMetadata_(master, rowNumber, event, config, startedAt);
            updated += 1;
            return;
          }

          const targetRow = dividendFindNextRow_(master);
          dividendWriteNewEvent_(master, targetRow, event, config, startedAt);
          existing[event.eventId] = targetRow;
          inserted += 1;
        });
      } catch (err) {
        errors.push(config.code + '：' + String(err && err.message ? err.message : err));
      }
    });

    dividendAppendLog_(
      startedAt,
      errors.length ? '部分成功' : '成功',
      checked,
      inserted,
      updated,
      errors.join('；') || '无新增也属于正常结果'
    );
  } catch (err) {
    dividendAppendLog_(startedAt, '失败', checked, inserted, updated, String(err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function createDailyDividendTrigger() {
  deleteDividendTriggers();
  ScriptApp.newTrigger('syncDividendsDaily')
    .timeBased()
    .atHour(21)
    .everyDays(1)
    .inTimezone(DIVIDEND_SYNC_CONFIG.TIMEZONE)
    .create();
}

function deleteDividendTriggers() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'syncDividendsDaily') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function dividendEnsureSheet_(ss, name, rows, columns) {
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name, ss.getNumSheets(), { rows, columns });
  }

  return sheet;
}

function dividendSetupConfigSheet_(sheet) {
  sheet.getRange(1, 1, 1, DIVIDEND_CONFIG_HEADERS.length).setValues([DIVIDEND_CONFIG_HEADERS]);
  // 统一代码保留市场后缀，文本格式也能稳定保存 000895 / 022951 的前导零。
  sheet.getRange('B:B').setNumberFormat('@');

  const hasConfig = sheet.getLastRow() > 1 && sheet.getRange(2, 2).getDisplayValue();

  if (!hasConfig) {
    sheet.getRange(2, 1, DIVIDEND_DEFAULT_WATCHLIST.length, DIVIDEND_CONFIG_HEADERS.length)
      .setValues(DIVIDEND_DEFAULT_WATCHLIST);
  }

  const assetRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['股票', 'ETF', '场外基金'], true)
    .setAllowInvalid(false)
    .build();
  const methodRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['现金', '红利再投', '送股/转增'], true)
    .setAllowInvalid(false)
    .build();

  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).insertCheckboxes();
  sheet.getRange(2, 4, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(assetRule);
  sheet.getRange(2, 7, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(methodRule);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, DIVIDEND_CONFIG_HEADERS.length)
    .setBackground('#1f4e3d')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.autoResizeColumns(1, DIVIDEND_CONFIG_HEADERS.length);
}

function dividendSetupLogSheet_(sheet) {
  sheet.getRange(1, 1, 1, DIVIDEND_LOG_HEADERS.length).setValues([DIVIDEND_LOG_HEADERS]);
  sheet.getRange(1, 1, 1, DIVIDEND_LOG_HEADERS.length)
    .setBackground('#5b6573')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.setFrozenRows(1);
}

function dividendSetupMasterSheet_(sheet) {
  // 分红主表代码列必须始终保留六位前导零。
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange(1, 22, 1, DIVIDEND_EXTRA_HEADERS.length).setValues([DIVIDEND_EXTRA_HEADERS]);
  sheet.getRange(1, 22, 1, DIVIDEND_EXTRA_HEADERS.length)
    .setBackground('#1f4e3d')
    .setFontColor('#ffffff')
    .setFontWeight('bold');

  const lastRow = Math.max(sheet.getLastRow(), 2);
  const codes = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  const dates = sheet.getRange(2, 3, lastRow - 1, 12).getValues();
  const extras = sheet.getRange(2, 22, lastRow - 1, DIVIDEND_EXTRA_HEADERS.length).getValues();
  const now = new Date();
  let changed = false;

  codes.forEach((row, index) => {
    const code = String(row[0] || '').trim();

    if (!code) {
      return;
    }

    const assetType = dividendInferAssetType_(code);
    const recordDate = dates[index][6];
    const exDate = dates[index][10];
    const annDate = dates[index][0];
    const cash = dates[index][3];

    if (!extras[index][0]) {
      extras[index][0] = assetType;
      changed = true;
    }
    if (!extras[index][1]) {
      extras[index][1] = '现金';
      changed = true;
    }
    if (!extras[index][2]) {
      extras[index][2] = '历史手工记录';
      changed = true;
    }
    if (!extras[index][4]) {
      extras[index][4] = '手工历史';
      changed = true;
    }
    if (!extras[index][9]) {
      extras[index][9] = dividendBuildEventId_(code, recordDate || exDate || annDate, cash, 0);
      changed = true;
    }
    if (!extras[index][10]) {
      extras[index][10] = now;
      changed = true;
    }
  });

  if (changed) {
    sheet.getRange(2, 22, extras.length, DIVIDEND_EXTRA_HEADERS.length).setValues(extras);
  }

  dividendGuardBlankFormulaRows_(sheet, codes);

  sheet.getRange(2, 27, Math.max(sheet.getMaxRows() - 1, 1), 3)
    .setNumberFormat('#,##0.########');
  sheet.getRange(2, 30, Math.max(sheet.getMaxRows() - 1, 1), 1)
    .setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, 31, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  sheet.getRange(2, 32, Math.max(sheet.getMaxRows() - 1, 1), 1)
    .setNumberFormat('yyyy-mm-dd hh:mm:ss');
}

function dividendGuardBlankFormulaRows_(sheet, codes) {
  const columns = [8, 11, 12, 15, 16, 17, 18];
  const builders = [
    row => '=IF($A' + row + '="","",$G' + row + '/10000)',
    row => '=IF($A' + row + '="","",$J' + row + '*$F' + row + ')',
    row => '=IFERROR(IF($A' + row + '="","",$K' + row + '/$H' + row + '),"")',
    row => '=IF($A' + row + '="","",$E' + row + '*10000)',
    row => '=IF($A' + row + '="","",$F' + row + '*10000)',
    row => '=IFERROR(IF($A' + row + '="","",10000/$E' + row + '*$F' + row + '),"")',
    row => '=IFERROR(IF($A' + row + '="","",$F' + row + '/$E' + row + '),"")'
  ];

  columns.forEach((column, builderIndex) => {
    const range = sheet.getRange(2, column, codes.length, 1);
    const formulas = range.getFormulas();

    codes.forEach((codeRow, index) => {
      if (!String(codeRow[0] || '').trim()) {
        formulas[index][0] = builders[builderIndex](index + 2);
      }
    });
    range.setFormulas(formulas);
  });
}

function dividendSetupTransactionSheet_(sheet) {
  if (sheet.getMaxColumns() < 16) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 16 - sheet.getMaxColumns());
  }

  sheet.getRange(1, 15, 1, 2).setValues([['账户', '关联分红事件ID']]);
  const rowCount = Math.max(sheet.getMaxRows() - 1, 1);
  const tradeRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['买入', '卖出', '红利再投', '送股/转增', '份额折算'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 6, rowCount, 1).setDataValidation(tradeRule);
  sheet.getRange(2, 16, rowCount, 1).setNumberFormat('@');

  const cashFlowFormulas = [];
  for (let row = 2; row <= sheet.getMaxRows(); row += 1) {
    cashFlowFormulas.push([
      '=IF(C' + row + '=\"\",\"\",IF(F' + row + '=\"红利再投\",0,-G' + row + '*H' + row + '-I' + row + '))'
    ]);
  }
  sheet.getRange(2, 10, cashFlowFormulas.length, 1).setFormulas(cashFlowFormulas);
}

function dividendSetupPersonalPensionSection_(sheet) {
  const title = '个人养老金（不计入总资产）';
  const usdTitle = '美元资产（加密 + 美股）';
  let titleRow = dividendFindLabelRow_(sheet, title);

  if (!titleRow) {
    const usdRow = dividendFindLabelRow_(sheet, usdTitle);

    if (!usdRow) {
      throw new Error('“百万攒股计划”中找不到美元资产区块');
    }

    sheet.insertRowsBefore(usdRow, 6);
    titleRow = usdRow;

    sheet.getRange(6, 1, 1, 12).copyTo(
      sheet.getRange(titleRow, 1, 1, 12),
      SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
      false
    );
    sheet.getRange(7, 1, 1, 12).copyTo(
      sheet.getRange(titleRow + 1, 1, 1, 12),
      SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
      false
    );
    sheet.getRange(8, 1, 3, 12).copyTo(
      sheet.getRange(titleRow + 2, 1, 3, 12),
      SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
      false
    );
    sheet.getRange(20, 1, 1, 12).copyTo(
      sheet.getRange(titleRow + 5, 1, 1, 12),
      SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
      false
    );
  }

  // 主区块排除个人养老金；顶部总资产因此只包含可支配投资资产。
  sheet.getRange(8, 1).setFormula(
    '=IFERROR(SORT(UNIQUE(FILTER(\'交易明细\'!$A$2:$A,\'交易明细\'!$N$2:$N=\"持仓中\",REGEXMATCH(\'交易明细\'!$C$2:$C,\"^\\d{6}\\.(SH|SZ|BJ|OF)$\"),\'交易明细\'!$O$2:$O<>\"个人养老金\")),1,FALSE),\"\")'
  );

  const headers = sheet.getRange(7, 1, 1, 12).getValues();
  const firstDataRow = titleRow + 2;
  const lastDataRow = titleRow + 4;
  const subtotalRow = titleRow + 5;

  sheet.getRange(titleRow, 1, 1, 12).clearContent();
  if (!sheet.getRange(titleRow, 1, 1, 12).isPartOfMerge()) {
    sheet.getRange(titleRow, 1, 1, 12).merge();
  }
  sheet.getRange(titleRow, 1).setValue(title);
  sheet.getRange(titleRow + 1, 1, 1, 12).setValues(headers);
  sheet.getRange(firstDataRow, 1, 3, 12).clearContent();
  sheet.getRange(firstDataRow, 1).setFormula(
    '=IFERROR(SORT(UNIQUE(FILTER(\'交易明细\'!$A$2:$A,\'交易明细\'!$N$2:$N=\"持仓中\",\'交易明细\'!$O$2:$O=\"个人养老金\")),1,FALSE),\"\")'
  );

  for (let row = firstDataRow; row <= lastDataRow; row += 1) {
    sheet.getRange(row, 2, 1, 11).setFormulas([[
      '=IF($A' + row + '=\"\",\"\",IFNA(XLOOKUP(REGEXREPLACE($A' + row + ',\"-\\d+$\",\"\"),\'行情\'!$A:$A,\'行情\'!$C:$C),\"\"))',
      '=IF($A' + row + '=\"\",\"\",SUMIFS(\'交易明细\'!$H$2:$H,\'交易明细\'!$A$2:$A,$A' + row + ',\'交易明细\'!$O$2:$O,\"个人养老金\"))',
      '=IF($A' + row + '=\"\",\"\",MIN(FILTER(\'交易明细\'!$E$2:$E,\'交易明细\'!$A$2:$A=$A' + row + ',\'交易明细\'!$O$2:$O=\"个人养老金\")))',
      '=IFERROR(-SUMIFS(\'交易明细\'!$J$2:$J,\'交易明细\'!$A$2:$A,$A' + row + ',\'交易明细\'!$O$2:$O,\"个人养老金\")/$C' + row + ',\"\")',
      '=IF($A' + row + '=\"\",\"\",IFNA(XLOOKUP(REGEXREPLACE($A' + row + ',\"-\\d+$\",\"\"),\'行情\'!$A:$A,\'行情\'!$F:$F),\"\"))',
      '=IF($A' + row + '=\"\",\"\",$F' + row + '*$C' + row + ')',
      '=IF($A' + row + '=\"\",\"\",($F' + row + '-$E' + row + ')*$C' + row + ')',
      '=IFERROR(($F' + row + '-$E' + row + ')/$E' + row + ',\"\")',
      '=IF($A' + row + '=\"\",\"\",0)',
      '=IF($A' + row + '=\"\",\"\",IFERROR($F' + row + '*$C' + row + '-IFNA(XLOOKUP(REGEXREPLACE($A' + row + ',\"-\\d+$\",\"\"),\'行情\'!$A:$A,\'行情\'!$I:$I),$F' + row + ')*($C' + row + '-SUMIFS(\'交易明细\'!$H$2:$H,\'交易明细\'!$A$2:$A,$A' + row + ',\'交易明细\'!$E$2:$E,TODAY(),\'交易明细\'!$O$2:$O,\"个人养老金\"))+SUMIFS(\'交易明细\'!$J$2:$J,\'交易明细\'!$A$2:$A,$A' + row + ',\'交易明细\'!$E$2:$E,TODAY(),\'交易明细\'!$O$2:$O,\"个人养老金\"),\"\"))',
      '=IF($A' + row + '=\"\",\"\",IFNA(XLOOKUP(REGEXREPLACE($A' + row + ',\"-\\d+$\",\"\"),\'行情\'!$A:$A,\'行情\'!$G:$G),\"\"))'
    ]]);
  }

  sheet.getRange(subtotalRow, 1, 1, 12).clearContent();
  sheet.getRange(subtotalRow, 1).setValue('个人养老金小计（不计入总资产）');
  sheet.getRange(subtotalRow, 7).setFormula('=SUM(G' + firstDataRow + ':G' + lastDataRow + ')');
  sheet.getRange(subtotalRow, 8).setFormula('=SUM(H' + firstDataRow + ':H' + lastDataRow + ')');
  sheet.getRange(subtotalRow, 10).setValue(0);
  sheet.getRange(subtotalRow, 11).setFormula('=SUM(K' + firstDataRow + ':K' + lastDataRow + ')');
}

function dividendFindLabelRow_(sheet, label) {
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getDisplayValues();
  const index = values.findIndex(row => String(row[0] || '').trim() === label);
  return index >= 0 ? index + 1 : 0;
}

function dividendReadEnabledConfigs_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  return sheet.getRange(2, 1, lastRow - 1, DIVIDEND_CONFIG_HEADERS.length).getValues()
    .filter(row => row[0] === true && String(row[1] || '').trim())
    .map(row => ({
      code: String(row[1] || '').trim().toUpperCase(),
      name: String(row[2] || '').trim(),
      assetType: String(row[3] || '').trim(),
      tsCode: String(row[4] || row[1] || '').trim().toUpperCase(),
      account: String(row[5] || '').trim(),
      distributionMethod: String(row[6] || '').trim() || '现金'
    }));
}

function dividendFetchImplementedEvents_(config, token) {
  const isStock = config.assetType === '股票';
  const apiName = isStock ? 'dividend' : 'fund_div';
  const fields = isStock
    ? 'ts_code,end_date,ann_date,div_proc,stk_div,stk_bo_rate,stk_co_rate,cash_div,cash_div_tax,record_date,ex_date,pay_date,div_listdate,imp_ann_date,base_date,base_share'
    : 'ts_code,ann_date,imp_anndate,base_date,div_proc,record_date,ex_date,pay_date,earpay_date,net_ex_date,div_cash,base_unit,ear_distr,ear_amount,account_date,base_year';
  const rows = dividendCallTushareApi_(apiName, { ts_code: config.tsCode }, fields, token);
  const cutoff = dividendHistoryCutoff_(config);

  return rows
    .map(row => dividendNormalizeEvent_(row, config, isStock))
    .filter(event => event && String(event.progress || '').indexOf('实施') >= 0)
    .filter(event => {
      const relevant = dividendParseApiDate_(event.implementationDate || event.announcementDate || event.recordDate);
      return relevant && relevant.getTime() >= cutoff.getTime();
    })
    // 主表只收录真实持有期间享有权益的事件；持仓为零的市场分红不计入个人账本。
    .filter(event => dividendHoldingsOnDate_(config, event.recordDate || event.exDate) > 0)
    .sort((a, b) => dividendEventTime_(a) - dividendEventTime_(b));
}

function dividendHistoryCutoff_(config) {
  // 现金分红与红利再投都从该账户首次交易日起扫描，覆盖完整持有历史。
  const firstTrade = dividendFirstTransactionDate_(config);
  if (firstTrade) return firstTrade;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DIVIDEND_SYNC_CONFIG.LOOKBACK_DAYS);
  return cutoff;
}

function dividendFirstTransactionDate_(config) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    DIVIDEND_SYNC_CONFIG.TRANSACTION_SHEET
  );
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return null;

  const rows = sheet.getRange(2, 3, lastRow - 1, 13).getValues();
  const dates = rows
    .filter(row => {
      const code = String(row[0] || '').trim();
      const account = String(row[12] || '').trim();
      return code === config.code && (!config.account || account === config.account);
    })
    .map(row => row[2])
    .filter(value => value instanceof Date && !isNaN(value.getTime()));

  if (!dates.length) return null;
  return new Date(Math.min.apply(null, dates.map(date => date.getTime())));
}

function dividendEventTime_(event) {
  const date = dividendParseApiDate_(
    event.recordDate || event.exDate || event.implementationDate || event.announcementDate
  );
  return date ? date.getTime() : 0;
}

function dividendCallTushareApi_(apiName, params, fields, token) {
  const response = UrlFetchApp.fetch(DIVIDEND_SYNC_CONFIG.API_URL, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({ api_name: apiName, token, params, fields })
  });
  const text = response.getContentText();

  if (response.getResponseCode() !== 200) {
    throw new Error('Tushare HTTP ' + response.getResponseCode());
  }

  const data = JSON.parse(text);

  if (data.code !== 0) {
    throw new Error('Tushare ' + data.code + '：' + String(data.msg || '未知错误'));
  }

  const names = data.data && Array.isArray(data.data.fields) ? data.data.fields : [];
  const items = data.data && Array.isArray(data.data.items) ? data.data.items : [];

  return items.map(item => {
    const row = {};
    names.forEach((name, index) => { row[name] = item[index]; });
    return row;
  });
}

function dividendNormalizeEvent_(row, config, isStock) {
  const cash = Number(isStock ? (row.cash_div_tax || row.cash_div || 0) : (row.div_cash || 0));
  const stockRatio = Number(isStock ? (row.stk_div || 0) : 0);
  const recordDate = row.record_date || '';
  const exDate = row.ex_date || '';
  const announcementDate = isStock ? (row.imp_ann_date || row.ann_date || '') : (row.imp_anndate || row.ann_date || '');
  const keyDate = recordDate || exDate || announcementDate;

  if (!keyDate || (!cash && !stockRatio)) {
    return null;
  }

  return {
    eventId: dividendBuildEventId_(config.code, keyDate, cash, stockRatio),
    announcementDate: row.ann_date || '',
    implementationDate: isStock ? (row.imp_ann_date || '') : (row.imp_anndate || ''),
    baseDate: row.base_date || '',
    progress: row.div_proc || '',
    recordDate,
    exDate,
    payDate: isStock ? (row.pay_date || '') : (row.pay_date || row.earpay_date || ''),
    netExDate: isStock ? '' : (row.net_ex_date || row.ex_date || ''),
    accountDate: isStock ? (row.div_listdate || '') : (row.account_date || ''),
    cashPerUnit: cash,
    stockRatio,
    baseUnit: isStock ? (row.base_share || '') : (row.base_unit || ''),
    distributableProfit: isStock ? '' : (row.ear_distr || ''),
    distributionAmount: isStock ? '' : (row.ear_amount || '')
  };
}

function dividendReadExistingEvents_(sheet) {
  const lastRow = sheet.getLastRow();
  const map = {};

  if (lastRow < 2) {
    return map;
  }

  sheet.getRange(2, 31, lastRow - 1, 1).getDisplayValues().forEach((row, index) => {
    const id = String(row[0] || '').trim();
    if (id) map[id] = index + 2;
  });
  return map;
}

function dividendFindNextRow_(sheet) {
  const codes = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1).getDisplayValues();
  const index = codes.findIndex(row => !String(row[0] || '').trim());

  if (index >= 0) {
    return index + 2;
  }

  sheet.insertRowAfter(sheet.getMaxRows());
  return sheet.getMaxRows();
}

function dividendWriteNewEvent_(sheet, row, event, config, syncedAt) {
  const holdings = dividendHoldingsOnDate_(config, event.recordDate || event.exDate);
  const reinvestNav = config.distributionMethod === '红利再投'
    ? dividendFetchFundNav_(config.tsCode, event.netExDate || event.exDate)
    : '';
  const reinvestShares = dividendCalculateReinvestShares_(
    holdings,
    event.cashPerUnit,
    reinvestNav
  );
  const progress = config.distributionMethod === '红利再投'
    ? event.progress + '；理论份额待核对'
    : event.progress;
  const values = new Array(32).fill('');

  values[0] = config.code;
  values[2] = dividendApiDateToDate_(event.announcementDate || event.implementationDate);
  values[3] = dividendApiDateToDate_(event.baseDate);
  values[5] = event.cashPerUnit;
  values[6] = event.distributableProfit;
  values[8] = dividendApiDateToDate_(event.recordDate);
  values[9] = event.baseUnit;
  values[12] = dividendApiDateToDate_(event.exDate);
  values[13] = dividendApiDateToDate_(event.payDate);
  values[18] = holdings;
  values[21] = config.assetType;
  values[22] = config.distributionMethod;
  values[23] = progress;
  values[24] = config.account;
  values[25] = 'Tushare';
  values[27] = reinvestNav;
  values[28] = reinvestShares;
  values[29] = dividendApiDateToDate_(event.accountDate);
  values[30] = event.eventId;
  values[31] = syncedAt;

  sheet.getRange(row, 1).setNumberFormat('@');
  sheet.getRange(row, 1, 1, values.length).setValues([values]);
  sheet.getRange(row, 2).setFormula('=IF($A' + row + '="","",IFNA(XLOOKUP($A' + row + ',行情!$A:$A,行情!$C:$C),""))');
  sheet.getRange(row, 8).setFormula('=IF($A' + row + '="","",$G' + row + '/10000)');
  sheet.getRange(row, 11).setFormula('=IF($A' + row + '="","",$J' + row + '*$F' + row + ')');
  sheet.getRange(row, 12).setFormula('=IFERROR(IF($A' + row + '="","",$K' + row + '/$H' + row + '),"")');
  sheet.getRange(row, 15).setFormula('=IF($A' + row + '="","",$E' + row + '*10000)');
  sheet.getRange(row, 16).setFormula('=IF($A' + row + '="","",$F' + row + '*10000)');
  sheet.getRange(row, 17).setFormula('=IFERROR(IF($A' + row + '="","",10000/$E' + row + '*$F' + row + '),"")');
  sheet.getRange(row, 18).setFormula('=IFERROR(IF($A' + row + '="","",$F' + row + '/$E' + row + '),"")');
  sheet.getRange(row, 20).setFormula('=IF($A' + row + '="","",$S' + row + '*$F' + row + ')');
  sheet.getRange(row, 31).setNumberFormat('@');
  dividendUpsertReinvestmentTransaction_(config, event, reinvestNav, reinvestShares);
}

function dividendUpdateSyncedMetadata_(sheet, row, event, config, syncedAt) {
  const existingSource = sheet.getRange(row, 26).getDisplayValue();
  const existingProgress = sheet.getRange(row, 24).getDisplayValue();
  const holdings = dividendHoldingsOnDate_(config, event.recordDate || event.exDate);
  const progress = config.distributionMethod === '红利再投'
    ? (existingSource && existingSource !== 'Tushare' && existingProgress
      ? existingProgress
      : event.progress + '；理论份额待核对')
    : event.progress;
  sheet.getRange(row, 22, 1, 5).setValues([[
    config.assetType,
    config.distributionMethod,
    progress,
    config.account,
    existingSource || 'Tushare'
  ]]);

  // 登记日持仓是由交易记录推导的字段，应始终刷新；不会覆盖银行确认的实际到账数据。
  sheet.getRange(row, 19).setValue(holdings);

  if (existingSource === 'Tushare') {
    const reinvestNav = config.distributionMethod === '红利再投'
      ? dividendFetchFundNav_(config.tsCode, event.netExDate || event.exDate)
      : '';
    const reinvestShares = dividendCalculateReinvestShares_(
      holdings,
      event.cashPerUnit,
      reinvestNav
    );

    sheet.getRange(row, 19).setValue(holdings);
    sheet.getRange(row, 28).setValue(reinvestNav);
    sheet.getRange(row, 29).setValue(reinvestShares);
    sheet.getRange(row, 30).setValue(dividendApiDateToDate_(event.accountDate));
    dividendUpsertReinvestmentTransaction_(config, event, reinvestNav, reinvestShares);
  }

  sheet.getRange(row, 32).setValue(syncedAt);
}

function dividendCalculateReinvestShares_(holdings, cashPerUnit, reinvestNav) {
  const owned = Number(holdings || 0);
  const cash = Number(cashPerUnit || 0);
  const nav = Number(reinvestNav || 0);

  if (!(owned > 0 && cash > 0 && nav > 0)) return '';

  // 银行先把应分红金额按人民币分位结算，再按确认净值折算份额。
  // 如果直接用未取整金额除以净值，边界月份可能相差 0.01 份。
  const settledCash = dividendRoundTo_(owned * cash, 2);
  return dividendRoundTo_(settledCash / nav, 2);
}

function dividendRoundTo_(value, digits) {
  const factor = Math.pow(10, digits);
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function dividendUpsertReinvestmentTransaction_(config, event, reinvestNav, reinvestShares) {
  if (config.distributionMethod !== '红利再投' || !(Number(reinvestShares) > 0)) return;

  const transactionDate = dividendApiDateToDate_(event.accountDate);
  if (!(transactionDate instanceof Date) || isNaN(transactionDate.getTime())) return;

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (transactionDate.getTime() > today.getTime()) return;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    DIVIDEND_SYNC_CONFIG.TRANSACTION_SHEET
  );
  const lastRow = sheet.getLastRow();
  const eventIds = lastRow >= 2
    ? sheet.getRange(2, 16, lastRow - 1, 1).getDisplayValues()
    : [];
  const existingIndex = eventIds.findIndex(row => String(row[0] || '').trim() === event.eventId);

  // 用户核对并修正过的实际份额优先，后续同步不覆盖。
  if (existingIndex >= 0) return;

  let targetRow = 0;
  if (lastRow >= 2) {
    const codes = sheet.getRange(2, 3, lastRow - 1, 1).getDisplayValues();
    const blankIndex = codes.findIndex(row => !String(row[0] || '').trim());
    if (blankIndex >= 0) targetRow = blankIndex + 2;
  }

  if (!targetRow) {
    sheet.insertRowAfter(Math.max(lastRow, 1));
    targetRow = Math.max(lastRow, 1) + 1;
    if (targetRow > 2) {
      sheet.getRange(targetRow - 1, 1, 1, 16).copyTo(
        sheet.getRange(targetRow, 1, 1, 16),
        SpreadsheetApp.CopyPasteType.PASTE_NORMAL,
        false
      );
      sheet.getRange(targetRow, 3).clearContent();
      sheet.getRange(targetRow, 5, 1, 5).clearContent();
      sheet.getRange(targetRow, 15, 1, 2).clearContent();
    }
  }

  sheet.getRange(targetRow, 3).setNumberFormat('@').setValue(config.code);
  sheet.getRange(targetRow, 5).setValue(transactionDate);
  sheet.getRange(targetRow, 6).setValue('红利再投');
  sheet.getRange(targetRow, 7).setValue(Number(reinvestNav));
  sheet.getRange(targetRow, 8).setValue(Number(reinvestShares));
  sheet.getRange(targetRow, 9).setValue(0);
  sheet.getRange(targetRow, 15).setValue(config.account);
  sheet.getRange(targetRow, 16).setNumberFormat('@').setValue(event.eventId);
}

function dividendHoldingsOnDate_(config, apiDate) {
  const date = dividendParseApiDate_(apiDate);

  if (!date) return '';

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    DIVIDEND_SYNC_CONFIG.TRANSACTION_SHEET
  );
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return 0;

  const rows = sheet.getRange(2, 3, lastRow - 1, 13).getValues();
  return rows.reduce((sum, row) => {
    const code = String(row[0] || '').trim();
    const tradeDate = row[2] instanceof Date ? row[2] : null;
    const shares = Number(row[5] || 0);
    const account = String(row[12] || '').trim();
    const accountMatches = !config.account || account === config.account;

    return code === config.code && tradeDate && tradeDate.getTime() <= date.getTime() && accountMatches
      ? sum + shares
      : sum;
  }, 0);
}

function dividendFetchFundNav_(tsCode, apiDate) {
  if (!apiDate) return '';

  try {
    const token = PropertiesService.getScriptProperties().getProperty(
      DIVIDEND_SYNC_CONFIG.TOKEN_PROPERTY
    );
    const rows = dividendCallTushareApi_(
      'fund_nav',
      { ts_code: tsCode, nav_date: apiDate },
      'ts_code,nav_date,unit_nav',
      token
    );
    return rows.length ? Number(rows[0].unit_nav || '') : '';
  } catch (err) {
    return '';
  }
}

function dividendBuildEventId_(code, date, cash, stockRatio) {
  return [
    String(code || '').trim(),
    dividendDateKey_(date),
    Number(cash || 0).toFixed(8),
    Number(stockRatio || 0).toFixed(8)
  ].join('|');
}

function dividendDateKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, DIVIDEND_SYNC_CONFIG.TIMEZONE, 'yyyyMMdd');
  }
  return String(value || '').replace(/\D/g, '').slice(0, 8);
}

function dividendApiDateToDate_(value) {
  const text = String(value || '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(text)) return '';
  return new Date(text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8) + 'T00:00:00+08:00');
}

function dividendParseApiDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const parsed = dividendApiDateToDate_(value);
  return parsed instanceof Date && !isNaN(parsed.getTime()) ? parsed : null;
}

function dividendInferAssetType_(code) {
  const value = String(code || '').trim().toUpperCase();
  if (/^\d{6}\.OF$/.test(value)) return '场外基金';
  if (/^(51|56|58|15)\d{4}\.(SH|SZ)$/.test(value)) return 'ETF';
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(value)) return '股票';
  // 迁移期兼容旧的六位代码。
  if (/^(51|56|58|15)/.test(value)) return 'ETF';
  if (/^\d{6}$/.test(value)) return '股票';
  return '';
}

function dividendAppendLog_(time, status, checked, inserted, updated, message) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = dividendEnsureSheet_(ss, DIVIDEND_SYNC_CONFIG.LOG_SHEET, 500, 6);
    dividendSetupLogSheet_(sheet);
    sheet.appendRow([time, status, checked, inserted, updated, message]);
  } catch (err) {
    // 日志失败不能覆盖原始同步错误。
  }
}
