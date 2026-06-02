#!/bin/bash
# Stock Bar Monitor - 安装脚本
# 在新电脑上运行此脚本即可完成安装

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$HOME/.vscode/extensions/bangyuan.stock-bar-monitor"

echo "📦 安装依赖..."
cd "$PROJECT_DIR"
npm install

echo "🔨 编译 TypeScript..."
npm run compile

echo "🔗 链接到 VSCode 扩展目录..."
mkdir -p "$HOME/.vscode/extensions"
ln -sf "$PROJECT_DIR" "$EXT_DIR"

echo ""
echo "✅ 安装完成！请重启 VSCode 即可使用。"
echo "📍 扩展位置: $EXT_DIR"
echo "📝 项目位置: $PROJECT_DIR"
