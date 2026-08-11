# Stock Bar Monitor

轻量级 VSCode 状态栏与分类侧边栏股票/加密货币/外汇监控插件。

## 特性

- 📊 **状态栏实时行情** — 每个品种独立显示，不占用额外空间
- 🗂️ **分类行情侧边栏** — 按 A股、港股、美股、加密货币和外汇展示全部自选标的
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
| 港股 | `hk` + 5 位代码 | `hk00700` | 新浪 HTTPS（免费延迟行情） |
| 美股 | `usr_` + 代码 | `usr_nvda` | 新浪 HTTPS（含盘前/盘后） |
| 加密货币 | `BTC/USDT`（标准格式） | `BTC/USDT` | Binance data-api |
| 美股代币 | `NVDA/USDT` / `MUB/USDT` | `NVDA/USDT` | Binance data-api |
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

### 方式一：VSIX 安装（推荐）

当前使用的是 VSIX 安装。修改源码后，仅运行 `pnpm run compile` 不会更新 VS Code 已安装的扩展副本；需要重新打包并安装：

```bash
cd ~/Github/stock-bar-monitor
pnpm run compile
npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
code --install-extension stock-bar-monitor-<版本号>.vsix --force
```

然后重启 VSCode 或按 `Cmd+Shift+P` → `Developer: Reload Window`。

### 方式二：调试模式（开发用）

1. VSCode 打开项目文件夹
2. 按 `F5` 启动扩展开发主机

## 管理监控品种

### 通过行情侧边栏

点击 Activity Bar 中的 Stock Bar 图标即可打开“自选行情”侧边栏。侧边栏始终展示全部自选标的，并按市场自动分组。

- 每行显示涨跌图标、名称、价格和括号内的涨跌幅；价格与涨跌幅使用独立的右对齐网格列。
- 鼠标移入任意行情行后会快速显示自定义详情浮层，不再依赖浏览器原生的慢速提示。
- 港股等已知延迟行情会在名称后显示黄色 `D` 标记。
- 点击行尾图钉可固定/取消固定到状态栏；实心图钉表示当前正在状态栏显示。
- 按住行尾拖动手柄，可在同一市场分组内上下排序。
- 点击行尾叉号可从自选列表移除，执行前会再次确认。
- 点击价格可单独设置该标的的小数位数，也可以使用侧栏标题栏的数字按钮集中管理。
- 状态栏中的标的始终按照侧边栏从上到下的顺序排列。
- 默认状态栏显示侧边栏顺序中的前 `maxItems` 个；点击任意图钉后改用显式选择。

### 在多台电脑间同步

Stock Bar 使用 VS Code 的扩展专用同步状态保存行情配置，包括自选代码及顺序、状态栏图钉、小数位数、显示乘数、刷新间隔、格式和颜色。数据不会依赖手工维护一份 `settings.json`。

1. 在两台电脑的 VS Code 中，通过账户菜单打开 **Backup and Sync Settings**，并登录同一个 GitHub 或 Microsoft 账号。
2. 两台电脑都安装同一版本的 Stock Bar；本地 VSIX 不会自动从 Marketplace 安装，需要分别安装一次。
3. 在第一台电脑执行 `Stock Bar: 立即同步配置`，等待 VS Code 完成后台 Settings Sync。
4. 在第二台电脑重新加载窗口；插件会自动应用云端配置，也可以执行同一命令立即检查。
5. 如果第二台电脑已有不同配置，插件会要求选择“使用云端配置”或“保留本机并上传”，不会静默覆盖。

同步机制参见 [VS Code Settings Sync](https://code.visualstudio.com/docs/configure/settings-sync)。

### 通过命令面板（推荐）

按 `Cmd+Shift+P`，然后：

| 命令 | 说明 |
|------|------|
| `Stock Bar: 添加监控品种` | 输入代码添加 |
| `Stock Bar: 移除监控品种` | 勾选要删除的品种，支持多选 |
| `Stock Bar: 设置标的小数位数` | 通过选择界面设置自动或 0–8 位小数 |
| `Stock Bar: 立即同步配置` | 保存本机配置或应用最新的云端配置 |
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
  "BTC/USDT",
  "MUB/USDT",
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
    "BTC/USDT",      // 比特币（Binance）
    "MUB/USDT",      // 微策略代币（Binance）
    "fx_sjpycnh"     // 日元/离岸人民币
  ],

  // 状态栏显示范围；null 表示显示侧边栏顺序中的前 maxItems 个
  // 设置为数组后，数组中的标的都会显示，顺序仍跟随侧边栏
  "stock-bar.statusBarCodes": null,

  // 刷新间隔（秒），默认 5，最小 3
  "stock-bar.interval": 5,

  // 状态栏显示模板
  // 支持: ${icon} ${name} ${price} ${change} ${percent} ${code} ${session}
  "stock-bar.format": "${icon}${name} ${price}",

  // 使用默认状态栏规则时，最多显示的品种数
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

  // 需要显示 ETF 溢价率的品种（侧边栏悬浮详情中查看）
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

### 详细行情

状态栏只显示实时行情，不再提供悬浮详情。将鼠标移到侧边栏中的品种上，可查看完整行情：

侧边栏行情行不显示额外的涨跌箭头，名称、现价和涨跌幅会作为一个整体跟随行情涨跌着色；侧边栏和悬浮详情复用 `riseColor`、`fallColor`、`flatColor`，与状态栏保持一致，操作按钮保持中性色。

悬浮详情顶部显示名称和代码；日内价格位置条中的低、现、高分别比较涨跌基准价后独立着色。价格条还会用黄色短刻度标出昨收等实际涨跌基准；跳空导致基准落在日内区间外时，刻度会钉在对应边缘并用箭头提示方向。涨跌行只保留涨跌额和涨跌幅，涨跌额与行情价格保持相同的小数位数。行情时间收纳在底部。

```
纳指ETF嘉实                     sz159501
---
涨跌    +0.034 (+1.69%)
溢价    +8.67% (1.881)  ← 括号内为 IOPV
低 2.036 —— 现 2.044 —— 高 2.074
                          2026-06-12 14:33:45
```

平盘时涨跌额和涨跌幅都使用 `±`，例如 `±0.000 (±0.00%)`，确保侧边栏数字对齐。

## 数据源架构

```
配置 → fetchStocks(codes, premiumCodes)
  ├─ sh/sz/bj/hk/usr_/fx_ → 新浪 HTTPS（每 20 个一批）
  ├─ BTC/USDT/MUB/USDT 等 → Binance data-api（每 20 个一批）
  └─ premiumCodes          → 深交所 szse.cn（IOPV 溢价率）
          ↓
  状态栏（前 maxItems 个）+ 分类侧边栏（全部标的）
```

所有行情均直接连接对应数据源。Binance 短暂连接失败时会保留最近 10 分钟内的
成功行情，并以 `!` 和悬浮说明标记缓存数据；这表示本次连接失败，不等同于接口限频。

## 命令

| 命令 | 说明 |
|------|------|
| `Stock Bar: 添加监控品种` | 输入品种代码添加到监控列表 |
| `Stock Bar: 移除监控品种` | 从列表中移除品种（支持多选） |
| `Stock Bar: 设置标的小数位数` | 选择标的并设置价格小数位数 |
| `Stock Bar: 立即同步配置` | 通过 VS Code Settings Sync 同步插件专用配置 |
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
