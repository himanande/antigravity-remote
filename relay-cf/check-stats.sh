#!/bin/sh
# 運営者用: マネージドリレーの日次集計を見る。鍵は .stats-key.local から読む。
# 使い方: ./check-stats.sh [日数]
KEY=$(cat "$(dirname "$0")/.stats-key.local" 2>/dev/null) || { echo "鍵が見つかりません: relay-cf/.stats-key.local"; exit 1; }
curl -s -m 30 "https://relay.termhop.dev/stats?key=$KEY&days=${1:-14}" | python3 -m json.tool
