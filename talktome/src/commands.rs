//! CLI 子命令定义

use anyhow::Result;
use std::path::PathBuf;
use crate::store::Store;

/// 导入数据
pub fn import_json(store: &Store, name: &str, path: &PathBuf) -> Result<()> {
    use crate::ingest::import_json_file;
    
    let (source_id, count) = import_json_file(store, name, path)?;
    println!("✓ 导入完成: {} 条记录 (数据源 ID: {})", count, source_id);
    Ok(())
}

/// 导入文本
pub fn import_text(store: &Store, name: &str, path: &PathBuf) -> Result<()> {
    use crate::ingest::import_text_file;
    
    let (source_id, count) = import_text_file(store, name, path)?;
    println!("✓ 导入完成: {} 条记录 (数据源 ID: {})", count, source_id);
    Ok(())
}
