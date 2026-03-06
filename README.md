# 債券 ETF 情境損益試算

互動式網頁工具，計算債券 ETF 在不同聯準會利率情境下，2026年4月至12月持有期間的預期損益。

## 功能特色

- 📡 **即時聯邦基金利率** — 透過 FRED API (St. Louis Fed) 自動抓取
- 📊 **9種利率情境** — 從升息三碼到降息五碼全覆蓋
- ⚖️ **CME FedWatch 機率加權** — 計算市場預期下的預期報酬
- 🌙 **Dark / Light Mode** — 右上角一鍵切換
- 📱 **響應式設計** — 支援手機、平板、桌機

## 計算邏輯

| 項目 | 公式 |
|------|------|
| 利息收入 | `(YTM − 管理費) × 9/12` |
| 修正存續期 | `Duration / (1 + YTM)` |
| 價格損益 | `−修正存續期 × 利率變動(%)` |
| 總損益 | 利息收入 + 價格損益 |

## 數據來源

| 數據 | 來源 | 更新方式 |
|------|------|---------|
| 聯邦基金利率 | [FRED API](https://fred.stlouisfed.org/series/FEDFUNDS) | 自動（月度） |
| FedWatch 機率 | [CME FedWatch](https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html) | 固定快照（2026年3月） |
| Fed 點陣圖 | [FOMC SEP 2025年12月](https://www.federalreserve.gov/monetarypolicy/fomcprojtabl20251210.htm) | 固定 |

## 免責聲明

本工具僅供教育及情境分析用途，不構成投資建議。
