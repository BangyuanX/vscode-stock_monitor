import * as vscode from 'vscode';
import { readConfig, onConfigChanged } from './config';
import { fetchStocks } from './api/stockApi';
import { StatusBarManager } from './statusBar';
import { StockData } from './types';

let statusBarManager: StatusBarManager;
let pollingTimer: NodeJS.Timeout | null = null;
let isRefreshing = false;

export function activate(context: vscode.ExtensionContext) {
  console.log('[StockBar] 扩展已激活');

  // 创建状态栏管理器
  statusBarManager = new StatusBarManager();

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('stock-bar.refresh', () => {
      refreshAll();
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
        placeHolder: '示例: sh000001, hk00700, usr_aapl, crypto:BTCUSDT',
        ignoreFocusOut: true,
      });
      if (!code) return;
      const config = vscode.workspace.getConfiguration('stock-bar');
      const codes = config.get<string[]>('codes', []);
      const trimmed = code.trim();
      if (codes.includes(trimmed)) {
        vscode.window.showInformationMessage(`「${trimmed}」已在监控列表中`);
        return;
      }
      codes.push(trimmed);
      await config.update('codes', codes, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`已添加「${trimmed}」`);
      refreshAll();
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
      const newCodes = codes.filter(c => !selected.includes(c));
      await config.update('codes', newCodes, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `已移除 ${selected.length} 个品种`,
      );
      refreshAll();
    }),
  );

  // 显示初始加载状态
  statusBarManager.showLoading();

  // 应用配置
  applyConfig(context);

  // 初次刷新
  refreshAll();

  console.log('[StockBar] 扩展初始化完成');
}

export function deactivate() {
  console.log('[StockBar] 扩展去激活');
  stopPolling();
  if (statusBarManager) {
    statusBarManager.dispose();
  }
}

/**
 * 读取配置并应用到管理器
 */
function applyConfig(context: vscode.ExtensionContext): void {
  const config = readConfig();

  statusBarManager.setColors(config.riseColor, config.fallColor, config.flatColor);
  statusBarManager.setMaxItems(config.maxItems);
  statusBarManager.setPrecision(config.precision, config.defaultPrecision);

  // 重启轮询（如果间隔变化）
  restartPolling(config.interval);

  // 监听配置变更
  onConfigChanged(newConfig => {
    console.log('[StockBar] 配置已变更，重新应用');
    statusBarManager.setColors(newConfig.riseColor, newConfig.fallColor, newConfig.flatColor);
    statusBarManager.setMaxItems(newConfig.maxItems);
    statusBarManager.setPrecision(newConfig.precision, newConfig.defaultPrecision);
    restartPolling(newConfig.interval);
    refreshAll();
  }, context);
}

/**
 * 刷新所有行情数据
 */
async function refreshAll(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const config = readConfig();
    const allData: StockData[] = [];

    // 统一通过 Yahoo v7 + 腾讯获取所有品种数据
    const stockMap = await fetchStocks(config.stockCodes);

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

    // 更新状态栏
    statusBarManager.update(allData, config.format);

    // 更新状态栏图标提示（第一个项显示最后更新时间）
    const lastItem = statusBarManager.getAllItems()[0];
    if (lastItem) {
      // 无需额外操作，tooltip 已包含时间
    }
  } catch (err) {
    console.error('[StockBar] 刷新失败:', err);
  } finally {
    isRefreshing = false;
  }
}

/**
 * 启动轮询
 */
function startPolling(intervalSeconds: number): void {
  if (pollingTimer) return;
  const ms = intervalSeconds * 1000;
  console.log(`[StockBar] 启动轮询，间隔 ${intervalSeconds}s`);
  pollingTimer = setInterval(refreshAll, ms);
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
