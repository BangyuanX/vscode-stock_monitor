import * as vscode from 'vscode';
import { AppConfig, StockData, buildTooltip, formatPrice, formatTicker } from './types';
import { MARKET_GROUPS, MarketCategory, classifyMarket } from './market';
import { getEffectiveStatusBarCodes, getSidebarOrderedCodes } from './config';
import {
  PriceTrend,
  ReferencePlacement,
  calculateDayRangePosition,
  calculateRangeReferencePosition,
  comparePriceToBasis,
} from './dayRange';

interface SidebarRangeReference {
  label: string;
  value: string;
  position: number;
  placement: ReferencePlacement;
}

interface SidebarDayRange {
  current: string;
  low: string;
  high: string;
  currentTrend: PriceTrend;
  lowTrend: PriceTrend;
  highTrend: PriceTrend;
  position: number;
  flat: boolean;
  reference?: SidebarRangeReference;
}

interface SidebarTicker {
  code: string;
  name: string;
  price: string;
  percent: string;
  trend: 'rise' | 'fall' | 'flat' | 'error';
  delayed: boolean;
  pinned: boolean;
  tooltip: string;
  dayRange?: SidebarDayRange;
}

interface SidebarGroup {
  category: MarketCategory;
  label: string;
  items: SidebarTicker[];
}

interface SidebarPayload {
  state: 'loading' | 'ready' | 'error';
  groups: SidebarGroup[];
  message?: string;
}

export interface SidebarActions {
  toggleStatusBar(code: string): Promise<void>;
  removeTicker(code: string): Promise<void>;
  moveTicker(
    code: string,
    targetCode: string,
    position: 'before' | 'after',
  ): Promise<void>;
  setPrecision(code: string): Promise<void>;
}

/** 使用 Webview 实现严格双列布局、行内图钉和拖拽排序。 */
export class SidebarManager implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly registration: vscode.Disposable;
  private view?: vscode.WebviewView;
  private webviewReady = false;
  private payload: SidebarPayload = { state: 'loading', groups: [] };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: SidebarActions,
  ) {
    this.registration = vscode.window.registerWebviewViewProvider(
      'stock-bar.watchlist',
      this,
      { webviewOptions: { retainContextWhenHidden: true } },
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.webviewReady = false;
    webviewView.webview.options = { enableScripts: true };
    this.setWebviewHtml(webviewView);
    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message?.type) {
        case 'ready':
          this.webviewReady = true;
          await this.render();
          break;
        case 'togglePin':
          if (typeof message.code === 'string') {
            await this.actions.toggleStatusBar(message.code);
          }
          break;
        case 'remove':
          if (typeof message.code === 'string') {
            await this.actions.removeTicker(message.code);
          }
          break;
        case 'move':
          if (
            typeof message.code === 'string' &&
            typeof message.targetCode === 'string' &&
            (message.position === 'before' || message.position === 'after')
          ) {
            await this.actions.moveTicker(
              message.code,
              message.targetCode,
              message.position,
            );
          }
          break;
        case 'precision':
          if (typeof message.code === 'string') {
            await this.actions.setPrecision(message.code);
          }
          break;
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.webviewReady = false;
      }
    });
  }

  showLoading(): void {
    if (this.payload.groups.length === 0) {
      this.payload = { state: 'loading', groups: [] };
      void this.render();
    }
  }

  update(dataList: StockData[], config: AppConfig): void {
    const dataByCode = new Map(dataList.map(data => [data.code, data]));
    const pinnedCodes = new Set(getEffectiveStatusBarCodes(config));
    const grouped = new Map<MarketCategory, SidebarTicker[]>();

    for (const code of getSidebarOrderedCodes(config)) {
      const data = dataByCode.get(code);
      if (!data) continue;
      const category = classifyMarket(code);
      const items = grouped.get(category) ?? [];
      const configuredPrecision = config.precision[code] ?? config.defaultPrecision;
      const precision = configuredPrecision >= 0 ? configuredPrecision : undefined;
      const scale = config.priceScale[code] || 1;
      const display = formatTicker(data, precision, scale);
      const current = data.price * scale;
      const low = data.low * scale;
      const high = data.high * scale;
      const changeBasis = data.changeBasis === 'open' ? data.open : data.yestclose;
      const referenceValue = changeBasis * scale;
      const referencePosition = changeBasis > 0
        ? calculateRangeReferencePosition(referenceValue, low, high)
        : undefined;
      const referenceLabel = data.changeBasis === 'open'
        ? '今开'
        : data.changeBasis === 'regularClose'
          ? '收盘'
          : data.changeBasis === 'rolling24h' ? '24H前' : '昨收';
      const rangePosition = data.error || current <= 0 || low <= 0 || high <= 0
        ? undefined
        : calculateDayRangePosition(current, low, high);
      items.push({
        code,
        name: data.name || code,
        price: data.error ? '—' : display.price,
        percent: data.error ? '' : display.percent,
        trend: data.error
          ? 'error'
          : data.changePercent > 0
            ? 'rise'
            : data.changePercent < 0
              ? 'fall'
              : 'flat',
        delayed: data.delayed === true || category === 'hk',
        pinned: pinnedCodes.has(code),
        tooltip: data.error
          ? `${code}: ${data.error}\n下次刷新自动重试`
          : buildTooltip(data, precision, scale),
        dayRange: rangePosition === undefined
          ? undefined
          : {
              current: formatPrice(current, precision),
              low: formatPrice(low, precision),
              high: formatPrice(high, precision),
              currentTrend: comparePriceToBasis(data.price, changeBasis),
              lowTrend: comparePriceToBasis(data.low, changeBasis),
              highTrend: comparePriceToBasis(data.high, changeBasis),
              position: rangePosition,
              flat: high === low,
              reference: referencePosition
                ? {
                    label: referenceLabel,
                    value: formatPrice(referenceValue, precision),
                    ...referencePosition,
                  }
                : undefined,
            },
      });
      grouped.set(category, items);
    }

    const groups = MARKET_GROUPS.flatMap(group => {
      const items = grouped.get(group.category);
      return items?.length ? [{ ...group, items }] : [];
    });
    this.payload = { state: 'ready', groups };
    void this.render();
  }

  showRefreshError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.payload = {
      ...this.payload,
      state: this.payload.groups.length > 0 ? 'ready' : 'error',
      message: `刷新失败：${message}`,
    };
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    if (!this.webviewReady) {
      this.setWebviewHtml(this.view);
      return;
    }
    const delivered = await this.view.webview.postMessage({
      type: 'render',
      payload: this.payload,
    });
    if (!delivered && this.view) {
      this.webviewReady = false;
      this.setWebviewHtml(this.view);
    }
  }

  private setWebviewHtml(view: vscode.WebviewView): void {
    view.webview.html = getWebviewHtml(
      view.webview,
      this.extensionUri,
      this.payload,
    );
  }

  dispose(): void {
    this.registration.dispose();
  }
}

function getNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index++) {
    value += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return value;
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  payload: SidebarPayload = { state: 'loading', groups: [] },
): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'resources', 'sidebar.js'),
  );
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 4px 0 12px;
      color: var(--vscode-sideBar-foreground);
      background: transparent;
      font-family: var(--vscode-font-family);
      font-size: calc(var(--vscode-font-size) - 2px);
      user-select: none;
    }
    .state, .notice {
      padding: 8px 14px;
      color: var(--vscode-descriptionForeground);
      white-space: normal;
    }
    .notice { color: var(--vscode-list-warningForeground); }
    .group { margin-top: 2px; }
    .group-header {
      display: flex;
      align-items: center;
      gap: 5px;
      height: 24px;
      padding: 0 8px;
      border: 0;
      width: 100%;
      color: inherit;
      background: transparent;
      font: inherit;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }
    .group-header:hover, .ticker-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .chevron {
      width: 12px;
      height: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 12px;
      transition: transform 80ms linear;
    }
    .chevron svg {
      display: block;
      width: 10px;
      height: 10px;
    }
    .group-label {
      display: inline-flex;
      align-items: center;
      height: 100%;
      line-height: 1;
    }
    .group.collapsed .chevron { transform: rotate(-90deg); }
    .group.collapsed .group-items { display: none; }
    .ticker-row {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr) max-content repeat(3, 20px);
      align-items: center;
      column-gap: 3px;
      min-height: 23px;
      padding: 0 5px 0 20px;
      border-top: 2px solid transparent;
      border-bottom: 2px solid transparent;
    }
    .ticker-row.drop-before { border-top-color: var(--vscode-focusBorder); }
    .ticker-row.drop-after { border-bottom-color: var(--vscode-focusBorder); }
    .trend {
      width: 18px;
      font-size: 18px;
      line-height: 1;
      text-align: center;
    }
    .trend.rise { color: var(--vscode-charts-red); }
    .trend.fall { color: var(--vscode-charts-green); }
    .trend.flat { color: var(--vscode-descriptionForeground); font-size: 16px; }
    .trend.error { color: var(--vscode-list-warningForeground); font-size: 16px; }
    .name {
      min-width: 0;
      display: flex;
      align-items: center;
      overflow: hidden;
      white-space: nowrap;
    }
    .name-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .delay-badge {
      flex: 0 0 auto;
      margin-left: 4px;
      color: var(--vscode-list-warningForeground, #cca700);
      font-size: .78em;
      font-weight: 800;
      line-height: 1;
    }
    .price {
      display: grid;
      grid-template-columns: minmax(5.5ch, max-content) 9ch;
      align-items: baseline;
      column-gap: 0;
      padding: 2px 0;
      border: 0;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font-family: var(--vscode-editor-font-family);
      font-size: inherit;
      font-variant-numeric: tabular-nums;
      text-align: right;
      cursor: pointer;
    }
    .current-price { text-align: right; }
    .percent { text-align: left; }
    .percent { color: var(--vscode-descriptionForeground); }
    .percent.rise { color: var(--vscode-charts-red); }
    .percent.fall { color: var(--vscode-charts-green); }
    .percent.error { color: var(--vscode-list-warningForeground); }
    .price:hover { color: var(--vscode-foreground); }
    .icon-button, .delete-button, .drag-handle {
      display: inline-flex;
      width: 20px;
      height: 20px;
      align-items: center;
      justify-content: center;
      padding: 3px;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-icon-foreground);
      background: transparent;
    }
    .icon-button {
      cursor: pointer;
      opacity: .45;
      color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
      background: transparent;
      border: 1px solid transparent;
      transition: color 80ms linear, background-color 80ms linear, border-color 80ms linear;
    }
    .icon-button.pinned {
      opacity: 1;
      color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
    }
    .delete-button {
      cursor: pointer;
      opacity: .42;
    }
    .icon-button:hover, .delete-button:hover, .drag-handle:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }
    .delete-button:hover { color: var(--vscode-errorForeground); }
    .drag-handle { cursor: grab; opacity: .45; }
    .drag-handle:active { cursor: grabbing; }
    .icon-button svg, .delete-button svg, .drag-handle svg { width: 14px; height: 14px; }
    .stock-tooltip {
      position: fixed;
      z-index: 1000;
      max-width: min(340px, calc(100vw - 12px));
      padding: 7px 9px;
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border));
      border-radius: 4px;
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      box-shadow: 0 2px 8px var(--vscode-widget-shadow);
      font-family: var(--vscode-editor-font-family), SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: calc(var(--vscode-font-size) - 2px);
      font-variant-numeric: tabular-nums;
      line-height: 1.35;
      overflow-wrap: anywhere;
      pointer-events: none;
    }
    .tooltip-header {
      display: flex;
      min-width: 220px;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .tooltip-title {
      min-width: 0;
      overflow: hidden;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tooltip-current {
      flex: 0 0 auto;
      color: var(--vscode-foreground);
      font-size: 1.12em;
      font-weight: 650;
      white-space: nowrap;
    }
    .tooltip-current.rise { color: var(--vscode-charts-red); }
    .tooltip-current.fall { color: var(--vscode-charts-green); }
    .tooltip-code {
      flex: 0 0 auto;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .tooltip-divider {
      height: 1px;
      margin: 6px 0;
      background: var(--vscode-editorHoverWidget-border, var(--vscode-widget-border));
    }
    .tooltip-message {
      margin: 5px 0;
      padding: 4px 6px;
      border-left: 2px solid var(--vscode-list-warningForeground);
      border-radius: 2px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background, transparent);
      white-space: normal;
    }
    .tooltip-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .tooltip-label {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .tooltip-value { white-space: pre; }
    .tooltip-change {
      margin: 1px 0 6px;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--vscode-editorWidget-background, var(--vscode-textBlockQuote-background));
    }
    .tooltip-change .tooltip-value {
      font-weight: 600;
      text-align: right;
      white-space: normal;
    }
    .tooltip-change.rise .tooltip-value { color: var(--vscode-charts-red); }
    .tooltip-change.fall .tooltip-value { color: var(--vscode-charts-green); }
    .tooltip-session {
      margin-bottom: 6px;
      color: var(--vscode-descriptionForeground);
    }
    .tooltip-session .tooltip-value {
      padding: 1px 6px;
      border-radius: 999px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: .9em;
    }
    .tooltip-premium {
      margin-bottom: 2px;
      padding: 2px 8px;
      color: var(--vscode-descriptionForeground);
    }
    .tooltip-premium .tooltip-value {
      color: var(--vscode-foreground);
      font-weight: 500;
    }
    .tooltip-day-range {
      margin: 7px 1px 1px;
      padding-top: 7px;
      border-top: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border));
    }
    .tooltip-range-labels {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 8px;
      margin-bottom: 5px;
      color: var(--vscode-descriptionForeground);
      font-size: .92em;
      white-space: nowrap;
    }
    .tooltip-range-labels .current {
      color: var(--vscode-foreground);
      text-align: center;
    }
    .tooltip-range-labels .high { text-align: right; }
    .tooltip-range-price.rise { color: var(--vscode-charts-red); }
    .tooltip-range-price.fall { color: var(--vscode-charts-green); }
    .tooltip-range-track {
      position: relative;
      height: 5px;
      border-radius: 999px;
      background: var(--vscode-editorWidget-border, var(--vscode-widget-border));
    }
    .tooltip-range-fill {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: inherit;
      background: var(--vscode-charts-blue, var(--vscode-progressBar-background));
      opacity: .62;
    }
    .tooltip-range-marker {
      position: absolute;
      top: 50%;
      width: 9px;
      height: 9px;
      border: 2px solid var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      border-radius: 50%;
      background: var(--vscode-charts-blue, var(--vscode-progressBar-background));
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
      transform: translate(-50%, -50%);
    }
    .tooltip-reference-marker {
      position: absolute;
      top: -5px;
      width: 2px;
      height: 15px;
      border-radius: 1px;
      background: var(--vscode-charts-yellow, #cca700);
      transform: translateX(-50%);
    }
    .tooltip-reference-marker.left { transform: none; }
    .tooltip-reference-marker.right { transform: translateX(-100%); }
    .tooltip-reference-row {
      position: relative;
      height: 1.3em;
      margin-top: 5px;
      color: var(--vscode-charts-yellow, #cca700);
      font-size: .86em;
    }
    .tooltip-reference-label {
      position: absolute;
      transform: translateX(-50%);
      white-space: nowrap;
    }
    .tooltip-reference-label.align-left { transform: none; }
    .tooltip-reference-label.align-right { transform: translateX(-100%); }
    .tooltip-range-caption {
      margin-top: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: .88em;
      text-align: center;
    }
    .tooltip-footer {
      margin-top: 7px;
      padding-top: 5px;
      border-top: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border));
      color: var(--vscode-descriptionForeground);
      font-size: .86em;
    }
  </style>
</head>
<body>
  <main id="app">${renderPayloadHtml(payload)}</main>
  <div id="stock-tooltip" class="stock-tooltip" role="tooltip" hidden></div>
  <script type="application/json" id="legacy-sidebar-script">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const stockTooltip = document.getElementById('stock-tooltip');
    const savedState = vscode.getState() || {};
    const collapsed = new Set(savedState.collapsed || []);
    let latestPayload = { state: 'loading', groups: [] };
    let draggedCode = '';
    let draggedCategory = '';
    let tooltipTimer;
    let tooltipRow;
    let tooltipX = 0;
    let tooltipY = 0;

    const pinOffSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" d="M5.1 1.8h5.8l-.9 4 2.2 2.1v1H8.7v4.5L8 14.5l-.7-1.1V8.9H3.8v-1L6 5.8l-.9-4z"/><path d="M2.3 2.3l11.4 11.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const pinOnSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 1.5h6l-1 4.2 2.4 2.2v1.3H8.8v4.2L8 14.7l-.8-1.3V9.2H3.6V7.9L6 5.7 5 1.5z"/></svg>';
    const deleteSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const dragSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3h2v2H5V3zm4 0h2v2H9V3zM5 7h2v2H5V7zm4 0h2v2H9V7zm-4 4h2v2H5v-2zm4 0h2v2H9v-2z"/></svg>';
    const chevronSvg = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.25 4.25L6 8l3.75-3.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function trendSymbol(trend) {
      if (trend === 'rise') return '↑';
      if (trend === 'fall') return '↓';
      if (trend === 'error') return '!';
      return '−';
    }

    function clearDropMarkers() {
      document.querySelectorAll('.drop-before,.drop-after').forEach(row => {
        row.classList.remove('drop-before', 'drop-after');
      });
    }

    function positionTooltip(x, y) {
      const gap = 10;
      const bounds = stockTooltip.getBoundingClientRect();
      let left = x + gap;
      let top = y + gap;
      if (left + bounds.width > window.innerWidth - 6) left = x - bounds.width - gap;
      if (top + bounds.height > window.innerHeight - 6) top = y - bounds.height - gap;
      stockTooltip.style.left = Math.max(6, left) + 'px';
      stockTooltip.style.top = Math.max(6, top) + 'px';
    }

    function getRowTrend(row) {
      const trendElement = row.querySelector('.trend');
      if (trendElement?.classList.contains('rise')) return 'rise';
      if (trendElement?.classList.contains('fall')) return 'fall';
      return 'flat';
    }

    function appendDayRange(row) {
      if (!row?.dataset.range) return;
      let range;
      try { range = JSON.parse(row.dataset.range); } catch { return; }
      if (!range || !Number.isFinite(range.position)) return;

      const container = document.createElement('div');
      container.className = 'tooltip-day-range';
      container.setAttribute('aria-label', '日内价格位置');

      const labels = document.createElement('div');
      labels.className = 'tooltip-range-labels';
      const low = document.createElement('span');
      low.textContent = '低 ';
      const lowPrice = document.createElement('span');
      lowPrice.className = 'tooltip-range-price ' + (range.lowTrend || 'flat');
      lowPrice.textContent = range.low;
      low.appendChild(lowPrice);
      const current = document.createElement('span');
      current.className = 'current';
      current.textContent = '现 ';
      const currentPrice = document.createElement('span');
      currentPrice.className = 'tooltip-range-price ' + (range.currentTrend || 'flat');
      currentPrice.textContent = range.current;
      current.appendChild(currentPrice);
      const high = document.createElement('span');
      high.className = 'high';
      high.textContent = '高 ';
      const highPrice = document.createElement('span');
      highPrice.className = 'tooltip-range-price ' + (range.highTrend || 'flat');
      highPrice.textContent = range.high;
      high.appendChild(highPrice);
      labels.append(low, current, high);

      const track = document.createElement('div');
      track.className = 'tooltip-range-track';
      const fill = document.createElement('div');
      fill.className = 'tooltip-range-fill';
      fill.style.width = range.position + '%';
      const marker = document.createElement('div');
      marker.className = 'tooltip-range-marker';
      marker.style.left = range.position + '%';
      track.append(fill, marker);

      let referenceRow;
      if (range.reference && Number.isFinite(range.reference.position)) {
        const reference = range.reference;
        const referenceMarker = document.createElement('div');
        referenceMarker.className = 'tooltip-reference-marker ' + reference.placement;
        referenceMarker.style.left = reference.position + '%';
        track.appendChild(referenceMarker);

        referenceRow = document.createElement('div');
        referenceRow.className = 'tooltip-reference-row';
        const referenceLabel = document.createElement('span');
        const alignClass = reference.placement === 'left' || reference.position < 18
          ? 'align-left'
          : reference.placement === 'right' || reference.position > 82
            ? 'align-right' : '';
        referenceLabel.className = 'tooltip-reference-label ' + alignClass;
        referenceLabel.style.left = reference.position + '%';
        referenceLabel.textContent = reference.placement === 'left'
          ? '◀ ' + reference.label + ' ' + reference.value
          : reference.placement === 'right'
            ? reference.label + ' ' + reference.value + ' ▶'
            : reference.label + ' ' + reference.value;
        referenceRow.appendChild(referenceLabel);
      }

      const caption = document.createElement('div');
      caption.className = 'tooltip-range-caption';
      caption.textContent = range.flat
        ? '暂无日内振幅'
        : '日内位置 ' + Math.round(range.position) + '%';
      container.append(labels, track);
      if (referenceRow) container.appendChild(referenceRow);
      container.appendChild(caption);
      stockTooltip.appendChild(container);
    }

    function showStockTooltip(row, x, y) {
      if (!row?.dataset.tooltip) return;
      tooltipRow = row;
      tooltipX = x;
      tooltipY = y;
      stockTooltip.replaceChildren();
      let codeValue = row.dataset.code || '';
      let timeValue = '';
      const trend = getRowTrend(row);

      row.dataset.tooltip.split('\n').forEach((line, index) => {
        if (index === 0) {
          const header = document.createElement('div');
          header.className = 'tooltip-header';
          const title = document.createElement('span');
          title.className = 'tooltip-title';
          const match = line.match(/^(.*)（([^（）]+)）$/);
          title.textContent = match ? match[1] : line;
          if (match) codeValue = match[2];
          header.appendChild(title);
          const current = document.createElement('span');
          current.className = 'tooltip-current ' + trend;
          current.textContent = row.querySelector('.current-price')?.textContent || '—';
          header.appendChild(current);
          stockTooltip.appendChild(header);
          return;
        }
        if (line === '---') {
          const divider = document.createElement('div');
          divider.className = 'tooltip-divider';
          stockTooltip.appendChild(divider);
          return;
        }
        const tabIndex = line.indexOf('\t');
        if (tabIndex >= 0) {
          const labelText = line.slice(0, tabIndex);
          const valueText = line.slice(tabIndex + 1);
          if (labelText === '时间') {
            timeValue = valueText;
            return;
          }
          const item = document.createElement('div');
          item.className = 'tooltip-row';
          const label = document.createElement('span');
          label.className = 'tooltip-label';
          label.textContent = labelText;
          const value = document.createElement('span');
          value.className = 'tooltip-value';
          value.textContent = valueText;
          item.append(label, value);
          if (labelText === '涨跌') {
            item.classList.add('tooltip-change', trend);
            stockTooltip.appendChild(item);
          } else if (labelText === '阶段') {
            item.classList.add('tooltip-session');
            stockTooltip.appendChild(item);
          } else if (labelText === '溢价') {
            item.classList.add('tooltip-premium');
            stockTooltip.appendChild(item);
          } else {
            stockTooltip.appendChild(item);
          }
          return;
        }
        const message = document.createElement('div');
        message.className = 'tooltip-message';
        message.textContent = line;
        stockTooltip.appendChild(message);
      });
      appendDayRange(row);
      if (codeValue || timeValue) {
        const footer = document.createElement('div');
        footer.className = 'tooltip-row tooltip-footer';
        const code = document.createElement('span');
        code.className = 'tooltip-code';
        code.textContent = codeValue;
        const time = document.createElement('span');
        time.textContent = timeValue;
        footer.append(code, time);
        stockTooltip.appendChild(footer);
      }
      stockTooltip.hidden = false;
      positionTooltip(x, y);
    }

    function scheduleStockTooltip(row, x, y) {
      if (tooltipTimer) clearTimeout(tooltipTimer);
      tooltipRow = row;
      tooltipX = x;
      tooltipY = y;
      tooltipTimer = setTimeout(() => {
        tooltipTimer = undefined;
        if (tooltipRow === row) showStockTooltip(row, tooltipX, tooltipY);
      }, 90);
    }

    function hideStockTooltip(row) {
      if (row && tooltipRow !== row) return;
      if (tooltipTimer) clearTimeout(tooltipTimer);
      tooltipTimer = undefined;
      tooltipRow = undefined;
      stockTooltip.hidden = true;
    }

    function bindInteractions() {
      document.querySelectorAll('.group-header').forEach(header => {
        header.addEventListener('click', () => {
          const category = header.dataset.category;
          collapsed.has(category) ? collapsed.delete(category) : collapsed.add(category);
          vscode.setState({ collapsed: Array.from(collapsed) });
          render();
        });
      });
      document.querySelectorAll('.pin-button').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscode.postMessage({ type: 'togglePin', code: button.dataset.code });
        });
      });
      document.querySelectorAll('.delete-button').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          vscode.postMessage({ type: 'remove', code: button.dataset.code });
        });
      });
      document.querySelectorAll('.price').forEach(button => {
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'precision', code: button.dataset.code });
        });
      });
      document.querySelectorAll('.drag-handle').forEach(handle => {
        handle.addEventListener('dragstart', event => {
          draggedCode = handle.dataset.code;
          draggedCategory = handle.dataset.category;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', draggedCode);
        });
        handle.addEventListener('dragend', () => {
          draggedCode = '';
          draggedCategory = '';
          clearDropMarkers();
        });
      });
      document.querySelectorAll('.ticker-row').forEach(row => {
        row.addEventListener('pointerenter', event => {
          scheduleStockTooltip(row, event.clientX, event.clientY);
        });
        row.addEventListener('pointermove', event => {
          tooltipX = event.clientX;
          tooltipY = event.clientY;
          if (!stockTooltip.hidden && tooltipRow === row) positionTooltip(tooltipX, tooltipY);
        });
        row.addEventListener('pointerleave', () => hideStockTooltip(row));
        row.addEventListener('focusin', () => {
          const bounds = row.getBoundingClientRect();
          showStockTooltip(row, bounds.left + Math.min(bounds.width / 2, 120), bounds.bottom);
        });
        row.addEventListener('focusout', () => {
          setTimeout(() => {
            if (!row.contains(document.activeElement)) hideStockTooltip(row);
          }, 0);
        });
        row.addEventListener('dragover', event => {
          if (!draggedCode || draggedCode === row.dataset.code || draggedCategory !== row.dataset.category) return;
          event.preventDefault();
          clearDropMarkers();
          const bounds = row.getBoundingClientRect();
          row.classList.add(event.clientY < bounds.top + bounds.height / 2 ? 'drop-before' : 'drop-after');
        });
        row.addEventListener('drop', event => {
          if (!draggedCode || draggedCode === row.dataset.code || draggedCategory !== row.dataset.category) return;
          event.preventDefault();
          const bounds = row.getBoundingClientRect();
          vscode.postMessage({
            type: 'move',
            code: draggedCode,
            targetCode: row.dataset.code,
            position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
          });
          clearDropMarkers();
        });
      });
    }

    function render() {
      hideStockTooltip();
      const payload = latestPayload;
      if (payload.state === 'loading') {
        app.innerHTML = '<div class="state">正在获取行情数据…</div>';
        return;
      }
      if (payload.state === 'error' && payload.groups.length === 0) {
        app.innerHTML = '<div class="notice">' + escapeHtml(payload.message || '行情刷新失败') + '</div>';
        return;
      }
      let html = payload.message ? '<div class="notice">' + escapeHtml(payload.message) + '</div>' : '';
      if (payload.groups.length === 0) {
        app.innerHTML = html + '<div class="state">还没有监控标的，请点击顶部 + 添加。</div>';
        return;
      }
      for (const group of payload.groups) {
        const isCollapsed = collapsed.has(group.category);
        html += '<section class="group' + (isCollapsed ? ' collapsed' : '') + '">';
        html += '<button class="group-header" data-category="' + escapeHtml(group.category) + '"><span class="chevron">' + chevronSvg + '</span><span class="group-label">' + escapeHtml(group.label) + '</span></button>';
        html += '<div class="group-items">';
        for (const item of group.items) {
          const code = escapeHtml(item.code);
          html += '<div class="ticker-row" tabindex="0" aria-describedby="stock-tooltip" data-code="' + code + '" data-category="' + escapeHtml(group.category) + '" data-tooltip="' + escapeHtml(item.tooltip) + '" data-range="' + escapeHtml(item.dayRange ? JSON.stringify(item.dayRange) : '') + '">';
          html += '<span class="trend ' + item.trend + '">' + trendSymbol(item.trend) + '</span>';
          html += '<span class="name"><span class="name-text">' + escapeHtml(item.name) + '</span>' + (item.delayed ? '<span class="delay-badge" title="延迟行情（通常至少延迟约 15 分钟）">D</span>' : '') + '</span>';
          html += '<button class="price" data-code="' + code + '" title="设置小数位数"><span class="current-price">' + escapeHtml(item.price) + '</span><span class="percent ' + item.trend + '">' + (item.percent ? '(' + escapeHtml(item.percent) + ')' : '') + '</span></button>';
          html += '<button class="icon-button pin-button' + (item.pinned ? ' pinned' : '') + '" data-code="' + code + '" title="' + (item.pinned ? '状态栏：已显示（点击移除）' : '状态栏：未显示（点击固定）') + '" aria-label="切换状态栏显示" aria-pressed="' + item.pinned + '">' + (item.pinned ? pinOnSvg : pinOffSvg) + '</button>';
          html += '<span class="drag-handle" draggable="true" data-code="' + code + '" data-category="' + escapeHtml(group.category) + '" title="按住并拖动排序" role="button" aria-label="拖动排序">' + dragSvg + '</span>';
          html += '<button class="delete-button" data-code="' + code + '" title="从自选移除" aria-label="从自选移除">' + deleteSvg + '</button>';
          html += '</div>';
        }
        html += '</div></section>';
      }
      app.innerHTML = html;
      bindInteractions();
    }

    window.addEventListener('message', event => {
      if (event.data?.type === 'render') {
        latestPayload = event.data.payload;
        render();
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

const pinOffSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" d="M5.1 1.8h5.8l-.9 4 2.2 2.1v1H8.7v4.5L8 14.5l-.7-1.1V8.9H3.8v-1L6 5.8l-.9-4z"/><path d="M2.3 2.3l11.4 11.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const pinOnSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 1.5h6l-1 4.2 2.4 2.2v1.3H8.8v4.2L8 14.7l-.8-1.3V9.2H3.6V7.9L6 5.7 5 1.5z"/></svg>';
const deleteSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const dragSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3h2v2H5V3zm4 0h2v2H9V3zM5 7h2v2H5V7zm4 0h2v2H9V7zm-4 4h2v2H5v-2zm4 0h2v2H9v-2z"/></svg>';
const chevronSvg = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.25 4.25L6 8l3.75-3.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trendSymbol(trend: SidebarTicker['trend']): string {
  if (trend === 'rise') return '↑';
  if (trend === 'fall') return '↓';
  if (trend === 'error') return '!';
  return '−';
}

function renderPayloadHtml(payload: SidebarPayload): string {
  if (payload.state === 'loading') {
    return '<div class="state">正在获取行情数据…</div>';
  }
  if (payload.state === 'error' && payload.groups.length === 0) {
    return `<div class="notice">${escapeHtml(payload.message || '行情刷新失败')}</div>`;
  }
  let html = payload.message
    ? `<div class="notice">${escapeHtml(payload.message)}</div>`
    : '';
  if (payload.groups.length === 0) {
    return `${html}<div class="state">还没有监控标的，请点击顶部 + 添加。</div>`;
  }
  for (const group of payload.groups) {
    html += `<section class="group"><button class="group-header" data-category="${escapeHtml(group.category)}"><span class="chevron">${chevronSvg}</span><span class="group-label">${escapeHtml(group.label)}</span></button><div class="group-items">`;
    for (const item of group.items) {
      const code = escapeHtml(item.code);
      html += `<div class="ticker-row" tabindex="0" aria-describedby="stock-tooltip" data-code="${code}" data-category="${escapeHtml(group.category)}" data-tooltip="${escapeHtml(item.tooltip)}" data-range="${escapeHtml(item.dayRange ? JSON.stringify(item.dayRange) : '')}">`;
      html += `<span class="trend ${item.trend}">${trendSymbol(item.trend)}</span>`;
      html += `<span class="name"><span class="name-text">${escapeHtml(item.name)}</span>${item.delayed ? '<span class="delay-badge" title="延迟行情（通常至少延迟约 15 分钟）">D</span>' : ''}</span>`;
      html += `<button class="price" data-code="${code}" title="设置小数位数"><span class="current-price">${escapeHtml(item.price)}</span><span class="percent ${item.trend}">${item.percent ? `(${escapeHtml(item.percent)})` : ''}</span></button>`;
      html += `<button class="icon-button pin-button${item.pinned ? ' pinned' : ''}" data-code="${code}" title="${item.pinned ? '状态栏：已显示（点击移除）' : '状态栏：未显示（点击固定）'}" aria-label="切换状态栏显示" aria-pressed="${item.pinned}">${item.pinned ? pinOnSvg : pinOffSvg}</button>`;
      html += `<span class="drag-handle" draggable="true" data-code="${code}" data-category="${escapeHtml(group.category)}" title="按住并拖动排序" role="button" aria-label="拖动排序">${dragSvg}</span>`;
      html += `<button class="delete-button" data-code="${code}" title="从自选移除" aria-label="从自选移除">${deleteSvg}</button></div>`;
    }
    html += '</div></section>';
  }
  return html;
}
