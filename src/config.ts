import * as vscode from 'vscode';
import { AppConfig, FormatField, extractFormatFields } from './types';
import { orderCodesByMarket } from './market';

const CONFIG_NS = 'stock-bar';

/** 将旧版 crypto: 前缀归一化为当前代码格式 */
export function normalizeConfiguredCode(code: string): string {
  const trimmed = code.trim();
  const withoutLegacyPrefix = trimmed.startsWith('crypto:')
    ? trimmed.substring(7)
    : trimmed;
  const hkMatch = withoutLegacyPrefix.match(/^hk(\d{1,5})$/i);
  if (hkMatch) return `hk${hkMatch[1].padStart(5, '0')}`;
  return withoutLegacyPrefix;
}

function normalizeCodeList(codes: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const code of codes) {
    const value = normalizeConfiguredCode(code);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

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
  const stockCodes = normalizeCodeList(allCodes);
  const cryptoSymbols: string[] = [];
  const availableCodes = new Set(stockCodes);
  const rawStatusBarCodes = config.get<string[] | null>('statusBarCodes', null);
  const statusBarCodes = rawStatusBarCodes === null
    ? null
    : normalizeCodeList(rawStatusBarCodes).filter(code => availableCodes.has(code));

  const formatFields = extractFormatFields(format);
  return {
    stockCodes,
    statusBarCodes,
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

/** 按侧边栏固定市场分组和组内手动顺序展开全部代码 */
export function getSidebarOrderedCodes(config: AppConfig): string[] {
  return orderCodesByMarket(config.stockCodes);
}

/** 状态栏实际显示的代码；未自定义时保持原有 maxItems 行为 */
export function getEffectiveStatusBarCodes(config: AppConfig): string[] {
  const sidebarOrder = getSidebarOrderedCodes(config);
  if (config.statusBarCodes === null) return sidebarOrder.slice(0, config.maxItems);
  const selected = new Set(config.statusBarCodes);
  return sidebarOrder.filter(code => selected.has(code));
}

/**
 * 监听配置变更，筛选出本扩展相关的变更
 */
export function onConfigChanged(
  listener: (config: AppConfig, event: vscode.ConfigurationChangeEvent) => void,
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(CONFIG_NS)) {
        listener(readConfig(), e);
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
