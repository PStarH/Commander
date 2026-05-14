//! 本地文件数据源
//!
//! 支持导入本地文本文件、Markdown、JSON 等
//! 用户可选择隐私级别

use anyhow::{Result, Context};
use async_trait::async_trait;
use std::path::PathBuf;
use chrono::Utc;
use uuid::Uuid;
use crate::model::{MemoryFragment, PrivacyLevel, SourceType};
use crate::sources::DataSource;

pub struct LocalFileSource {
    path: Option<PathBuf>,
    privacy_level: PrivacyLevel,
}

impl LocalFileSource {
    pub fn new() -> Self {
        Self {
            path: None,
            privacy_level: PrivacyLevel::Private,
        }
    }

    pub fn with_path(path: &str) -> Self {
        Self {
            path: Some(PathBuf::from(path)),
            privacy_level: PrivacyLevel::Private,
        }
    }

    /// 设置隐私级别
    pub fn with_privacy(mut self, level: PrivacyLevel) -> Self {
        self.privacy_level = level;
        self
    }

    /// 导入纯文本
    fn parse_text(&self, content: &str) -> Result<Vec<MemoryFragment>> {
        let source_id = Uuid::new_v4();
        let paragraphs: Vec<&str> = content
            .split("\n\n")
            .filter(|p| !p.trim().is_empty() && p.len() >= 10)
            .collect();

        let fragments = paragraphs
            .into_iter()
            .enumerate()
            .map(|(idx, para)| MemoryFragment {
                id: Uuid::new_v4(),
                source_id,
                content: para.trim().to_string(),
                timestamp: Utc::now(),
                counterpart: None,
                platform: Some("local_file".to_string()),
                tags: vec![format!("paragraph_{}", idx)],
                created_at: Utc::now(),
                privacy_level: self.privacy_level,
            })
            .collect();

        Ok(fragments)
    }

    /// 导入 Markdown
    fn parse_markdown(&self, content: &str) -> Result<Vec<MemoryFragment>> {
        let source_id = Uuid::new_v4();
        let mut fragments = Vec::new();

        // 按标题分段
        let sections: Vec<&str> = content.split("\n#").collect();

        for section in sections {
            let trimmed = section.trim();
            if trimmed.is_empty() || trimmed.len() < 20 {
                continue;
            }

            // 提取标题（如果有）
            let (title, body) = if let Some(newline_pos) = trimmed.find('\n') {
                let title = trimmed[..newline_pos].trim_start_matches('#').trim();
                let body = &trimmed[newline_pos + 1..];
                (Some(title), body)
            } else {
                (None, trimmed)
            };

            fragments.push(MemoryFragment {
                id: Uuid::new_v4(),
                source_id,
                content: body.to_string(),
                timestamp: Utc::now(),
                counterpart: None,
                platform: Some("local_file".to_string()),
                tags: title.map(|t| vec![t.to_string()]).unwrap_or_default(),
                created_at: Utc::now(),
                privacy_level: self.privacy_level,
            });
        }

        Ok(fragments)
    }
}

#[async_trait]
impl DataSource for LocalFileSource {
    fn name(&self) -> &str {
        "local_file"
    }

    fn source_type(&self) -> SourceType {
        SourceType::Other
    }

    fn default_privacy(&self) -> PrivacyLevel {
        self.privacy_level
    }

    fn requires_auth(&self) -> bool {
        false
    }

    async fn fetch(&self) -> Result<Vec<MemoryFragment>> {
        let path = self.path.as_ref()
            .context("Local file path not set")?;

        let content = tokio::fs::read_to_string(path).await
            .context("Failed to read file")?;

        // 根据扩展名选择解析方式
        let ext = path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        match ext {
            "md" | "markdown" => self.parse_markdown(&content),
            "json" => {
                // 委托给 telegram 模块的 JSON 解析逻辑
                // 或者使用通用的 JSON 数组解析
                let json: serde_json::Value = serde_json::from_str(&content)?;
                let source_id = Uuid::new_v4();

                let fragments = if let Some(arr) = json.as_array() {
                    arr.iter().filter_map(|item| {
                        item.get("text").or_else(|| item.get("content"))
                            .and_then(|t| t.as_str())
                            .filter(|s| s.len() >= 10)
                            .map(|text| MemoryFragment {
                                id: Uuid::new_v4(),
                                source_id,
                                content: text.to_string(),
                                timestamp: Utc::now(),
                                counterpart: None,
                                platform: Some("local_file".to_string()),
                                tags: vec!["json_import".to_string()],
                                created_at: Utc::now(),
                                privacy_level: self.privacy_level,
                            })
                    }).collect()
                } else {
                    Vec::new()
                };

                Ok(fragments)
            }
            _ => self.parse_text(&content),
        }
    }

    fn instructions(&self) -> String {
        r#"
# 本地文件导入

## 支持格式

- `.txt` - 纯文本（按段落分割）
- `.md` - Markdown（按标题分段）
- `.json` - JSON 数组格式

## 隐私级别选择

```rust
// 公开内容（博客、公开文章）
let source = LocalFileSource::with_path("blog.md")
    .with_privacy(PrivacyLevel::Public);

// 私密日记
let source = LocalFileSource::with_path("diary.txt")
    .with_privacy(PrivacyLevel::Private);

// 最私密内容（需二次确认）
let source = LocalFileSource::with_path("secrets.txt")
    .with_privacy(PrivacyLevel::Core);
```

## 使用场景

| 文件类型 | 建议隐私级别 |
|---------|------------|
| 公开博客 | Public |
| 私人笔记 | Private |
| 深夜日记 | Core |
| 聊天导出 | Private |
"#
        .to_string()
    }
}

impl Default for LocalFileSource {
    fn default() -> Self {
        Self::new()
    }
}
