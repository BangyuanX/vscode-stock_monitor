# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

VSCode 状态栏股票/加密货币/外汇监控扩展。每个品种独立显示在状态栏，支持 A 股、港股、美股（盘前/盘后/夜盘）、加密货币、外汇汇率。

## Build & Dev

```bash
# 安装依赖
pnpm install

# 编译（esbuild 打包，含 iconv-lite 内联）
pnpm run compile

# 监听模式重新编译
pnpm run watch

# 仅类型检查（不输出文件）
pnpm run typecheck

# 打包 .vsix（用于发布）
npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license

# VSCode 扩展调试
# F5 启动 Extension Development Host
```

**重要：** 依赖管理使用 pnpm。`vsce package` 时必须加 `--no-dependencies` 参数，因为 pnpm 的 node_modules 结构与 npm 不兼容。

**关键 .vscodeignore 说明：** `node_modules/**` 在 vsce 中已是硬编码默认排除项，无需在 .vscodeignore 中声明。运行时依赖通过 esbuild 打包进 `out/extension.js`。

## Architecture

### 数据流

```
VSCode 配置 (stock-bar.codes)
    ↓
config.ts → 解析 → AppConfig { stockCodes, format, precision, premiumCodes, priceScale... }
    ↓
extension.ts (activate → refreshAll → setInterval)
    ↓
stockApi.ts → fetchStocks(codes, premiumCodes):
  ├─ 新浪 HTTPS (hq.sinajs.cn): sh/sz/bj/hk/usr_/fx_ → GBK 解码
  │    ├─ sh/sz/bj/hk → parseSinaCnFields
  │    ├─ usr_       → parseSinaUsFields（含盘前/盘后判断）
  │    └─ fx_        → parseSinaForexFields
  ├─ Binance data-api: BTC-USD/MUBUSDT 等
  └─ 东财/深交所: premiumCodes 中 ETF 的 IOPV
    ↓
StatusBarManager ← statusBar.ts
  ├─ update(): 创建/更新/销毁 StatusBarItem
  │   格式：formatTicker(data, precision, scale) → applyFormat(template)
  │   悬浮：buildTooltip(data, precision)
  └─ 左对齐，优先级从 100 递减
```

### 网络层

`directHttp.ts` 实现底层 HTTP(S) GET，基于 `net`/`tls` socket 直接构建请求报文（支持 chunked transfer-encoding、增量 HTTP 响应解析、不依赖 connection close 事件、GBK 解码）。无代理依赖，全程直连。

### 数据源

| 市场 | 数据源 | 协议 | 说明 |
|------|--------|------|------|
| A 股/港股 | `hq.sinajs.cn` | HTTPS | 新浪财经，GBK 解码 |
| 美股（含盘前/盘后） | `hq.sinajs.cn` | HTTPS | 新浪 `usr_` 前缀，根据美东时间自动判断时段 |
| 外汇 | `hq.sinajs.cn` | HTTPS | 新浪 `fx_` 前缀 |
| 加密货币 | `data-api.binance.vision` | HTTPS | Binance 官方，24hr ticker |
| ETF IOPV | `push2.eastmoney.com` / `szse.cn` | HTTPS | 东方财富 / 深交所 |

### 美股交易时段判断

新浪不直接提供 `marketState` 字段，通过 `getEtSession()` 根据美东时间判断：

| 时段 | 美东时间 | 状态栏标记 | 价格来源 |
|------|---------|-----------|---------|
| 盘前 | 4:00 - 9:30 | 🌅 | `fields[21]`（盘前价格） |
| 盘中 | 9:30 - 16:00 | （无） | `fields[1]`（实时价格） |
| 盘后 | 16:00 - 20:00 | 🌙 | `fields[21]`（盘后价格） |
| 夜盘 | 20:00 - 4:00 | 🌃 | `fields[21]`（夜盘价格） |

### 文件职责

| 文件 | 职责 |
|------|------|
| `extension.ts` | 激活入口、命令注册、轮询调度 |
| `config.ts` | 读取 VSCode 配置 → AppConfig |
| `statusBar.ts` | StatusBarManager：创建/更新/销毁状态栏项 |
| `types.ts` | 类型定义 + 格式化函数（formatPrice/formatPercent/buildTooltip） |
| `api/stockApi.ts` | 数据源路由（新浪 → Binance → IOPV） |
| `api/directHttp.ts` | 原始 socket HTTP 客户端（增量解析、GBK 解码） |

### StatusBar 优先级

所有项左对齐，优先级从 `100` 递减（第一项优先级最高）。加载占位优先级 `100`。

### 关键配置项

| 配置 | 类型 | 说明 |
|------|------|------|
| `codes` | `string[]` | 监控品种列表 |
| `format` | `string` | 显示模板，支持 `${icon}${name}${price}${change}${percent}${code}${session}` |
| `precision` | `object` | 小数位数覆盖，key 为品种代码 |
| `scale` | `object` | 显示乘数（如 `fx_sjpycnh: 100`） |
| `premiumCodes` | `string[]` | 需要显示 ETF 溢价率的代码（tooltip 中查看） |
