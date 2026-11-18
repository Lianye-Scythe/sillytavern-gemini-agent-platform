# Gemini Agent Platform for SillyTavern

在 SillyTavern 中使用 Google Cloud API Key 連接 Gemini Enterprise Agent Platform，無須服務帳號 JSON。

擴充會新增獨立的 **Gemini Agent Platform** 聊天補全來源，使用 Google Cloud 的 `global` 端點，並整合酒館原生的金鑰管理、測試訊息與連線設定檔。

## 安裝

已於 **SillyTavern 1.19.0** 測試。使用前，請確認 Google Cloud 專案與 API Key 具備所需模型的存取權限。

在酒館開啟「擴充功能 → 安裝擴充功能」，貼上：

```text
https://github.com/Lianye-Scythe/sillytavern-gemini-agent-platform
```

安裝完成後重新整理頁面。

## 使用

1. 在「API 連線」選擇 **聊天補全**。
2. 將來源設為 **Gemini Agent Platform**。
3. 輸入 Google Cloud API Key，並選擇模型。
4. 按酒館原生的 **連線** 儲存金鑰，再按 **測試訊息** 驗證。
5. 如需保留設定，使用酒館原生的連線設定檔儲存。

內建模型 ID：`gemini-4-carbon`、`gemini-4-argon`、`gemini-3.8-flash`。其他模型可在「進階設定」手動加入；是否可用取決於 Google 與專案權限。

專案預設自動偵測。若偵測失敗，可在「進階設定」填入金鑰所屬的 Project ID 或 Project Number。

## 注意事項

- 此來源固定直連 Google Cloud，不使用酒館的反向代理。
- 金鑰交由酒館原生儲存，與 **Google Vertex AI Express** 共用金鑰欄位；服務帳號 JSON 使用另一個欄位。
- 擴充沿用酒館的 Vertex AI 後端。工具呼叫、思考與多模態功能依酒館版本而定；尚未實作 Gemini 4 超長輸出的續傳流程。
- Google 的模型權限、計費與配額仍適用。

## 更新

在酒館擴充清單更新後，重新整理頁面。「進階設定」中的 **實際執行版本** 應與擴充清單一致；若出現重複載入警告，請停用舊副本後再重新整理。

## 授權

[MIT](LICENSE)。本專案為社群擴充，與 Google、SillyTavern 無隸屬關係。
