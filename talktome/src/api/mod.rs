//! HTTP API 服务模块
//!
//! 使用 blocking task 来处理 rusqlite 的同步操作

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use crate::llm::{LLMClient, LLMConfig};
use crate::model::{
    ChatRequest, ChatResponse, IngestRequest, SearchRequest, SearchResult,
};
use crate::store::Store;

/// 应用状态
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<Store>>,
    pub llm_client: Option<Arc<LLMClient>>,
}

/// 创建 HTTP 服务器
pub async fn run_server(store: Store, port: u16) -> anyhow::Result<()> {
    // 尝试加载 LLM 配置
    let llm_client = load_llm_client();
    
    let state = AppState {
        store: Arc::new(Mutex::new(store)),
        llm_client: llm_client.map(Arc::new),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/ingest", post(ingest))
        .route("/chat", post(chat))
        .route("/search", post(search))
        .route("/delete-all", post(delete_all))
        .route("/config", get(get_config).post(set_config))
        .route("/stats", get(stats))
        .route("/sources", get(list_sources))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any))
        .with_state(state);

    let addr = format!("127.0.0.1:{}", port);
    info!("TalkToMe server starting on {}", addr);
    
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    
    Ok(())
}

/// 尝试加载 LLM 配置（从环境变量）
fn load_llm_client() -> Option<LLMClient> {
    let endpoint = std::env::var("LLM_ENDPOINT")
        .unwrap_or_else(|_| "http://localhost:11434/v1".to_string());
    let model = std::env::var("LLM_MODEL")
        .unwrap_or_else(|_| "llama3".to_string());
    let api_key = std::env::var("LLM_API_KEY").ok();
    
    let config = LLMConfig {
        endpoint,
        api_key,
        model,
        ..Default::default()
    };
    
    info!("LLM configured: {} ({})", config.model, config.endpoint);
    Some(LLMClient::new(config))
}

/// 健康检查
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "talktome"
    }))
}

/// 导入数据
async fn ingest(
    State(state): State<AppState>,
    Json(req): Json<IngestRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    use chrono::Utc;
    use uuid::Uuid;

    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut imported = 0;
        let store = store.blocking_lock();
        
        for fragment in req.fragments {
            let memory = crate::model::MemoryFragment {
                id: Uuid::new_v4(),
                source_id: req.source_id,
                content: fragment.content,
                timestamp: fragment.timestamp,
                counterpart: fragment.counterpart,
                platform: fragment.platform,
                tags: Vec::new(),
                created_at: Utc::now(),
                privacy_level: Default::default(),
            };
            
            store.add_fragment(&memory)?;
            imported += 1;
        }
        
        Ok::<usize, anyhow::Error>(imported)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match result {
        Ok(imported) => Ok(Json(serde_json::json!({
            "status": "ok",
            "imported": imported
        }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// 对话
async fn chat(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, (StatusCode, String)> {
    use uuid::Uuid;

    let store = state.store.clone();
    let message = req.message.clone();
 let message_for_llm = req.message.clone();
    let conversation_id = req.conversation_id;

    let result = tokio::task::spawn_blocking(move || {
        let store = store.blocking_lock();
        store.search(&message, 5)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let memories = result.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let relevant_memories: Vec<String> = memories.iter().map(|m| m.content.clone()).collect();
// Phase 1: 真实 LLM 集成，失败时 fallback 到记忆回复
let response = if let Some(ref llm) = state.llm_client {
    let system_prompt = crate::llm::build_system_prompt(&Default::default());
    let user_messages = vec![crate::llm::ChatMessage {
        role: "user".to_string(),
        content: message_for_llm,
    }];
    match llm.chat(&system_prompt, user_messages).await {
        Ok(resp) => resp,
        Err(e) => {
            // LLM 失败时 fallback 到记忆回复
            if relevant_memories.is_empty() {
                format!("（LLM 不可用：{}）我没有相关记忆。先导入一些聊天记录吧。", e)
            } else {
                format!(
                    "（LLM 不可用，基于记忆回复）\n我记得这些相关的事：\n{}",
                    relevant_memories.join("\n")
                )
            }
        }
    }
} else if relevant_memories.is_empty() {
    "我还没什么记忆。先导入一些你的聊天记录或日记吧。".to_string()
} else {
    format!(
        "我记得一些相关的事：\n{}\n\n（没有配置 LLM，这是基于记忆的简单回复）",
        relevant_memories.join("\n")
    )
};

    Ok(Json(ChatResponse {
        response,
        conversation_id: conversation_id.unwrap_or_else(Uuid::new_v4),
        relevant_memories,
    }))
}

/// 搜索
async fn search(
    State(state): State<AppState>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<SearchResult>, (StatusCode, String)> {
    let limit = req.limit.unwrap_or(10);
    let store = state.store.clone();
    let query = req.query;

    let result = tokio::task::spawn_blocking(move || {
        let store = store.blocking_lock();
        store.search(&query, limit)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let fragments = result.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let total = fragments.len();

    Ok(Json(SearchResult { fragments, total }))
}

/// 获取配置
async fn get_config(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || {
        let store = store.blocking_lock();
        store.get_config()
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match result {
        Ok(cfg) => Ok(Json(serde_json::json!({
            "tone": cfg.tone,
            "data_path": cfg.data_path,
            "llm_endpoint": cfg.llm_endpoint
        }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// 设置配置
async fn set_config(
    State(state): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let store = state.store.clone();
    let tone = req
        .get("tone")
        .and_then(|v| v.as_str())
        .map(|s| match s {
            "Gentle" => crate::model::ToneLevel::Gentle,
            "VeryHonest" => crate::model::ToneLevel::VeryHonest,
            _ => crate::model::ToneLevel::Direct,
        })
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let store = store.blocking_lock();
        let mut cfg = store.get_config()?;
        cfg.tone = tone;
        store.set_config(&cfg)?;
        Ok::<(), anyhow::Error>(())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

/// 删除所有数据（一键删除）
async fn delete_all(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let store = state.store.clone();
    
    let result = tokio::task::spawn_blocking(move || {
        let store = store.blocking_lock();
        store.delete_all()
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match result {
        Ok(()) => Ok(Json(serde_json::json!({
            "status": "ok",
            "message": "所有数据已删除"
        }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// 获取统计数据
async fn stats(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || {
        let store = store.blocking_lock();
        store.stats()
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match result {
        Ok(s) => Ok(Json(serde_json::json!({
            "total_fragments": s.total_fragments,
            "total_sources": s.total_sources,
            "per_source": s.per_source.iter().map(|(name, count)| {
                serde_json::json!({"source": name, "fragments": count})
            }).collect::<Vec<_>>(),
            "oldest": s.oldest,
            "newest": s.newest,
            "privacy_distribution": s.privacy_distribution.iter().map(|(level, count)| {
                serde_json::json!({"level": level, "count": count})
            }).collect::<Vec<_>>(),
        }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// 列出数据源
async fn list_sources(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let store = state.store.clone();
    let result = tokio::task::spawn_blocking(move || {
        let store = store.blocking_lock();
        store.get_sources()
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match result {
        Ok(sources) => Ok(Json(serde_json::json!({
            "sources": sources.iter().map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "name": s.name,
                    "source_type": format!("{:?}", s.source_type),
                    "created_at": s.created_at,
                    "enabled": s.enabled,
                })
            }).collect::<Vec<_>>(),
            "total": sources.len(),
        }))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}
