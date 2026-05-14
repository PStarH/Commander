//! TalkToMe 核心数据模型

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 数据源类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SourceType {
    /// 聊天记录
    Chat,
    /// 个人日记
    Diary,
    /// 社交媒体帖子
    SocialPost,
    /// 其他文本
    Other,
}

/// 隐私级别
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PrivacyLevel {
    /// 公开内容（可云端处理）
    Public,
    /// 私密内容（仅本地处理）
    Private,
    /// 核心私密（需二次确认，绝不发送到云端）
    Core,
}

impl Default for PrivacyLevel {
    fn default() -> Self {
        Self::Private
    }
}

/// 数据源配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub id: Uuid,
    pub name: String,
    pub source_type: SourceType,
    pub created_at: DateTime<Utc>,
    pub enabled: bool,
}

/// 单条记忆片段
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFragment {
    pub id: Uuid,
    pub source_id: Uuid,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    /// 对话对象（如果是聊天）
    pub counterpart: Option<String>,
    /// 来源平台
    pub platform: Option<String>,
    /// 元数据标签
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    /// 隐私级别
    #[serde(default)]
    pub privacy_level: PrivacyLevel,
}

/// 导入请求
#[derive(Debug, Deserialize)]
pub struct IngestRequest {
    pub source_id: Uuid,
    pub fragments: Vec<IngestFragment>,
}

#[derive(Debug, Deserialize)]
pub struct IngestFragment {
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub counterpart: Option<String>,
    pub platform: Option<String>,
}

/// 聊天请求
#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub conversation_id: Option<Uuid>,
}

/// 聊天响应
#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub response: String,
    pub conversation_id: Uuid,
    pub relevant_memories: Vec<String>,
}

/// 搜索请求
#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    pub limit: Option<usize>,
    pub source_id: Option<Uuid>,
}

/// 搜索结果
#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub fragments: Vec<MemoryFragment>,
    pub total: usize,
}

/// 对话消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub role: String,  // "user" 或 "assistant"
    pub content: String,
    pub timestamp: DateTime<Utc>,
}

/// 对话记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: Uuid,
    pub messages: Vec<ConversationMessage>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 对话消息历史请求
#[derive(Debug, Deserialize)]
pub struct ConversationHistoryRequest {
    pub conversation_id: Uuid,
}

/// 对话消息历史响应
#[derive(Debug, Serialize)]
pub struct ConversationHistoryResponse {
    pub messages: Vec<ConversationMessage>,
}

/// 对话基调设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ToneLevel {
    Gentle,
    Direct,
    VeryHonest,
}

impl Default for ToneLevel {
    fn default() -> Self {
        Self::Direct
    }
}

/// 系统配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub tone: ToneLevel,
    pub llm_endpoint: Option<String>,
    pub data_path: String,
}
