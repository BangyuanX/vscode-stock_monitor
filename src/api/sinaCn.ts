import { StockData } from '../types';

/** 解析新浪 A 股返回字段。 */
export function parseSinaCnFields(code: string, fields: string[]): StockData | null {
  if (fields.length < 33) return null;
  if (!fields[0] || fields[3] === '' || fields[3] === '-') return null;

  const name = fields[0] || code;
  const reportedPrice = parseFloat(fields[3]);
  const yestclose = parseFloat(fields[2]);
  if (isNaN(reportedPrice) || isNaN(yestclose)) return null;

  // 新浪在 A 股尚未开市或停牌时可能返回最新价 0，但昨收仍然有效。
  // 将这种 0 值视为“暂无成交”，避免价格显示为 0、今日盈亏被误算为巨额亏损。
  const usingPreviousClose = reportedPrice <= 0 && yestclose > 0;
  const price = usingPreviousClose ? yestclose : reportedPrice;

  const open = parseFloat(fields[1]) || yestclose;
  const high = parseFloat(fields[4]) || price;
  const low = parseFloat(fields[5]) || price;
  const change = price - yestclose;
  const changePercent = yestclose > 0 ? (change / yestclose) * 100 : 0;

  // 时间：fields[30]=日期 fields[31]=时间
  const time = fields[30] && fields[31] ? `${fields[30]} ${fields[31]}` : '';

  return {
    code,
    name,
    price,
    change,
    changePercent: parseFloat(changePercent.toFixed(2)),
    high,
    low,
    open,
    yestclose,
    time,
    usingPreviousClose,
  };
}
