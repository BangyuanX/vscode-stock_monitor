# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VSCode 状态栏股票/加密货币监控扩展。每个品种独立显示在状态栏，支持 A 股、港股、美股（盘前/盘后/夜盘）和加密货币。

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
config.ts → 解析 → AppConfig { stockCodes, format, precision... }
    ↓
extension.ts (activate → showLoading → refreshAll → setInterval)
    ↓
stockApi.ts → 按前缀分流：
  ├─ Tencent (qt.gtimg.cn): sh/sz/bj/hk → GBK 编码，~分隔字段
  └─ Yahoo v7 (query1.finance.yahoo.com): usr_ + 无前缀
       └─ 回退 → Sina (hq.sinajs.cn): gb_ 前缀
    ↓
StatusBarManager ← statusBar.ts
  ├─ showLoading(): $(loading~spin) 占位
  └─ update(): 创建/更新/销毁 StatusBarItem（左对齐，按优先级排列）
```

### 网络层

`directHttp.ts` 实现底层 HTTP(S) GET，不使用 `fetch` 或 `axios`，而是基于 `net`/`tls` socket 直接构建请求报文（支持 chunked transfer-encoding、GBK 解码）。内置代理支持：优先 VSCode 设置 `http.proxy`，回退环境变量（Clash 等），代理失败自动回退直连并缓存 2 分钟避让期。

### 文件职责

| 文件 | 职责 |
|------|------|
| `extension.ts` | 激活入口、命令注册、轮询调度 |
| `config.ts` | 读取 VSCode 配置 → AppConfig |
| `statusBar.ts` | StatusBarManager：创建/更新/销毁状态栏项 |
| `types.ts` | 类型定义 + 格式化函数（formatPrice/formatPercent/buildTooltip） |
| `api/stockApi.ts` | 数据源路由（腾讯 → Yahoo v7 → 新浪回退） |
| `api/directHttp.ts` | 原始 socket HTTP 客户端（代理/Cookie/编码解码） |

### Market Sessions（美股交易时段）

Yahoo v7 按 `marketState` 字段自动切换价格来源：
- `REGULAR` → regularMarketPrice
- `PRE` → preMarketPrice (🌅)
- `POST` → postMarketPrice (🌙)
- `OVERNIGHT` → overnightMarketPrice (🌃)

Yahoo v7 需要 cookie (A1) + crumb 认证，获取后缓存复用。Cookie 失效时自动清除并重试。

### StatusBar 优先级

所有项左对齐，优先级从 `100` 递减（第一项优先级最高）。加载占位优先级 `100`。
