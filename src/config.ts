import * as vscode from 'vscode';
import { AppConfig, FormatField, extractFormatFields } from './types';

const CONFIG_NS = 'stock-bar';

/** 股票代码前缀列表 */
const STOCK_PREFIXES = ['sh', 'sz', 'bj', 'hk', 'usr_', 'nf_', 'hf_'];

/**
 * 从配置中读取应用配置
 */
export function readConfig(): AppConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_NS);

  const allCodes = config.get<string[]>('codes', ['sh000001']);
  const interval = config.get<number>('interval', 5);
  const format = config.get<string>('format', '${icon}${name} ${price}');
  const maxItems = config.get<number>('maxItems', 6);
  const riseColor = config.get<string>('riseColor', '#cc5555');
  const fallColor = config.get<string>('fallColor', '#4a9e4a');
  const flatColor = config.get<string>('flatColor', '');
  const precision = config.get<Record<string, number>>('precision', {});
  const defaultPrecisionVal = precision['default'] ?? -1;
  const premiumCodes = config.get<string[]>('premiumCodes', []);
  const priceScale = config.get<Record<string, number>>('scale', {});

  // 所有代码统一走 stockCodes
  // 推荐格式：usr_NVDA（新浪美股）、BTC/USDT（Binance 加密货币/美股代币）
  const stockCodes: string[] = [];
  const cryptoSymbols: string[] = [];

  for (const code of allCodes) {
    const trimmed = code.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('crypto:')) {
      // 兼容旧配置：crypto:BTCUSDT → 去掉前缀, 后续由 toBinanceSymbol 统一处理
      stockCodes.push(trimmed.substring(7));
    } else {
      stockCodes.push(trimmed);
    }
  }

  const formatFields = extractFormatFields(format);

  return {
    stockCodes,
    cryptoSymbols,
    interval: Math.max(3, interval),
    format,
    formatFields,
    maxItems: Math.max(1, Math.min(20, maxItems)),
    riseColor,
    fallColor,
    flatColor,
    precision,
    defaultPrecision: defaultPrecisionVal,
    premiumCodes,
    priceScale,
  };
}

/**
 * 判断是否为合法的股票代码格式
 */
function isStockCode(code: string): boolean {
  return STOCK_PREFIXES.some(prefix => code.startsWith(prefix));
}

/**
 * 监听配置变更，筛选出本扩展相关的变更
 */
export function onConfigChanged(
  listener: (config: AppConfig) => void,
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(CONFIG_NS)) {
        listener(readConfig());
      }
    }),
  );
}

/**
 * 监听任意配置变更（不筛选 namespace），用于扩展配置变化通知
 */
export function onAnyConfigChanged(
  listener: () => void,
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(listener),
  );
}
