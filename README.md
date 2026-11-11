# SillyTavern Gemini Agent Platform

A small SillyTavern UI extension for **Gemini Enterprise Agent Platform (formerly Vertex AI)** API keys and explicit `global` endpoints. No service-account JSON, server plugin, external proxy, build step, or additional package is required.

## Features

- Adds a separate **Gemini Agent Platform** choice to Chat Completion Source, alongside the existing **Google Vertex AI** choice.
- Provides `gemini-4-carbon`, `gemini-4-argon`, and `gemini-3.8-flash`, plus manual model IDs.
- Provides an API-key setup panel with project auto-discovery and a real connection test.
- Uses the native SillyTavern server for requests and native secret storage for the key.
- Uses an explicit project and `locations/global` for the supported models.
- Keeps native chat formatting, character prompts, streaming and cancellation.
- Allows manually adding future Gemini model IDs.

## Install / 安裝

Requires SillyTavern **1.13.1 or newer** with the Vertex AI API-key, project and region controls. Validation targets the current release; old server-side Gemini conversions may have different feature support.

在酒館開啟「擴充功能 → 安裝擴充功能」，輸入：

```text
https://github.com/Lianye-Scythe/sillytavern-gemini-agent-platform
```

選擇「為自己安裝」，完成後重新整理頁面。也可以把此儲存庫解壓至 `SillyTavern/public/scripts/extensions/third-party/sillytavern-gemini-agent-platform/`，讓該資料夾直接包含 `manifest.json`，再重新整理。

## Connect / 使用

1. 開啟「API 連線」，API 選擇「聊天補全」，來源選擇新增的 **Gemini Agent Platform**。
2. 找到新增的 **Gemini Agent Platform · API Key** 面板。
3. 輸入自己的 **Google Cloud API Key**，選擇模型。這不是 Google AI Studio 的金鑰設定。
4. Project ID / Project Number 可留空，按 **儲存並測試連線**。擴充會嘗試自動取得專案，切到 API Key 模式、指定 `global`，並測試回覆。
5. 顯示成功後即可使用原本的聊天功能，或在此面板切換模型。

原本的 **Google Vertex AI** 來源保留，切回時會還原先前的驗證模式、區域、專案與模型設定。服務帳號 JSON 維持由原本的來源管理。

若自動取得專案失敗，請從 Google Cloud 主控台取得該金鑰所屬的 **Project ID 或 Project Number**，手動填入後重試。更換金鑰時，未手動修改過的專案會重新偵測。要使用其他帳號的 Key，可在原生 Key 管理中切換，再清空本面板的專案欄位並測試。

## How it works

SillyTavern already supports API-key authentication with an explicit project. This extension configures that existing path:

```text
https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models/MODEL_ID:generateContent
```

Streaming uses the same resource with `streamGenerateContent`. The extension does not replace `fetch` or rewrite SillyTavern files. A visible source selector maps the new source to ST's native Vertex AI backend; the original selector remains available to ST and other extensions. A scoped `CHAT_COMPLETION_SETTINGS_READY` hook applies only while the new source is selected, supplies the project, Key mode and global location for its models, clears reverse-proxy fields for these direct Google requests, and omits legacy sampling parameters.

Project discovery sends a request for a deliberately nonexistent model and extracts the project resource from Google's error message. No text generation is requested from an existing model during discovery. Google may change its error format; manual project entry remains available.

## Credentials and limitations

- No credentials, user project IDs or private configuration are bundled.
- Keys are saved through SillyTavern's native `writeSecret` API, not extension settings, localStorage or this repository. Project and model settings are saved with the user's SillyTavern settings.
- This uses the native Vertex AI API-key secret slot. Changing the key also changes the key used by native Vertex AI Express mode; its service-account JSON slot is separate.
- Requests go through your SillyTavern server to Google; there is no third-party relay or telemetry.
- The extension does not grant model access or bypass Google billing, quotas, key restrictions or IAM policies. Connection tests are real API calls and may incur normal usage charges.
- It adds model IDs; it does not fetch Google's complete model catalog.
- Reasoning controls, tool calls, image/audio input and other advanced features depend on the installed SillyTavern backend's model support. In particular, older builds may use default thinking for Gemini 4. These advanced features are not added by this extension.
- Disable the checkbox to stop applying the request hook. Existing native connection settings and the saved Key remain in place.

## References

- [SillyTavern extension development](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [Google Gemini 4 quickstart](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/get-started-with-gemini-4?hl=en)

## License

MIT. Unofficial community extension; not affiliated with Google or SillyTavern.
