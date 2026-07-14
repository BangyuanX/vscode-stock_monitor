import * as vscode from 'vscode';
import { AppConfig, StockData, buildTooltip, formatTicker } from './types';
import { MARKET_GROUPS, MarketCategory, classifyMarket } from './market';
import { getEffectiveStatusBarCodes, getSidebarOrderedCodes } from './config';

interface SidebarTicker {
  code: string;
  name: string;
  price: string;
  percent: string;
  trend: 'rise' | 'fall' | 'flat' | 'error';
  delayed: boolean;
  pinned: boolean;
  tooltip: string;
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
  private payload: SidebarPayload = { state: 'loading', groups: [] };

  constructor(private readonly actions: SidebarActions) {
    this.registration = vscode.window.registerWebviewViewProvider(
      'stock-bar.watchlist',
      this,
      { webviewOptions: { retainContextWhenHidden: true } },
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message?.type) {
        case 'ready':
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
      if (this.view === webviewView) this.view = undefined;
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
    await this.view?.webview.postMessage({ type: 'render', payload: this.payload });
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

export function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
  </style>
</head>
<body>
  <main id="app"><div class="state">正在获取行情数据…</div></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const savedState = vscode.getState() || {};
    const collapsed = new Set(savedState.collapsed || []);
    let latestPayload = { state: 'loading', groups: [] };
    let draggedCode = '';
    let draggedCategory = '';

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
          html += '<div class="ticker-row" data-code="' + code + '" data-category="' + escapeHtml(group.category) + '" title="' + escapeHtml(item.tooltip) + '">';
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
</body>
</html>`;
}
