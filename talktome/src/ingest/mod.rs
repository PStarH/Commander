//! 数据导入模块

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use std::path::Path;
use uuid::Uuid;

use crate::model::{MemoryFragment, PrivacyLevel, SourceType};
use crate::store::Store;

/// 导入 JSON 聊天记录
pub fn import_json_file(
    store: &Store,
    name: &str,
    path: &Path,
) -> Result<(Uuid, usize)> {
    let content = std::fs::read_to_string(path)
        .context("Failed to read file")?;

    // 尝试解析 JSON
    let json: serde_json::Value = serde_json::from_str(&content)
        .context("Failed to parse JSON")?;

    // 创建数据源
    let source = store.add_source(name, SourceType::Chat)?;

    let mut imported = 0;

    // 尝试解析常见的聊天导出格式
    if let Some(messages) = json.get("messages").and_then(|m| m.as_array()) {
        // WhatsApp / Telegram 风格
        for msg in messages {
            if let Ok(fragment) = parse_message(msg, source.id) {
                store.add_fragment(&fragment)?;
                imported += 1;
            }
        }
    } else if json.is_array() {
        // 直接是消息数组
        for msg in json.as_array().unwrap() {
            if let Ok(fragment) = parse_message(msg, source.id) {
                store.add_fragment(&fragment)?;
                imported += 1;
            }
        }
    }

    Ok((source.id, imported))
}

/// 解析单条消息
fn parse_message(msg: &serde_json::Value, source_id: Uuid) -> Result<MemoryFragment> {
    let content = msg
        .get("text")
        .or_else(|| msg.get("content"))
        .or_else(|| msg.get("body"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let timestamp = msg
        .get("timestamp")
        .or_else(|| msg.get("date"))
        .or_else(|| msg.get("time"))
        .map(parse_timestamp)
        .unwrap_or_else(Utc::now);

    let counterpart = msg
        .get("from")
        .or_else(|| msg.get("sender"))
        .or_else(|| msg.get("author"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let platform = msg
        .get("platform")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(MemoryFragment {
        id: Uuid::new_v4(),
        source_id,
        content,
        timestamp,
        counterpart,
        platform,
        tags: Vec::new(),
        created_at: Utc::now(),
        privacy_level: PrivacyLevel::Private,
    })
}

fn parse_timestamp(value: &serde_json::Value) -> DateTime<Utc> {
    match value {
        serde_json::Value::Number(n) => {
            // Unix timestamp
            if let Some(ts) = n.as_i64() {
                DateTime::from_timestamp(ts, 0).unwrap_or_else(Utc::now)
            } else {
                Utc::now()
            }
        }
        serde_json::Value::String(s) => {
            // ISO 8601
            DateTime::parse_from_rfc3339(s)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now())
        }
        _ => Utc::now(),
    }
}

/// 导入文本文件（简单逐行）
pub fn import_text_file(
    store: &Store,
    name: &str,
    path: &Path,
) -> Result<(Uuid, usize)> {
    let content = std::fs::read_to_string(path)
        .context("Failed to read file")?;

    let source = store.add_source(name, SourceType::Diary)?;

    // 按空行分段，每段作为一个记忆片段
    let paragraphs: Vec<&str> = content.split("\n\n").filter(|p| !p.trim().is_empty()).collect();

    let mut imported = 0;

    for (idx, para) in paragraphs.iter().enumerate() {
        let fragment = MemoryFragment {
            id: Uuid::new_v4(),
            source_id: source.id,
            content: para.trim().to_string(),
            timestamp: Utc::now(),
            counterpart: None,
            platform: None,
            tags: vec![format!("paragraph_{}", idx)],
            created_at: Utc::now(),
            privacy_level: PrivacyLevel::Private,
        };
        store.add_fragment(&fragment)?;
        imported += 1;
    }

    Ok((source.id, imported))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_timestamp() {
        let ts = serde_json::json!(1704067200);
        let dt = parse_timestamp(&ts);
        assert_eq!(dt.timestamp(), 1704067200);
    }
}
