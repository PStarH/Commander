//! 数据源适配器模块
//!
//! 支持多种数据来源，每种来源有明确的隐私级别

use anyhow::Result;
use async_trait::async_trait;
use crate::model::{MemoryFragment, PrivacyLevel, SourceType};

pub mod twitter;
pub mod telegram;
pub mod local_file;

/// 数据源适配器 trait
#[async_trait]
pub trait DataSource: Send + Sync {
    /// 数据源名称
    fn name(&self) -> &str;

    /// 数据源类型
    fn source_type(&self) -> SourceType;

    /// 默认隐私级别
    fn default_privacy(&self) -> PrivacyLevel;

    /// 是否需要认证
    fn requires_auth(&self) -> bool;

    /// 抓取数据
    async fn fetch(&self) -> Result<Vec<MemoryFragment>>;

    /// 获取使用说明
    fn instructions(&self) -> String;
}

/// 数据源注册表
pub struct SourceRegistry {
    sources: Vec<Box<dyn DataSource>>,
}

impl SourceRegistry {
    pub fn new() -> Self {
        Self {
            sources: Vec::new(),
        }
    }

    pub fn register(&mut self, source: Box<dyn DataSource>) {
        self.sources.push(source);
    }

    pub fn list(&self) -> Vec<&dyn DataSource> {
        self.sources.iter().map(|s| s.as_ref()).collect()
    }

    pub fn get(&self, name: &str) -> Option<&dyn DataSource> {
        self.sources.iter().find(|s| s.name() == name).map(|s| s.as_ref())
    }
}

impl Default for SourceRegistry {
    fn default() -> Self {
        let mut registry = Self::new();
        registry.register(Box::new(twitter::TwitterSource::new()));
        registry.register(Box::new(telegram::TelegramSource::new()));
        registry.register(Box::new(local_file::LocalFileSource::new()));
        registry
    }
}
