import * as vscode from 'vscode';
import {
  getEffectiveStatusBarCodes,
  getSidebarOrderedCodes,
  normalizeConfiguredCode,
  onConfigChanged,
  readConfig,
} from './config';
import { classifyMarket } from './market';
import { fetchStocks } from './api/stockApi';
import { StatusBarManager } from './statusBar';
import { SidebarManager } from './sidebar';
import { SyncStateManager } from './syncState';
import { StockData } from './types';

let statusBarManager: StatusBarManager;
let sidebarManager: SidebarManager;
let syncStateManager: SyncStateManager;
let pollingTimer: NodeJS.Timeout | null = null;
let isRefreshing = false;
let refreshPending = false;
let latestDataByCode = new Map<string, StockData>();

interface CodeQuickPickItem extends vscode.QuickPickItem {
  code: string;
}

export function activate(context: vscode.ExtensionContext) {
  console.log('[StockBar] 扩展已激活');

  syncStateManager = new SyncStateManager(context);

  // 先注册并启动行情 UI；配置同步在后台初始化，不能阻塞侧边栏。
  statusBarManager = new StatusBarManager();
  sidebarManager = new SidebarManager({
    toggleStatusBar,
    removeTicker: removeTickerFromSidebar,
    moveTicker: moveTickerRelative,
    setPrecision: managePrecision,
  });

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('stock-bar.refresh', () => {
      void refreshAll();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('stock-bar.openSettings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:bangyuan.stock-bar-monitor',
      );
    }),
  );

  // 添加监控品种
  context.subscriptions.push(
    vscode.commands.registerCommand('stock-bar.addCode', async () => {
      const code = await vscode.window.showInputBox({
        prompt: '输入要监控的品种代码',
        placeHolder: '示例: sh000001, hk00700, usr_aapl, BTC/USDT',
        ignoreFocusOut: true,
      });
      if (!code) return;
      const config = vscode.workspace.getConfiguration('stock-bar');
      const codes = config.get<string[]>('codes', []);
      const normalized = normalizeConfiguredCode(code);
      if (!normalized) return;
      if (codes.some(existing => normalizeConfiguredCode(existing) === normalized)) {
        vscode.window.showInformationMessage(`「${normalized}」已在监控列表中`);
        return;
      }
      await updateCodes([...codes, normalized]);
      vscode.window.showInformationMessage(`已添加「${normalized}」`);
    }),
  );

  // 删除监控品种
  context.subscriptions.push(
    vscode.commands.registerCommand('stock-bar.removeCode', async () => {
      const config = vscode.workspace.getConfiguration('stock-bar');
      const codes = config.get<string[]>('codes', []);
      if (codes.length === 0) {
        vscode.window.showInformationMessage('监控列表为空');
        return;
      }
      const selected = await vscode.window.showQuickPick(codes, {
        placeHolder: '选择要移除的品种',
        canPickMany: true,
      });
      if (!selected || selected.length === 0) return;
      await removeCodes(selected);
      vscode.window.showInformationMessage(
        `已移除 ${selected.length} 个品种`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('stock-bar.managePrecision', () => managePrecision()),
    vscode.commands.registerCommand('stock-bar.syncNow', () => syncStateManager.syncNow()),
  );

  // 显示初始加载状态
  statusBarManager.showLoading();
  sidebarManager.showLoading();

  // 应用配置
  applyConfig(context);

  // 初次刷新
  void refreshAll();

  void initializeBackgroundServices();

  console.log('[StockBar] 扩展初始化完成');
}

async function initializeBackgroundServices(): Promise<void> {
  try {
    await removeObsoleteSettings();
    await syncStateManager.initialize();
  } catch (error) {
    console.error('[StockBar] 后台配置同步初始化失败，不影响行情显示:', error);
  }
}

export function deactivate() {
  console.log('[StockBar] 扩展去激活');
  stopPolling();
  if (statusBarManager) {
    statusBarManager.dispose();
  }
  if (sidebarManager) {
    sidebarManager.dispose();
  }
  if (syncStateManager) {
    syncStateManager.dispose();
  }
}

async function updateCodes(codes: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('stock-bar');
  await config.update('codes', codes, vscode.ConfigurationTarget.Global);
}

async function removeObsoleteSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration('stock-bar');
  for (const key of ['sidebarCodes', 'holdings', 'holdingDailyTrades']) {
    const inspected = config.inspect(key);
    if (!inspected) continue;
    if (inspected.globalValue !== undefined) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    if (inspected.workspaceValue !== undefined) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    }
    if (inspected.workspaceFolderValue !== undefined) {
      await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }
}

async function updateStatusBarCodes(codes: string[] | null): Promise<void> {
  const config = vscode.workspace.getConfiguration('stock-bar');
  const normalized = codes === null
    ? null
    : Array.from(new Set(codes.map(normalizeConfiguredCode).filter(Boolean)));
  await config.update('statusBarCodes', normalized, vscode.ConfigurationTarget.Global);
  renderLatestData();
}

async function removeCodes(codesToRemove: readonly string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('stock-bar');
  const codes = config.get<string[]>('codes', []);
  const removing = new Set(codesToRemove.map(normalizeConfiguredCode));
  await updateCodes(
    codes.filter(code => !removing.has(normalizeConfiguredCode(code))),
  );

  const configured = config.get<string[] | null>('statusBarCodes', null);
  if (configured !== null) {
    await updateStatusBarCodes(
      configured.filter(code => !removing.has(normalizeConfiguredCode(code))),
    );
  }
}

async function toggleStatusBar(code: string): Promise<void> {
  const config = readConfig();
  const current = getEffectiveStatusBarCodes(config);
  const isPinned = current.includes(code);
  const next = isPinned
    ? current.filter(itemCode => itemCode !== code)
    : [...current, code];
  await updateStatusBarCodes(next);
  const name = latestDataByCode.get(code)?.name || code;
  vscode.window.showInformationMessage(
    isPinned
      ? `已从状态栏移除「${name}」`
      : `已将「${name}」固定到状态栏`,
  );
}

async function removeTickerFromSidebar(code: string): Promise<void> {
  const name = latestDataByCode.get(code)?.name || code;
  const confirmed = await vscode.window.showWarningMessage(
    `确定从自选列表移除「${name}（${code}）」吗？`,
    { modal: true },
    '移除',
  );
  if (confirmed !== '移除') return;
  await removeCodes([code]);
  vscode.window.showInformationMessage(`已从自选列表移除「${name}」`);
}

async function moveTickerRelative(
  code: string,
  targetCode: string,
  position: 'before' | 'after',
): Promise<void> {
  if (code === targetCode) return;
  const category = classifyMarket(code);
  if (classifyMarket(targetCode) !== category) return;

  const config = readConfig();
  const siblings = config.stockCodes.filter(code => classifyMarket(code) === category);
  if (!siblings.includes(code) || !siblings.includes(targetCode)) return;

  const reordered = siblings.filter(itemCode => itemCode !== code);
  let targetIndex = reordered.indexOf(targetCode);
  if (targetIndex < 0) return;
  if (position === 'after') targetIndex += 1;
  reordered.splice(targetIndex, 0, code);

  let siblingIndex = 0;
  const next = config.stockCodes.map(itemCode => (
    classifyMarket(itemCode) === category
      ? reordered[siblingIndex++]
      : itemCode
  ));
  await updateCodes(next);
  renderLatestData();
}

async function managePrecision(selectedCode?: string): Promise<void> {
  let code = selectedCode;
  if (!code) {
    const config = readConfig();
    const items: CodeQuickPickItem[] = getSidebarOrderedCodes(config).map(itemCode => {
      const data = latestDataByCode.get(itemCode);
      const name = data?.name || itemCode;
      return {
        label: name,
        description: name === itemCode ? undefined : itemCode,
        code: itemCode,
      };
    });
    const selected = await vscode.window.showQuickPick(items, {
      matchOnDescription: true,
      placeHolder: '选择要设置小数位数的标的',
    });
    if (!selected) return;
    code = selected.code;
  }

  const workspaceConfig = vscode.workspace.getConfiguration('stock-bar');
  const precision = workspaceConfig.get<Record<string, number>>('precision', {});
  const current = precision[code];
  const defaultPrecision = precision['default'];
  const options = [
    {
      label: defaultPrecision === undefined
        ? '自动'
        : `使用全局默认（${defaultPrecision} 位）`,
      description: current === undefined ? '当前' : '清除该标的的单独设置',
      value: undefined,
    },
    ...Array.from({ length: 9 }, (_, digits) => ({
      label: `${digits} 位小数`,
      description: current === digits ? '当前' : undefined,
      value: digits,
    })),
  ];
  const selectedPrecision = await vscode.window.showQuickPick(options, {
    placeHolder: `设置 ${latestDataByCode.get(code)?.name || code} 的价格精度`,
  });
  if (!selectedPrecision) return;

  const nextPrecision = { ...precision };
  if (selectedPrecision.value === undefined) {
    delete nextPrecision[code];
  } else {
    nextPrecision[code] = selectedPrecision.value;
  }
  await workspaceConfig.update(
    'precision',
    nextPrecision,
    vscode.ConfigurationTarget.Global,
  );
  vscode.window.showInformationMessage(
    selectedPrecision.value === undefined
      ? `「${code}」已恢复默认小数位数`
      : `「${code}」已设置为 ${selectedPrecision.value} 位小数`,
  );
}

function renderLatestData(): void {
  const config = readConfig();
  const allData = config.stockCodes.flatMap(code => {
    const data = latestDataByCode.get(code);
    return data ? [data] : [];
  });
  const statusBarData = getEffectiveStatusBarCodes(config).flatMap(code => {
    const data = latestDataByCode.get(code);
    return data ? [data] : [];
  });
  statusBarManager.update(statusBarData, config.format);
  sidebarManager.update(allData, config);
}

/**
 * 读取配置并应用到管理器
 */
function applyConfig(context: vscode.ExtensionContext): void {
  const config = readConfig();

  statusBarManager.setColors(config.riseColor, config.fallColor, config.flatColor);
  // refreshAll 已按显示配置筛选，管理器本身不再二次截断自定义列表。
  statusBarManager.setMaxItems(Number.MAX_SAFE_INTEGER);
  statusBarManager.setPrecision(config.precision, config.defaultPrecision);
  statusBarManager.setScale(config.priceScale);

  // 重启轮询（如果间隔变化）
  restartPolling(config.interval);

  // 监听配置变更
  onConfigChanged((newConfig, event) => {
    console.log('[StockBar] 配置已变更，重新应用');
    syncStateManager.handleConfigurationChange();
    statusBarManager.setColors(newConfig.riseColor, newConfig.fallColor, newConfig.flatColor);
    statusBarManager.setMaxItems(Number.MAX_SAFE_INTEGER);
    statusBarManager.setPrecision(newConfig.precision, newConfig.defaultPrecision);
    statusBarManager.setScale(newConfig.priceScale);
    if (event.affectsConfiguration('stock-bar.interval')) {
      restartPolling(newConfig.interval);
    }
    if (
      event.affectsConfiguration('stock-bar.codes') ||
      event.affectsConfiguration('stock-bar.premiumCodes')
    ) {
      void refreshAll();
    } else {
      renderLatestData();
    }
  }, context);
}

/**
 * 刷新所有行情数据
 */
async function refreshAll(): Promise<void> {
  if (isRefreshing) {
    refreshPending = true;
    return;
  }
  isRefreshing = true;

  try {
    const config = readConfig();
    const allData: StockData[] = [];

    // 统一通过新浪 + Binance 获取所有品种数据
    const stockMap = await fetchStocks(config.stockCodes, config.premiumCodes);

    // 按配置顺序排列
    for (const code of config.stockCodes) {
      const data = stockMap.get(code);
      if (data) allData.push(data);
    }

    // 为获取失败的品种创建错误标记，显示在状态栏末尾
    const missingStocks = config.stockCodes.filter(c => !stockMap.has(c));
    for (const code of missingStocks) {
      allData.push({
        code,
        name: code,
        price: 0,
        change: 0,
        changePercent: 0,
        high: 0,
        low: 0,
        open: 0,
        yestclose: 0,
        time: '',
        error: '获取失败',
      });
    }
    if (missingStocks.length > 0) {
      console.warn(`[StockBar] 以下品种获取失败: ${missingStocks.join(', ')}`);
    }

    latestDataByCode = new Map(allData.map(data => [data.code, data]));
    // 状态栏使用独立选择，侧边栏始终显示全部自选。
    renderLatestData();
  } catch (err) {
    console.error('[StockBar] 刷新失败:', err);
    sidebarManager.showRefreshError(err);
  } finally {
    isRefreshing = false;
    if (refreshPending) {
      refreshPending = false;
      void refreshAll();
    }
  }
}

/**
 * 启动轮询
 */
function startPolling(intervalSeconds: number): void {
  if (pollingTimer) return;
  const ms = intervalSeconds * 1000;
  console.log(`[StockBar] 启动轮询，间隔 ${intervalSeconds}s`);
  pollingTimer = setInterval(() => void refreshAll(), ms);
}

/**
 * 停止轮询
 */
function stopPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log('[StockBar] 停止轮询');
  }
}

/**
 * 重启轮询（间隔变化时）
 */
function restartPolling(intervalSeconds: number): void {
  stopPolling();
  startPolling(intervalSeconds);
}
