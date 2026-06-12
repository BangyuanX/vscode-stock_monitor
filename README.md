# Stock Bar Monitor

轻量级 VSCode 状态栏股票/加密货币/外汇监控插件。

## 特性

- 📊 **状态栏实时行情** — 每个品种独立显示，不占用额外空间
- 🌐 **全市场覆盖** — A股、港股、美股（含盘前/盘后）、加密货币、外汇
- 💱 **外汇汇率** — 支持直盘/交叉盘，可配置乘数显示（如 JPY×100）
- 📈 **ETF 溢价率** — 深交所 IOPV 实时净值，悬浮查看
- 🎨 **自定义显示模板** — 自由组合字段
- 🎯 **涨跌颜色** — 红跌绿涨，一目了然
- ⚡ **自动刷新** — 可配置刷新间隔（最小 3 秒）
- 🛡️ **无代理依赖** — 直连数据源，家里和公司网络均可用

## 支持的品种

| 类型 | 代码格式 | 示例 | 数据源 |
|------|---------|------|--------|
| A 股（上证） | `sh` + 6 位代码 | `sh000001` | 新浪 HTTPS |
| A 股（深证） | `sz` + 6 位代码 | `sz000001` | 新浪 HTTPS |
| A 股（北证） | `bj` + 6 位代码 | `bj830799` | 新浪 HTTPS |
| 港股 | `hk` + 5 位代码 | `hk00700` | 新浪 HTTPS |
| 美股 | `usr_` + 代码 | `usr_nvda` | 新浪 HTTPS（含盘前/盘后） |
| 加密货币 | `BTC-USD` / `crypto:BTCUSDT` | `BTC-USD` | Binance data-api |
| 美股代币 | 直接写交易对 | `MUBUSDT` | Binance data-api |
| 外汇 | `fx_` + 货币对 | `fx_sjpycnh` | 新浪 HTTPS |

### 外汇货币对照

| 配置代码 | 含义 |
|---------|------|
| `fx_susdcny` | 美元/人民币（在岸） |
| `fx_susdcnh` | 美元/离岸人民币 |
| `fx_sjpycny` | 日元/人民币 |
| `fx_sjpycnh` | 日元/离岸人民币 |
| `fx_seurcny` | 欧元/人民币 |
| `fx_sgbpcny` | 英镑/人民币 |
| `fx_saudcny` | 澳元/人民币 |
| `fx_susdhkd` | 美元/港元 |
| `fx_susdjpy` | 美元/日元 |

## 安装

### 方式一：永久安装（推荐）

已通过符号链接安装到 VSCode 扩展目录：

```bash
# 扩展已在 ~/.vscode/extensions/bangyuan.stock-bar-monitor
# 修改源码后只需要重新编译即可生效：
cd ~/Github/stock-bar-monitor
pnpm run compile
```

然后重启 VSCode 或按 `Cmd+Shift+P` → `Developer: Reload Window`。

### 方式二：调试模式（开发用）

1. VSCode 打开项目文件夹
2. 按 `F5` 启动扩展开发主机

## 管理监控品种

### 通过命令面板（推荐）

按 `Cmd+Shift+P`，然后：

| 命令 | 说明 |
|------|------|
| `Stock Bar: 添加监控品种` | 输入代码添加 |
| `Stock Bar: 移除监控品种` | 勾选要删除的品种，支持多选 |
| `Stock Bar: 打开设置` | 直接跳转到设置页 |
| `Stock Bar: 立即刷新行情` | 手动触发刷新 |

### 通过 VSCode 设置

搜索 `stock-bar.codes`，直接编辑 JSON 数组：

```json
"stock-bar.codes": [
  "sh000001",
  "sz159501",
  "usr_nvda",
  "usr_mrvl",
  "BTC-USD",
  "fx_sjpycnh"
]
```

## 完整设置项

```jsonc
{
  // 监控的品种列表
  "stock-bar.codes": [
    "sh000001",      // 上证指数
    "sz159501",      // 纳指ETF（深交所）
    "usr_nvda",      // 英伟达（新浪美股）
    "usr_mrvl",      // 迈威尔科技
    "BTC-USD",       // 比特币（Binance）
    "MUBUSDT",       // 微策略代币（Binance）
    "fx_sjpycnh"     // 日元/离岸人民币
  ],

  // 刷新间隔（秒），默认 5，最小 3
  "stock-bar.interval": 5,

  // 状态栏显示模板
  // 支持: ${icon} ${name} ${price} ${change} ${percent} ${code} ${session}
  "stock-bar.format": "${icon}${name} ${price}",

  // 状态栏最多显示的品种数
  "stock-bar.maxItems": 6,

  // 上涨颜色（红色，中国习惯）
  "stock-bar.riseColor": "#cc5555",

  // 下跌颜色（绿色，中国习惯）
  "stock-bar.fallColor": "#4a9e4a",

  // 平盘颜色（留空使用默认）
  "stock-bar.flatColor": "",

  // 小数位数覆盖（按品种代码配置）
  // 未配置的品种自动判断：>100 取2位，>1 取3位，<1 取4位
  "stock-bar.precision": {
    "default": 2,
    "sh000001": 2,
    "sz159501": 3,
    "usr_mrvl": 0,
    "fx_sjpycnh": 4
  },

  // 价格显示乘数（如 JPY ×100）
  // 乘以指定倍数后显示，不影响原始数据
  "stock-bar.scale": {
    "fx_sjpycnh": 100
  },

  // 需要显示 ETF 溢价率的品种（悬浮 tooltip 查看）
  "stock-bar.premiumCodes": ["sz159501"]
}
```

## 模板占位符

| 占位符 | 含义 | 示例输出 |
|--------|------|---------|
| `${icon}` | 涨跌图标 | 📈 / 📉 |
| `${name}` | 名称 | 上证指数 |
| `${price}` | 当前价 | 3204.56 |
| `${change}` | 涨跌额 | +8.68 |
| `${percent}` | 涨跌幅 | +0.21% |
| `${code}` | 代码 | sh000001 |
| `${session}` | 交易时段标记（美股） | 🌅 盘前 / 🌙 盘后 |

### 模板示例

| 模板 | 效果 |
|------|------|
| `${icon}${name} ${price}` | 📈上证指数 4066.18 |
| `${icon}${name} ${price} ${change}` | 📈纳指ETF 2.044 +0.034 |
| `${session}${icon}${name} ${price}` | 🌙📈AAPL 150.23（盘后） |
| `${icon}${name} ${price}` | 💱日元兑离岸人民币 4.2179 |

### 悬浮详情（tooltip）

鼠标悬停在状态栏品种上会显示完整行情：

```
纳指ETF嘉实（sz159501）
---
📈 现价: 2.044
  涨跌: +0.034（+1.69%）
  今开: 2.060  昨收: 2.010
  最高: 2.074  最低: 2.036
  时间: 2026-06-12 14:33:45
  溢价: 📈 +8.67%  IOPV: 1.881   ← premiumCodes 配置后显示
```

## 数据源架构

```
配置 → fetchStocks(codes, premiumCodes)
  ├─ sh/sz/bj/hk/usr_/fx_ → 新浪 HTTPS（一次请求全部获取）
  ├─ BTC-USD/MUBUSDT 等   → Binance data-api
  └─ premiumCodes          → 深交所 szse.cn（IOPV 溢价率）
```

所有数据直连获取，不经过代理，不依赖 Yahoo。

## 命令

| 命令 | 说明 |
|------|------|
| `Stock Bar: 添加监控品种` | 输入品种代码添加到监控列表 |
| `Stock Bar: 移除监控品种` | 从列表中移除品种（支持多选） |
| `Stock Bar: 立即刷新行情` | 手动刷新所有数据 |
| `Stock Bar: 打开设置` | 跳转到扩展设置页 |

## 开发

```bash
# 安装依赖
pnpm install

# 编译（esbuild 打包）
pnpm run compile

# 监听模式重新编译
pnpm run watch

# 仅类型检查
pnpm run typecheck

# 打包 .vsix
npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license

# 按 F5 启动 VSCode 扩展调试
```

## 隐私

- **无数据收集**，无网络请求之外的任何遥测
- 代码完全开源，你可以完全掌控
- 所有数据来自公开免费的行情 API
