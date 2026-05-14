//! Twitter/X 数据源
//!
//! 爬取公开推文，隐私级别默认为 Public

use anyhow::{Result, Context};
use async_trait::async_trait;
use crate::model::{MemoryFragment, PrivacyLevel, SourceType};
use crate::sources::DataSource;

pub struct TwitterSource {
    username: Option<String>,
}

impl TwitterSource {
    pub fn new() -> Self {
        Self { username: None }
    }

    pub fn with_username(username: &str) -> Self {
        Self { username: Some(username.to_string()) }
    }
}

#[async_trait]
impl DataSource for TwitterSource {
    fn name(&self) -> &str {
        "twitter"
    }

    fn source_type(&self) -> SourceType {
        SourceType::SocialPost
    }

    fn default_privacy(&self) -> PrivacyLevel {
        PrivacyLevel::Public
    }

    fn requires_auth(&self) -> bool {
        // 公开推文不需要认证，但私有推文需要
        false
    }

    async fn fetch(&self) -> Result<Vec<MemoryFragment>> {
        let username = self.username.as_ref()
            .context("Twitter username not set. Use with_username() to configure.")?;

        // 尝试多个 nitter 实例
        let nitter_hosts = [
            "https://nitter.privacydev.net",
            "https://nitter.poast.org",
            "https://nitter.woodland.cafe",
        ];

        let mut last_err = None;
        for host in &nitter_hosts {
            let url = format!("{}/{}/rss", host, username);
            log::info!("Trying nitter RSS: {}", url);

            match reqwest::get(&url).await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(body) = resp.text().await {
                        let fragments = self.parse_rss(&body, username);
                        if !fragments.is_empty() {
                            log::info!("Got {} tweets from {}", fragments.len(), host);
                            return Ok(fragments);
                        }
                    }
                }
                Ok(resp) => {
                    last_err = Some(anyhow::anyhow!("HTTP {} from {}", resp.status(), host));
                }
                Err(e) => {
                    last_err = Some(anyhow::anyhow!("Request failed for {}: {}", host, e));
                }
            }
        }

        // 所有 nitter 实例都失败，返回空（不阻塞）
        log::warn!(
            "All nitter instances failed for @{}. Last error: {:?}. \
             You can still import tweets via Twitter archive export.",
            username, last_err
        );
        Ok(Vec::new())
    }

    fn instructions(&self) -> String {
        r#"
# Twitter 数据导入

## 方式 1: 公开推文爬取（推荐）
无需 API，直接爬取公开推文：
- 设置用户名后会自动爬取
- 仅限公开内容
- 隐私级别: Public（可云端处理）

## 方式 2: Twitter 数据包
申请 Twitter 数据包：
1. 访问 https://twitter.com/settings/your_twitter_data
2. 下载"Your Twitter archive"
3. 解压后导入 data/tweets.js

## 方式 3: API 访问（需申请）
需要 Twitter API v2 访问权限，可获取：
- 公开推文（无需认证）
- 私有推文（需要 OAuth）
"#
        .to_string()
    }
}

impl Default for TwitterSource {
    fn default() -> Self {
        Self::new()
    }
}

impl TwitterSource {
    /// 解析 nitter RSS XML 提取推文
    fn parse_rss(&self, xml: &str, username: &str) -> Vec<MemoryFragment> {
        let mut fragments = Vec::new();

        // 简单 XML 解析：<item>...</item>
        let items: Vec<&str> = xml.split("<item>").skip(1).collect();
        for item in items {
            let end = item.find("</item>").unwrap_or(item.len());
            let item_content = &item[..end];

            let title = extract_tag(item_content, "title").unwrap_or_default();
            let description = extract_tag(item_content, "description").unwrap_or_default();
            let pub_date = extract_tag(item_content, "pubDate").unwrap_or_default();

            // 清理 HTML 标签
            let clean_desc = strip_html(&description);
            let content = if clean_desc.is_empty() {
                title.clone()
            } else {
                clean_desc
            };

            if content.trim().is_empty() {
                continue;
            }

            let timestamp = chrono::DateTime::parse_from_rfc2822(&pub_date)
                .ok()
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(chrono::Utc::now);

            fragments.push(MemoryFragment {
                id: uuid::Uuid::new_v4().to_string(),
                source_id: format!("twitter_{}", username),
                content,
                timestamp,
                counterpart: None,
                platform: Some("twitter".to_string()),
                tags: vec![format!("@{}", username)],
                created_at: chrono::Utc::now(),
                privacy_level: PrivacyLevel::Public,
            });
        }

        fragments
    }
}

/// 提取 XML 标签内容
fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let start_tag = format!("<{}>", tag);
    let end_tag = format!("</{}>", tag);
    let start = xml.find(&start_tag)? + start_tag.len();
    let end = xml.find(&end_tag)?;
    Some(xml[start..end].to_string())
}

/// 移除 HTML 标签
fn strip_html(html: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    // 解码常见 HTML 实体
    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}
