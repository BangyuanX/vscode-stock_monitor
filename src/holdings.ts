import * as vscode from 'vscode';
import { AppConfig, StockData } from './types';
import { getSidebarOrderedCodes } from './config';
import { classifyMarket } from './market';

export interface DailyPnlPosition {
  code: string;
  name: string;
  quantity: number;
  pnl?: number;
}

export interface DailyPnlSummary {
  positions: DailyPnlPosition[];
  total: number;
  hasHoldings: boolean;
  unavailableCount: number;
}

interface HoldingRow extends DailyPnlPosition {
  price?: number;
  change?: number;
}

interface HoldingsPayload {
  rows: HoldingRow[];
  total: number;
  hasHoldings: boolean;
  unavailableCount: number;
}

export function calculateDailyPnl(
  dataByCode: ReadonlyMap<string, StockData>,
  holdings: Readonly<Record<string, number>>,
): DailyPnlSummary {
  const positions: DailyPnlPosition[] = [];
  let total = 0;
  let unavailableCount = 0;

  for (const [code, rawQuantity] of Object.entries(holdings)) {
    const quantity = Number(rawQuantity);
    if (classifyMarket(code) !== 'cn' || !Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }
    const data = dataByCode.get(code);
    const pnl = data && !data.error ? data.change * quantity : undefined;
    if (pnl === undefined) {
      unavailableCount += 1;
    } else {
      total += pnl;
    }
    positions.push({
      code,
      name: data?.name || code,
      quantity,
      pnl,
    });
  }

  return {
    positions,
    total,
    hasHoldings: positions.length > 0,
    unavailableCount,
  };
}

export class HoldingsManager implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private latestConfig?: AppConfig;
  private latestData = new Map<string, StockData>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly saveHoldings: (holdings: Record<string, number>) => Promise<void>,
  ) {}

  show(config: AppConfig, dataByCode: ReadonlyMap<string, StockData>): void {
    this.latestConfig = config;
    this.latestData = new Map(dataByCode);
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      void this.render();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'stock-bar.holdings',
      'Stock Bar: A 股持仓',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel = panel;
    panel.webview.html = getHoldingsHtml(panel.webview);
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    }, undefined, this.disposables);
    panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ready') {
        await this.render();
        return;
      }
      if (message?.type !== 'save' || !message.holdings || typeof message.holdings !== 'object') {
        return;
      }
      const next: Record<string, number> = {};
      for (const [code, value] of Object.entries(message.holdings as Record<string, unknown>)) {
        const quantity = Number(value);
        if (classifyMarket(code) === 'cn' && Number.isFinite(quantity) && quantity > 0) {
          next[code] = quantity;
        }
      }
      await this.saveHoldings(next);
      vscode.window.showInformationMessage('A 股持仓已保存，今日盈亏已更新');
    }, undefined, this.disposables);
  }

  update(config: AppConfig, dataByCode: ReadonlyMap<string, StockData>): void {
    this.latestConfig = config;
    this.latestData = new Map(dataByCode);
    if (this.panel) void this.render();
  }

  private async render(): Promise<void> {
    if (!this.panel || !this.latestConfig) return;
    const summary = calculateDailyPnl(this.latestData, this.latestConfig.holdings);
    const rows: HoldingRow[] = getSidebarOrderedCodes(this.latestConfig)
      .filter(code => classifyMarket(code) === 'cn')
      .map(code => {
        const data = this.latestData.get(code);
        const quantity = this.latestConfig?.holdings[code] || 0;
        return {
          code,
          name: data?.name || code,
          quantity,
          price: data && !data.error ? data.price : undefined,
          change: data && !data.error ? data.change : undefined,
          pnl: data && !data.error && quantity > 0 ? data.change * quantity : undefined,
        };
      });
    const payload: HoldingsPayload = { ...summary, rows };
    await this.panel.webview.postMessage({ type: 'render', payload });
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
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

export function getHoldingsHtml(webview: vscode.Webview): string {
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
      margin: 0 auto;
      padding: 24px;
      max-width: 920px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 20px;
    }
    h1 { margin: 0 0 7px; font-size: 22px; font-weight: 600; }
    .hint { color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .summary {
      min-width: 190px;
      padding: 12px 14px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      background: var(--vscode-sideBar-background);
    }
    .summary-label { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .summary-value {
      margin-top: 5px;
      font-family: var(--vscode-editor-font-family);
      font-size: 21px;
      font-variant-numeric: tabular-nums;
    }
    .rise { color: var(--vscode-charts-red); }
    .fall { color: var(--vscode-charts-green); }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--vscode-widget-border);
      text-align: left;
    }
    th { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 500; }
    .number { text-align: right; font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; }
    .name { font-weight: 500; }
    .code { margin-top: 2px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
    input {
      width: 130px;
      padding: 5px 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
      font-family: var(--vscode-editor-font-family);
      text-align: right;
      outline: none;
    }
    input:focus { border-color: var(--vscode-focusBorder); }
    button {
      margin-top: 18px;
      padding: 7px 16px;
      border: 0;
      border-radius: 2px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .empty { padding: 28px 10px; color: var(--vscode-descriptionForeground); text-align: center; }
    @media (max-width: 620px) {
      body { padding: 16px; }
      header { display: block; }
      .summary { margin-top: 14px; }
      th:nth-child(2), td:nth-child(2) { display: none; }
      input { width: 100px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>A 股持仓</h1>
      <div class="hint">今日盈亏 = 持仓股数 ×（现价 − 昨收价）。只统计当前自选中的 A 股；清空或填 0 表示不计入持仓。</div>
    </div>
    <div class="summary">
      <div class="summary-label">今日盈亏</div>
      <div id="summary" class="summary-value">¥0.00</div>
    </div>
  </header>
  <main id="app"><div class="empty">正在载入 A 股自选…</div></main>
  <button id="save" type="button">保存持仓</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const summary = document.getElementById('summary');
    const saveButton = document.getElementById('save');
    const edited = new Map();
    let latestPayload = { rows: [], total: 0, hasHoldings: false, unavailableCount: 0 };

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function money(value, signed) {
      const number = Number(value);
      const sign = signed && number > 0 ? '+' : '';
      return sign + '¥' + number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function render() {
      const payload = latestPayload;
      summary.textContent = payload.hasHoldings ? money(payload.total, true) : '¥0.00';
      summary.className = 'summary-value' + (payload.total > 0 ? ' rise' : payload.total < 0 ? ' fall' : '');
      if (!payload.rows.length) {
        app.innerHTML = '<div class="empty">自选列表中没有 A 股，请先从侧边栏顶部的 + 添加。</div>';
        saveButton.hidden = true;
        return;
      }
      saveButton.hidden = false;
      let html = '<table><thead><tr><th>标的</th><th class="number">现价</th><th class="number">持仓股数</th><th class="number">今日盈亏</th></tr></thead><tbody>';
      for (const row of payload.rows) {
        const code = escapeHtml(row.code);
        const quantity = edited.has(row.code) ? edited.get(row.code) : row.quantity || '';
        const pnlClass = row.pnl > 0 ? ' rise' : row.pnl < 0 ? ' fall' : '';
        html += '<tr><td><div class="name">' + escapeHtml(row.name) + '</div><div class="code">' + code + '</div></td>';
        html += '<td class="number">' + (row.price === undefined ? '—' : Number(row.price).toFixed(2)) + '</td>';
        html += '<td class="number"><input type="number" min="0" step="1" inputmode="decimal" data-code="' + code + '" data-change="' + (row.change === undefined ? '' : row.change) + '" value="' + escapeHtml(quantity) + '" placeholder="0"></td>';
        html += '<td class="number' + pnlClass + '" data-pnl="' + code + '">' + (row.pnl === undefined || !row.quantity ? '—' : money(row.pnl, true)) + '</td></tr>';
      }
      app.innerHTML = html + '</tbody></table>';
      document.querySelectorAll('input[data-code]').forEach(input => {
        input.addEventListener('input', () => {
          edited.set(input.dataset.code, input.value);
          updatePreview();
        });
      });
      updatePreview();
    }

    function updatePreview() {
      let total = 0;
      let count = 0;
      document.querySelectorAll('input[data-code]').forEach(input => {
        const quantity = Number(input.value);
        const change = Number(input.dataset.change);
        const cell = document.querySelector('[data-pnl="' + CSS.escape(input.dataset.code) + '"]');
        if (quantity > 0 && input.dataset.change !== '' && Number.isFinite(change)) {
          const pnl = quantity * change;
          total += pnl;
          count += 1;
          if (cell) {
            cell.textContent = money(pnl, true);
            cell.className = 'number' + (pnl > 0 ? ' rise' : pnl < 0 ? ' fall' : '');
          }
        } else if (cell) {
          cell.textContent = '—';
          cell.className = 'number';
        }
      });
      summary.textContent = count > 0 ? money(total, true) : '¥0.00';
      summary.className = 'summary-value' + (total > 0 ? ' rise' : total < 0 ? ' fall' : '');
    }

    saveButton.addEventListener('click', () => {
      const holdings = {};
      document.querySelectorAll('input[data-code]').forEach(input => {
        const quantity = Number(input.value);
        if (Number.isFinite(quantity) && quantity > 0) holdings[input.dataset.code] = quantity;
      });
      edited.clear();
      vscode.postMessage({ type: 'save', holdings });
    });

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
