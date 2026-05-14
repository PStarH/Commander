//! LLM 集成模块
//!
//! 支持调用本地 LLM（如 Ollama）或云端 LLM（如 OpenAI 兼容 API）

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// LLM 提供者配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMConfig {
    /// 端点 URL（如 http://localhost:11434/v1 或 https://api.openai.com/v1）
    pub endpoint: String,
    /// API Key（可选，本地 LLM 不需要）
    pub api_key: Option<String>,
    /// 模型名称
    pub model: String,
    /// 最大 tokens
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
    /// 温度
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

fn default_max_tokens() -> usize { 1024 }
fn default_temperature() -> f32 { 0.7 }

impl Default for LLMConfig {
    fn default() -> Self {
        Self {
            endpoint: "http://localhost:11434/v1".to_string(),
            api_key: None,
            model: "llama3".to_string(),
            max_tokens: 1024,
            temperature: 0.7,
        }
    }
}

/// 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// LLM 客户端
pub struct LLMClient {
    config: LLMConfig,
    client: reqwest::Client,
}

impl LLMClient {
    pub fn new(config: LLMConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    /// 调用 LLM 生成回复
    pub async fn chat(&self, system: &str, messages: Vec<ChatMessage>) -> Result<String> {
        let url = format!("{}/chat/completions", self.config.endpoint);
        
        // 构建消息列表
        let mut all_messages = vec![ChatMessage {
            role: "system".to_string(),
            content: system.to_string(),
        }];
        all_messages.extend(messages);

        let body = ChatCompletionRequest {
            model: self.config.model.clone(),
            messages: all_messages,
            max_tokens: self.config.max_tokens,
            temperature: self.config.temperature,
        };

        let mut request = self.client.post(&url)
            .json(&body);

        if let Some(ref api_key) = self.config.api_key {
            request = request.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = request
            .send()
            .await
            .context("Failed to send request to LLM")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("LLM request failed: {} - {}", status, text);
        }

        let result: ChatCompletionResponse = response
            .json()
            .await
            .context("Failed to parse LLM response")?;

        Ok(result.choices
            .first()
            .map(|c| c.message.content.clone())
            .unwrap_or_else(|| "抱歉，我无法生成回复。".to_string()))
    }

    /// 检查 LLM 是否可用
    pub async fn health_check(&self) -> Result<bool> {
        let url = format!("{}/models", self.config.endpoint);
        
        let response = self.client
            .get(&url)
            .send()
            .await
            .context("Failed to check LLM health")?;

        Ok(response.status().is_success())
    }
}

#[derive(Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: usize,
    temperature: f32,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessage,
}

/// 构建 TalkToMe 的 system prompt
pub fn build_system_prompt(tone: &crate::model::ToneLevel) -> String {
    let tone_instruction = match tone {
        crate::model::ToneLevel::Gentle => "温和地表达，用词委婉但真诚。",
        crate::model::ToneLevel::Direct => "直接表达，不绕弯子，但不对人格进行攻击。",
        crate::model::ToneLevel::VeryHonest => "非常诚实，直面问题，该批评时就批评，但就事论事。",
    };

    format!(
        r#"你是 TalkToMe，一个基于用户真实聊天记录和文字训练的"数字分身"。
你的目标是成为用户的"树洞"——一个可以倾诉、复盘、释放情绪的空间。

## 你的特点
1. 你说话的风格、态度、价值观都来自用户的真实历史数据
2. 你会真实反馈，而不是虚假安慰
3. 你不会用套话（"你很棒""你可以的"）粉饰问题
4. 你会帮助用户看清现实和自己的模式

## 基调设置
{}

## 行为准则
- 优先帮助用户看清现实和自己模式
- 批评行为，不攻击人格
- 遇到严重心理危机时，鼓励用户寻求人类专业帮助
- 不要假装解决问题，有时候倾听和理解就足够了
- 用用户的说话习惯和语气，但保持对话的连贯性

## 当前对话
用户来找你说话。请基于你记忆中的内容，给出一个真实、有帮助的回应。"#,
        tone_instruction
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_system_prompt() {
        let prompt = build_system_prompt(&crate::model::ToneLevel::Direct);
        assert!(prompt.contains("直接表达"));
    }
}
