import * as vscode from 'vscode';
import { readConfig } from './config';

const SYNC_KEY = 'stock-bar.synced-config.v1';
const LOCAL_APPLIED_KEY = 'stock-bar.synced-config.applied-id';
const LOCAL_APPLIED_VALUES_KEY = 'stock-bar.synced-config.applied-values';
const SYNC_VERSION = 5;

interface SyncedConfigValues {
  codes: string[];
  statusBarCodes: string[] | null;
  interval: number;
  format: string;
  precision: Record<string, number>;
  maxItems: number;
  riseColor: string;
  fallColor: string;
  flatColor: string;
  premiumCodes: string[];
  scale: Record<string, number>;
}

interface SyncedConfigSnapshot {
  version: number;
  id: string;
  updatedAt: number;
  values: SyncedConfigValues;
}

const SETTING_KEYS: ReadonlyArray<keyof SyncedConfigValues> = [
  'codes',
  'statusBarCodes',
  'interval',
  'format',
  'precision',
  'maxItems',
  'riseColor',
  'fallColor',
  'flatColor',
  'premiumCodes',
  'scale',
];

/** 将 Stock Bar 配置保存到 VS Code 可跨设备同步的扩展 globalState。 */
export class SyncStateManager implements vscode.Disposable {
  private applyingSnapshot = false;
  private syncPaused = false;
  private captureTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    context.globalState.setKeysForSync([SYNC_KEY]);
  }

  async initialize(): Promise<void> {
    const synced = this.getSyncedSnapshot();
    const localValues = readLocalValues();
    const appliedId = this.context.globalState.get<string>(LOCAL_APPLIED_KEY, '');

    if (!synced) {
      await this.publishLocalValues(localValues, true);
    } else if (sameValues(localValues, synced.values)) {
      await this.markApplied(synced.id, synced.values);
    } else if (!appliedId && hasExplicitLocalSettings()) {
      const choice = await vscode.window.showWarningMessage(
        '检测到一份云端 Stock Bar 配置，但本机也有不同配置。请选择要保留的版本。',
        { modal: true },
        '使用云端配置',
        '保留本机并上传',
      );
      if (choice === '使用云端配置') {
        await this.applySnapshot(synced);
      } else if (choice === '保留本机并上传') {
        await this.publishLocalValues(localValues, true);
      } else {
        this.syncPaused = true;
      }
    } else if (synced.id !== appliedId || !appliedId) {
      await this.applySnapshot(synced);
    } else {
      await this.publishLocalValues(localValues, true);
    }

    this.disposables.push(
      vscode.window.onDidChangeWindowState(event => {
        if (event.focused) void this.pullNewerSnapshot(false);
      }),
    );
    this.pollTimer = setInterval(() => void this.pullNewerSnapshot(false), 30_000);
  }

  handleConfigurationChange(): void {
    if (this.applyingSnapshot || this.syncPaused) return;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined;
      void this.publishLocalValues(readLocalValues(), false);
    }, 250);
  }

  async syncNow(): Promise<void> {
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = undefined;
    }
    const localValues = readLocalValues();
    const appliedId = this.context.globalState.get<string>(LOCAL_APPLIED_KEY, '');
    const synced = this.getSyncedSnapshot();
    if (synced && synced.id !== appliedId) {
      if (this.syncPaused || this.hasUnpublishedLocalChanges(localValues)) {
        const choice = await vscode.window.showWarningMessage(
          '云端和本机的 Stock Bar 配置都发生了变化。请选择要保留的版本。',
          { modal: true },
          '使用云端配置',
          '保留本机并上传',
        );
        if (choice === '使用云端配置') {
          this.syncPaused = false;
          await this.applySnapshot(synced);
        } else if (choice === '保留本机并上传') {
          this.syncPaused = false;
          await this.publishLocalValues(localValues, true);
        } else {
          return;
        }
      } else {
        await this.applySnapshot(synced);
      }
      vscode.window.showInformationMessage('Stock Bar 配置同步完成');
      return;
    }

    this.syncPaused = false;
    await this.publishLocalValues(localValues, true);
    vscode.window.showInformationMessage('Stock Bar 配置已交给 VS Code Settings Sync 后台同步');
  }

  private async pullNewerSnapshot(showMessage: boolean): Promise<void> {
    if (this.applyingSnapshot || this.syncPaused) return;
    const synced = this.getSyncedSnapshot();
    const appliedId = this.context.globalState.get<string>(LOCAL_APPLIED_KEY, '');
    if (!synced || synced.id === appliedId) return;
    if (this.captureTimer || this.hasUnpublishedLocalChanges(readLocalValues())) return;
    await this.applySnapshot(synced);
    if (showMessage) {
      vscode.window.showInformationMessage('已应用最新的云端 Stock Bar 配置');
    }
  }

  private async publishLocalValues(
    values: SyncedConfigValues,
    force: boolean,
  ): Promise<void> {
    if (this.applyingSnapshot) return;
    const current = this.getSyncedSnapshot();
    if (!force && current && sameValues(current.values, values)) {
      await this.markApplied(current.id, current.values);
      return;
    }

    const updatedAt = Math.max(Date.now(), (current?.updatedAt ?? 0) + 1);
    const snapshot: SyncedConfigSnapshot = {
      version: SYNC_VERSION,
      id: createSnapshotId(),
      updatedAt,
      values,
    };
    await this.context.globalState.update(SYNC_KEY, snapshot);
    await this.markApplied(snapshot.id, snapshot.values);
  }

  private async applySnapshot(snapshot: SyncedConfigSnapshot): Promise<void> {
    this.applyingSnapshot = true;
    try {
      const config = vscode.workspace.getConfiguration('stock-bar');
      for (const key of SETTING_KEYS) {
        await config.update(
          key,
          snapshot.values[key],
          vscode.ConfigurationTarget.Global,
        );
      }
      await this.markApplied(snapshot.id, snapshot.values);
    } finally {
      this.applyingSnapshot = false;
    }
  }

  private getSyncedSnapshot(): SyncedConfigSnapshot | undefined {
    const value = this.context.globalState.get<unknown>(SYNC_KEY);
    return parseSyncedConfigSnapshot(value);
  }

  private hasUnpublishedLocalChanges(values: SyncedConfigValues): boolean {
    const appliedValues = this.context.globalState.get<SyncedConfigValues | undefined>(
      LOCAL_APPLIED_VALUES_KEY,
    );
    return appliedValues !== undefined && !sameValues(values, appliedValues);
  }

  private async markApplied(
    snapshotId: string,
    values: SyncedConfigValues,
  ): Promise<void> {
    await this.context.globalState.update(LOCAL_APPLIED_KEY, snapshotId);
    await this.context.globalState.update(LOCAL_APPLIED_VALUES_KEY, values);
  }

  dispose(): void {
    if (this.captureTimer) clearTimeout(this.captureTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function readLocalValues(): SyncedConfigValues {
  const config = readConfig();
  return {
    codes: config.stockCodes,
    statusBarCodes: config.statusBarCodes,
    interval: config.interval,
    format: config.format,
    precision: config.precision,
    maxItems: config.maxItems,
    riseColor: config.riseColor,
    fallColor: config.fallColor,
    flatColor: config.flatColor,
    premiumCodes: config.premiumCodes,
    scale: config.priceScale,
  };
}

function hasExplicitLocalSettings(): boolean {
  const config = vscode.workspace.getConfiguration('stock-bar');
  return SETTING_KEYS.some(key => {
    const inspected = config.inspect(key);
    return inspected?.globalValue !== undefined
      || inspected?.workspaceValue !== undefined
      || inspected?.workspaceFolderValue !== undefined;
  });
}

function sameValues(left: SyncedConfigValues, right: SyncedConfigValues): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createSnapshotId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function parseSyncedConfigSnapshot(value: unknown): SyncedConfigSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<SyncedConfigSnapshot>;
  if (
    (candidate.version !== 1
      && candidate.version !== 2
      && candidate.version !== 3
      && candidate.version !== 4
      && candidate.version !== SYNC_VERSION)
    || typeof candidate.id !== 'string'
    || typeof candidate.updatedAt !== 'number'
    || !candidate.values
    || typeof candidate.values !== 'object'
  ) {
    return undefined;
  }
  const values = candidate.values as Partial<SyncedConfigValues>;
  const valid = Array.isArray(values.codes)
    && (values.statusBarCodes === null || Array.isArray(values.statusBarCodes))
    && typeof values.interval === 'number'
    && typeof values.format === 'string'
    && typeof values.precision === 'object'
    && typeof values.maxItems === 'number'
    && typeof values.riseColor === 'string'
    && typeof values.fallColor === 'string'
    && typeof values.flatColor === 'string'
    && Array.isArray(values.premiumCodes)
    && typeof values.scale === 'object';
  if (!valid) return undefined;
  return {
    version: SYNC_VERSION,
    id: candidate.id,
    updatedAt: candidate.updatedAt,
    values: {
      codes: values.codes as string[],
      statusBarCodes: values.statusBarCodes as string[] | null,
      interval: values.interval as number,
      format: values.format as string,
      precision: values.precision as Record<string, number>,
      maxItems: values.maxItems as number,
      riseColor: values.riseColor as string,
      fallColor: values.fallColor as string,
      flatColor: values.flatColor as string,
      premiumCodes: values.premiumCodes as string[],
      scale: values.scale as Record<string, number>,
    },
  };
}
