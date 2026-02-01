#!/bin/bash
# PokerSight GTO 一键开发启动脚本

cd "$(dirname "$0")"

echo "🎯 启动 PokerSight GTO 开发环境..."

# 启动开发服务器（后台运行）
npm run dev &
DEV_PID=$!

# 等待服务器启动
sleep 3

# 启动干净的 Chrome（无扩展）
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CLEAN_PROFILE="/tmp/pokersight-chrome-profile"
mkdir -p "$CLEAN_PROFILE"

"$CHROME_APP" \
  --disable-extensions \
  --disable-plugins \
  --no-first-run \
  --disable-default-apps \
  --disable-sync \
  --user-data-dir="$CLEAN_PROFILE" \
  "http://localhost:3000" &

echo "✅ 开发服务器 PID: $DEV_PID"
echo "✅ 干净的 Chrome 已启动"
echo ""
echo "按 Ctrl+C 停止开发服务器"

# 等待开发服务器
wait $DEV_PID
