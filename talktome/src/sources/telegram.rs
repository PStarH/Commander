//! Telegram 数据源
//!
//! 支持 Telegram Desktop 导出的 JSON 格式
//! 隐私级别默认为 Private（仅本地处理）

use anyhow::{Result, Context};
use async_trait::async_trait;
use std::path::PathBuf;
use chrono::{DateTime, Utc};
use uuid::Uuid;
use crate::model::{MemoryFragment, PrivacyLevel, SourceType};
use crate::sources::DataSource;

pub struct TelegramSource {
    export_path: Option<PathBuf>,
}

impl TelegramSource {
    pub fn new() -> Self {
        Self { export_path: None }
    }

    pub fn with_export_path(path: &str) -> Self {
        Self { export_path: Some(PathBuf::from(path)) }
    }

    /// 解析 Telegram 导出的 JSON
    fn parse_export(&self, content: &str) -> Result<Vec<MemoryFragment>> {
        let json: serde_json::Value = serde_json::from_str(content)
            .context("Failed to parse Telegram export JSON")?;

        let mut fragments = Vec::new();
        let source_id = Uuid::new_v4();

        if let Some(messages) = json.get("messages").and_then(|m| m.as_array()) {
            for msg in messages {
                // 跳过服务消息
                if msg.get("type").and_then(|t| t.as_str()) == Some("service") {
                    continue;
                }

                let text = msg.get("text")
                    .and_then(|t| {
                        // text 可能是字符串或数组
                        if let Some(s) = t.as_str() {
                            Some(s.to_string())
                        } else if let Some(arr) = t.as_array() {
                            // 处理带格式文本
                            Some(arr.iter()
                                .filter_map(|v| v.as_str())
                                .collect::<Vec<_>>()
                                .join(""))
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default();

                if text.is_empty() || text.len() < 5 {
                    continue;
                }

                let timestamp = msg.get("date_unixtime")
                    .and_then(|t| t.as_str())
                    .and_then(|s| s.parse::<i64>().ok())
                    .map(|ts| DateTime::from_timestamp(ts, 0).unwrap_or_else(Utc::now))
                    .unwrap_or_else(Utc::now);

                let sender = msg.get("from")
                    .and_then(|f| f.as_str())
                    .map(|s| s.to_string());

                fragments.push(MemoryFragment {
                    id: Uuid::new_v4(),
                    source_id,
                    content: text,
                    timestamp,
                    counterpart: sender,
                    platform: Some("telegram".to_string()),
                    tags: vec!["telegram".to_string(), "chat".to_string()],
                    created_at: Utc::now(),
                    privacy_level: PrivacyLevel::Private,
                });
            }
        }

        Ok(fragments)
    }
}

#[async_trait]
impl DataSource for TelegramSource {
    fn name(&self) -> &str {
        "telegram"
    }

    fn source_type(&self) -> SourceType {
        SourceType::Chat
    }

    fn default_privacy(&self) -> PrivacyLevel {
        PrivacyLevel::Private // 聊天记录默认私密
    }

    fn requires_auth(&self) -> bool {
        false // 使用导出文件，不需要认证
    }

    async fn fetch(&self) -> Result<Vec<MemoryFragment>> {
        let path = self.export_path.as_ref()
            .context("Telegram export path not set. Use with_export_path() to configure.")?;

        let content = tokio::fs::read_to_string(path).await
            .context("Failed to read Telegram export file")?;

        self.parse_export(&content)
    }

    fn instructions(&self) -> String {
        r#"
# Telegram 数据导入

## 导出步骤

1. 打开 Telegram Desktop
2. 进入 Settings → Advanced → Export Telegram data
3. 选择要导出的内容：
   - 个人聊天
   - 群组聊天
   - 频道（可选）
4. 导出格式选择 JSON
5. 解压后找到 `result.json`

## 导入

```rust
let source = TelegramSource::with_export_path("/path/to/result.json");
let fragments = source.fetch().await?;
```

## 隐私说明

- 所有聊天记录默认 PrivacyLevel::Private
- 仅本地存储，不会发送到云端
- 如需 LLM 处理，仅发送摘要（非原文）
"#
        .to_string()
    }
}

impl Default for TelegramSource {
    fn default() -> Self {
        Self::new()
    }
}
