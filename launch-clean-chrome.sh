#!/bin/bash
# 启动干净的 Chrome 浏览器（无扩展）用于 PokerSight GTO

CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CLEAN_PROFILE="/tmp/pokersight-chrome-profile"

# 创建干净的配置目录
mkdir -p "$CLEAN_PROFILE"

# 启动 Chrome
# --disable-extensions: 禁用所有扩展
# --disable-plugins: 禁用插件
# --no-first-run: 跳过首次运行向导
# --user-data-dir: 使用独立配置目录
"$CHROME_APP" \
  --disable-extensions \
  --disable-plugins \
  --no-first-run \
  --disable-default-apps \
  --disable-sync \
  --user-data-dir="$CLEAN_PROFILE" \
  "$@"
