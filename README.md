# Stock Bar Monitor

轻量级 VSCode 状态栏股票/加密货币监控插件。

## 特性

- 📊 **状态栏实时行情** — 每个品种独立显示，不占用额外空间
- 🌐 **全市场覆盖** — A股、港股、美股、加密货币
- 🎨 **自定义显示模板** — 自由组合字段
- 🎯 **涨跌颜色** — 红跌绿涨，一目了然
- ⚡ **自动刷新** — 可配置刷新间隔

## 支持的品种

| 类型 | 代码格式 | 示例 | 数据源 |
|------|---------|------|--------|
| A股（上证） | `sh` + 代码 | `sh000001` | 腾讯行情 |
| A股（深证） | `sz` + 代码 | `sz000001` | 腾讯行情 |
| A股（北证） | `bj` + 代码 | `bj830799` | 腾讯行情 |
| 港股 | `hk` + 代码 | `hk00700` | 腾讯行情 |
| 美股 | `usr_` + 代码 | `usr_aapl` | Yahoo Finance |
| 加密货币 | `crypto:` + 交易对 | `crypto:BTCUSDT` | Bybit 官方 API |

## 安装

### 方式一：永久安装（推荐）

已通过符号链接安装到 VSCode 扩展目录：

```bash
# 扩展已在 ~/.vscode/extensions/bangyuan.stock-bar-monitor
# 修改源码后只需要重新编译即可生效：
cd ~/github/stock-bar-monitor
npm run compile
```

然后重启 VSCode 或按 `Cmd+Shift+P` → `Developer: Reload Window`。

### 方式二：调试模式（开发用）

1. VSCode 打开 `~/github/stock-bar-monitor` 文件夹
2. 按 `F5` 启动扩展开发主机

## 管理监控品种

### 通过命令面板（推荐）

按 `Cmd+Shift+P`，然后：

| 命令 | 说明 |
|------|------|
| `Stock Bar: 添加监控品种` | 输入代码添加，如 `sh000001`、`crypto:BTCUSDT` |
| `Stock Bar: 移除监控品种` | 勾选要删除的品种，支持多选 |
| `Stock Bar: 打开设置` | 直接跳转到设置页 |
| `Stock Bar: 立即刷新行情` | 手动触发刷新 |

### 通过 VSCode 设置

搜索 `stock-bar.codes`，直接编辑 JSON 数组：

```json
"stock-bar.codes": [
  "sh000001",
  "sh601899",
  "hk00700",
  "usr_aapl",
  "crypto:BTCUSDT"
]
```

## 设置

在 VSCode 设置中搜索 `stock-bar`（或执行 `Stock Bar: 打开设置` 命令）：

```jsonc
{
  // 监控的品种列表
  "stock-bar.codes": [
    "sh000001",      // 上证指数
    "sh601899",      // 紫金矿业
    "hk00700",       // 腾讯控股
    "usr_aapl",      // 苹果 (Yahoo Finance)
    "crypto:BTCUSDT" // 比特币 (Yahoo Finance)
  ],

  // 刷新间隔（秒），默认 5，最小 3
  "stock-bar.interval": 5,

  // 状态栏显示模板
  // 支持: ${icon} ${name} ${price} ${change} ${percent} ${code}
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
    "default": 2,          // 全局默认值
    "sh000001": 2,         // 上证指数显示 3204.56
    "sh561580": 3,         // ETF显示三位小数
    "crypto:BTCUSDT": 0,   // BTC显示整数
    "hk00700": 2           // 港股显示两位
  }
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

### 模板示例

| 模板 | 效果 |
|------|------|
| `${icon}${name} ${price}` | 📈上证指数 4066.18 |
| `「${name}」${price}  ${icon}` | 「上证指数」4066.18  📈 |
| `${icon}${name} ${price} ${percent}` | 📈上证指数 4066.18 +0.21% |
| `${name} ${price}` | 上证指数 4066.18 |

## 命令

| 命令 | 说明 |
|------|------|
| `Stock Bar: 添加监控品种` | 输入品种代码添加到监控列表 |
| `Stock Bar: 移除监控品种` | 从列表中移除品种（支持多选） |
| `Stock Bar: 立即刷新行情` | 手动刷新所有数据 |
| `Stock Bar: 打开设置` | 跳转到扩展设置页 |

## 开发

```bash
# 编译
npm run compile

# 监听模式
npm run watch

# 按 F5 启动 VSCode 扩展调试
```

## 隐私

- **无数据收集**，无网络请求之外的任何遥测
- 代码完全开源，你可以完全掌控
- 所有数据来自公开免费的行情 API
