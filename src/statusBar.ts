import * as vscode from 'vscode';
import { StockData, formatTicker, applyFormat, buildTooltip } from './types';

/**
 * 状态栏管理器
 * 负责创建/更新/销毁 StatusBarItem
 */
export class StatusBarManager {
  private items: Map<string, vscode.StatusBarItem> = new Map();
  private itemOrder: string[] = [];
  private riseColor: string = '#cc5555';
  private fallColor: string = '#4a9e4a';
  private flatColor: string = '';
  private maxItems: number = 6;
  private precision: Record<string, number> = {};
  private defaultPrecision: number = -1;
  private priceScale: Record<string, number> = {};

  /** 占位状态栏项（加载中提示） */
  private loadingItem?: vscode.StatusBarItem;

  /**
   * 显示加载中的占位提示
   */
  showLoading(): void {
    if (!this.loadingItem) {
      this.loadingItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100,
      );
      this.loadingItem.text = '$(loading~spin) StockBar';
      this.loadingItem.tooltip = '正在获取行情数据...';
      this.loadingItem.show();
    }
  }

  /**
   * 隐藏加载提示
   */
  private hideLoading(): void {
    if (this.loadingItem) {
      this.loadingItem.dispose();
      this.loadingItem = undefined;
    }
  }

  /**
   * 更新颜色配置
   */
  setColors(rise: string, fall: string, flat: string): void {
    this.riseColor = rise;
    this.fallColor = fall;
    this.flatColor = flat;
  }

  /**
   * 设置最大显示数量
   */
  setMaxItems(max: number): void {
    this.maxItems = max;
  }

  setPrecision(precision: Record<string, number>, defaultPrecision: number): void {
    this.precision = precision;
    this.defaultPrecision = defaultPrecision;
  }

  setScale(scale: Record<string, number>): void {
    this.priceScale = scale;
  }

  /**
   * 批量更新状态栏显示
   * @param dataList 行情数据列表
   * @param template 显示模板
   */
  update(dataList: StockData[], template: string): void {
    // 有数据到达时隐藏加载提示
    if (this.loadingItem) {
      this.hideLoading();
    }
    // 限制显示数量
    const limited = dataList.slice(0, this.maxItems);
    const nextOrder = limited.map(data => data.code);
    if (!sameOrder(this.itemOrder, nextOrder)) {
      // StatusBarItem 的 priority 创建后不可修改；排序变化时必须重建。
      this.disposeItems();
      this.itemOrder = nextOrder;
    }
    const activeCodes = new Set<string>();

    for (let i = 0; i < limited.length; i++) {
      const data = limited[i];

      // 获取失败的品种显示错误标记
      if (data.error) {
        const errorText = `⛔${data.code}`;
        const errorTooltip = `${data.code}: ${data.error}\n下次刷新自动重试`;
        activeCodes.add(data.code);
        this.createOrUpdateItem(data.code, errorText, errorTooltip, this.flatColor || '#888888', i);
        continue;
      }

      // 按代码查找精度和显示乘数
      const prec = this.precision[data.code] ?? this.defaultPrecision;
      const precision = prec >= 0 ? prec : undefined;
      const scale = this.priceScale[data.code] || 1;
      const display = formatTicker(data, precision, scale);
      const formattedText = applyFormat(template, display);
      const text = data.stale ? `$(warning) ${formattedText}` : formattedText;
      const tooltip = buildTooltip(data, precision, scale);
      const color = this.getColor(data.changePercent);

      activeCodes.add(data.code);
      this.createOrUpdateItem(data.code, text, tooltip, color, i);
    }

    // 移除不再显示的品种
    for (const [code, item] of this.items) {
      if (!activeCodes.has(code)) {
        item.dispose();
        this.items.delete(code);
      }
    }
  }

  /**
   * 获取所有状态栏项
   */
  getAllItems(): vscode.StatusBarItem[] {
    return Array.from(this.items.values());
  }

  /**
   * 清空所有状态栏项
   */
  dispose(): void {
    this.disposeItems();
    this.itemOrder = [];
    this.hideLoading();
  }

  private disposeItems(): void {
    for (const item of this.items.values()) {
      item.dispose();
    }
    this.items.clear();
  }

  /**
   * 创建或更新单个状态栏项
   */
  private createOrUpdateItem(
    code: string,
    text: string,
    tooltip: string,
    color: string,
    priorityOffset: number,
  ): void {
    let item = this.items.get(code);
    if (!item) {
      // 左对齐，优先级从高到低依次排列
      item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100 - priorityOffset,
      );
      item.command = 'stock-bar.refresh';
      this.items.set(code, item);
    }

    item.text = text;
    item.tooltip = tooltip;
    item.color = color || undefined;
    item.show();
  }

  /**
   * 根据涨跌确定颜色
   */
  private getColor(changePercent: number): string {
    if (changePercent > 0) return this.riseColor;
    if (changePercent < 0) return this.fallColor;
    return this.flatColor;
  }
}

function sameOrder(current: readonly string[], next: readonly string[]): boolean {
  return current.length === next.length && current.every((code, index) => code === next[index]);
}
