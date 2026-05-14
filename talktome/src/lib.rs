//! TalkToMe - 自托管的个人树洞分身
//!
//! 基于真实聊天记录训练的"你味道"的树洞。

pub mod api;
pub mod commands;
pub mod ingest;
pub mod llm;
pub mod model;
pub mod store;

pub use store::Store;

/// 启动 HTTP 服务
pub async fn serve(store: Store, port: u16) -> anyhow::Result<()> {
    api::run_server(store, port).await
}
