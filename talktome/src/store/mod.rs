//! 本地加密存储模块

use aes_gcm::{
	aead::{Aead, KeyInit},
	Aes256Gcm, Nonce,
};
use anyhow::{Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use chrono::Utc;
use rand::Rng;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

use crate::model::{MemoryFragment, PrivacyLevel, Source, SourceType};

/// 加密存储
pub struct Store {
	conn: Connection,
	key: [u8; 32],
	db_path: PathBuf,
}

impl Store {
	/// 创建或打开存储
	pub fn open(data_path: &str, password: &str) -> Result<Self> {
		std::fs::create_dir_all(data_path)
			.context("Failed to create data directory")?;

		let db_path = PathBuf::from(data_path).join("talktome.db");

		let conn = Connection::open(&db_path)
			.context("Failed to open database")?;

		// 初始化数据库表
		Self::init_schema(&conn)?;

		// 从密码派生加密密钥（使用数据库存储的随机 salt）
		let key = Self::derive_key(&conn, password)?;

		let store = Store {
			conn,
			key,
			db_path,
		};

		Ok(store)
	}

	fn init_schema(conn: &Connection) -> Result<()> {
		conn.execute_batch(
			r#"
			CREATE TABLE IF NOT EXISTS sources (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				source_type TEXT NOT NULL,
				created_at TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1
			);

			CREATE TABLE IF NOT EXISTS fragments (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				content_encrypted BLOB NOT NULL,
				nonce BLOB NOT NULL,
				timestamp TEXT NOT NULL,
				counterpart TEXT,
				platform TEXT,
				tags TEXT,
				created_at TEXT NOT NULL,
				privacy_level TEXT NOT NULL DEFAULT 'private',
				FOREIGN KEY (source_id) REFERENCES sources(id)
			);

			CREATE TABLE IF NOT EXISTS config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_fragments_source ON fragments(source_id);
			CREATE INDEX IF NOT EXISTS idx_fragments_timestamp ON fragments(timestamp);
			"#,
		)?;

		Ok(())
	}

	fn derive_key(conn: &Connection, password: &str) -> Result<[u8; 32]> {
		// 优先从数据库读取 salt，没有则生成随机 salt 并存储（向后兼容旧固定 salt）
		let salt: Vec<u8> = match conn.query_row(
			"SELECT value FROM config WHERE key = 'argon2_salt'",
			[],
			|row| row.get::<_, String>(0),
		) {
			Ok(hex_salt) => hex::decode(&hex_salt)
				.unwrap_or_else(|_| b"talktome_v0_salt".to_vec()),
			Err(_) => {
				// 生成随机 salt 并存储
				let random_salt: [u8; 16] = rand::thread_rng().gen();
				let hex_salt = hex::encode(random_salt);
				conn.execute(
					"INSERT OR IGNORE INTO config (key, value) VALUES ('argon2_salt', ?1)",
					[&hex_salt],
				)?;
				random_salt.to_vec()
			}
		};

		let mut key = [0u8; 32];
		let params = Params::new(Params::DEFAULT_M_COST, Params::DEFAULT_T_COST, Params::DEFAULT_P_COST, None)
			.map_err(|e| anyhow::anyhow!("Argon2 params error: {:?}", e))?;
		let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
		argon2.hash_password_into(password.as_bytes(), &salt, &mut key)
			.map_err(|e| anyhow::anyhow!("Argon2 hash error: {:?}", e))?;
		Ok(key)
	}

	fn encrypt(&self, plaintext: &str) -> Result<(Vec<u8>, [u8; 12])> {
		let cipher = Aes256Gcm::new_from_slice(&self.key)
			.map_err(|e| anyhow::anyhow!("Failed to create cipher: {:?}", e))?;

		let nonce_bytes: [u8; 12] = rand::thread_rng().gen();
		let nonce = Nonce::from_slice(&nonce_bytes);

		let ciphertext = cipher
			.encrypt(nonce, plaintext.as_bytes())
			.map_err(|e| anyhow::anyhow!("Encryption failed: {:?}", e))?;

		Ok((ciphertext, nonce_bytes))
	}

	fn decrypt(&self, ciphertext: &[u8], nonce_bytes: &[u8; 12]) -> Result<String> {
		let cipher = Aes256Gcm::new_from_slice(&self.key)
			.map_err(|e| anyhow::anyhow!("Failed to create cipher: {:?}", e))?;

		let nonce = Nonce::from_slice(nonce_bytes);

		let plaintext = cipher
			.decrypt(nonce, ciphertext)
			.map_err(|e| anyhow::anyhow!("Decryption failed: {:?}", e))?;

		String::from_utf8(plaintext).context("Invalid UTF-8 in decrypted data")
	}

	/// 添加数据源
	pub fn add_source(&self, name: &str, source_type: SourceType) -> Result<Source> {
		let source = Source {
			id: Uuid::new_v4(),
			name: name.to_string(),
			source_type,
			created_at: Utc::now(),
			enabled: true,
		};

		let source_type_str = match source.source_type {
			SourceType::Chat => "chat",
			SourceType::Diary => "diary",
			SourceType::SocialPost => "social_post",
			SourceType::Other => "other",
		};

		self.conn.execute(
			"INSERT INTO sources (id, name, source_type, created_at, enabled) VALUES (?1, ?2, ?3, ?4, ?5)",
			rusqlite::params![
				source.id.to_string(),
				source.name,
				source_type_str,
				source.created_at.to_rfc3339(),
				1
			],
		)?;

		Ok(source)
	}

	/// 添加记忆片段（加密存储）
	pub fn add_fragment(&self, fragment: &MemoryFragment) -> Result<()> {
		let (encrypted, nonce) = self.encrypt(&fragment.content)?;

		let privacy_str = match fragment.privacy_level {
			PrivacyLevel::Public => "public",
			PrivacyLevel::Private => "private",
			PrivacyLevel::Core => "core",
		};

		self.conn.execute(
			"INSERT INTO fragments (id, source_id, content_encrypted, nonce, timestamp, counterpart, platform, tags, created_at, privacy_level) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
			rusqlite::params![
				fragment.id.to_string(),
				fragment.source_id.to_string(),
				encrypted,
				nonce.to_vec(),
				fragment.timestamp.to_rfc3339(),
				fragment.counterpart,
				fragment.platform,
				serde_json::to_string(&fragment.tags)?,
				fragment.created_at.to_rfc3339(),
				privacy_str,
			],
		)?;

		Ok(())
	}

	/// 获取记忆片段（解密）
	pub fn get_fragments(&self, source_id: Option<Uuid>, limit: usize) -> Result<Vec<MemoryFragment>> {
		let sql = match source_id {
			Some(_) => "SELECT id, source_id, content_encrypted, nonce, timestamp, counterpart, platform, tags, created_at, privacy_level FROM fragments WHERE source_id = ?1 ORDER BY timestamp DESC LIMIT ?2",
			None => "SELECT id, source_id, content_encrypted, nonce, timestamp, counterpart, platform, tags, created_at, privacy_level FROM fragments ORDER BY timestamp DESC LIMIT ?1",
		};

		let mut stmt = self.conn.prepare(sql)?;

		let rows = match source_id {
			Some(sid) => {
				stmt
					.query_map(rusqlite::params![sid.to_string(), limit as i32], |row| {
						self.row_to_fragment(row).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
					})?
					.collect::<Result<Vec<_>, _>>()
					.map_err(|e| anyhow::anyhow!("Database error: {:?}", e))?
			}
			None => {
				stmt
					.query_map(rusqlite::params![limit as i32], |row| {
						self.row_to_fragment(row).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
					})?
					.collect::<Result<Vec<_>, _>>()
					.map_err(|e| anyhow::anyhow!("Database error: {:?}", e))?
			}
		};

		Ok(rows)
	}

	fn row_to_fragment(&self, row: &rusqlite::Row) -> Result<MemoryFragment> {
		let id_str: String = row.get(0)?;
		let source_id_str: String = row.get(1)?;
		let encrypted: Vec<u8> = row.get(2)?;
		let nonce_vec: Vec<u8> = row.get(3)?;
		let timestamp_str: String = row.get(4)?;
		let counterpart: Option<String> = row.get(5)?;
		let platform: Option<String> = row.get(6)?;
		let tags_json: String = row.get(7)?;
		let created_at_str: String = row.get(8)?;
		let privacy_str: String = row.get::<_, Option<String>>(9)?.unwrap_or_else(|| "private".to_string());

		let mut nonce = [0u8; 12];
		nonce.copy_from_slice(&nonce_vec);

		let content = self.decrypt(&encrypted, &nonce)?;

		let privacy_level = match privacy_str.as_str() {
			"public" => PrivacyLevel::Public,
			"core" => PrivacyLevel::Core,
			_ => PrivacyLevel::Private,
		};

		Ok(MemoryFragment {
			id: Uuid::parse_str(&id_str)?,
			source_id: Uuid::parse_str(&source_id_str)?,
			content,
			timestamp: chrono::DateTime::parse_from_rfc3339(&timestamp_str)?
				.with_timezone(&Utc),
			counterpart,
			platform,
			tags: serde_json::from_str(&tags_json).unwrap_or_default(),
			created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)?
				.with_timezone(&Utc),
			privacy_level,
		})
	}

	/// 按关键词搜索
	pub fn search(&self, query: &str, limit: usize) -> Result<Vec<MemoryFragment>> {
		// 简单的关键词匹配（后续可改进为 embedding 搜索）
		let sql = "SELECT id, source_id, content_encrypted, nonce, timestamp, counterpart, platform, tags, created_at, privacy_level FROM fragments ORDER BY timestamp DESC";
		let mut stmt = self.conn.prepare(sql)?;

		let rows = stmt.query_map([], |row| {
			self.row_to_fragment(row).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
		})?;

		let mut results = Vec::new();
		for row in rows {
			if let Ok(fragment) = row {
				if fragment.content.to_lowercase().contains(&query.to_lowercase()) {
					results.push(fragment);
					if results.len() >= limit {
						break;
					}
				}
			}
		}

		Ok(results)
	}

	/// 获取配置
	pub fn get_config(&self) -> Result<crate::model::Config> {
		let tone = self.conn.query_row(
			"SELECT value FROM config WHERE key = 'tone'",
			[],
			|row| row.get::<_, String>(0),
		).unwrap_or_else(|_| "Direct".to_string());

		let llm_endpoint = self.conn.query_row(
			"SELECT value FROM config WHERE key = 'llm_endpoint'",
			[],
			|row| row.get::<_, String>(0),
		).ok();

		Ok(crate::model::Config {
			tone: match tone.as_str() {
				"Gentle" => crate::model::ToneLevel::Gentle,
				"VeryHonest" => crate::model::ToneLevel::VeryHonest,
				_ => crate::model::ToneLevel::Direct,
			},
			llm_endpoint,
			data_path: self.db_path.parent()
				.and_then(|p| p.to_str())
				.unwrap_or(".")
				.to_string(),
		})
	}

	/// 保存配置到数据库
	pub fn set_config(&self, config: &crate::model::Config) -> Result<()> {
		let tone_str = match config.tone {
			crate::model::ToneLevel::Gentle => "Gentle",
			crate::model::ToneLevel::Direct => "Direct",
			crate::model::ToneLevel::VeryHonest => "VeryHonest",
		};
		self.conn.execute(
			"INSERT OR REPLACE INTO config (key, value) VALUES ('tone', ?1)",
			[tone_str],
		)?;
		if let Some(ref endpoint) = config.llm_endpoint {
			self.conn.execute(
				"INSERT OR REPLACE INTO config (key, value) VALUES ('llm_endpoint', ?1)",
				[endpoint.as_str()],
			)?;
		} else {
			self.conn.execute(
				"DELETE FROM config WHERE key = 'llm_endpoint'",
				[],
			)?;
		}
		Ok(())
	}

	/// 删除所有数据
	pub fn delete_all(&self) -> Result<()> {
		self.conn.execute("DELETE FROM fragments", [])?;
		self.conn.execute("DELETE FROM sources", [])?;
		self.conn.execute("DELETE FROM config", [])?;
		Ok(())
	}

	/// 获取数据源列表
	pub fn get_sources(&self) -> Result<Vec<Source>> {
		let mut stmt = self.conn.prepare(
			"SELECT id, name, source_type, created_at, enabled FROM sources ORDER BY created_at DESC"
		)?;

		let rows = stmt.query_map([], |row| {
			let id_str: String = row.get(0)?;
			let name: String = row.get(1)?;
			let source_type_str: String = row.get(2)?;
			let created_at_str: String = row.get(3)?;
			let enabled: bool = row.get::<_, i32>(4)? != 0;

			let source_type = match source_type_str.as_str() {
				"chat" => SourceType::Chat,
				"diary" => SourceType::Diary,
				"social_post" => SourceType::SocialPost,
				_ => SourceType::Other,
			};

			Ok(Source {
				id: Uuid::parse_str(&id_str).unwrap_or_else(|_| Uuid::new_v4()),
				name,
				source_type,
				created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
					.map(|dt| dt.with_timezone(&Utc))
					.unwrap_or_else(|_| Utc::now()),
				enabled,
			})
		})?;

		let mut sources = Vec::new();
		for row in rows {
			sources.push(row?);
		}
		Ok(sources)
	}

	/// 获取统计数据
	pub fn stats(&self) -> Result<StoreStats> {
		let total_fragments: i64 = self.conn.query_row(
			"SELECT COUNT(*) FROM fragments", [], |row| row.get(0)
		).unwrap_or(0);

		let total_sources: i64 = self.conn.query_row(
			"SELECT COUNT(*) FROM sources", [], |row| row.get(0)
		).unwrap_or(0);

		// 每个 source 的 fragment 数量
		let mut stmt = self.conn.prepare(
			"SELECT s.name, COUNT(f.id) FROM sources s \
			 LEFT JOIN fragments f ON f.source_id = s.id \
			 GROUP BY s.id ORDER BY COUNT(f.id) DESC"
		)?;
		let per_source: Vec<(String, i64)> = stmt.query_map([], |row| {
			Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
		 })?.filter_map(|r| r.ok()).collect();

		// 最早和最晚的 fragment 时间
		let oldest: Option<String> = self.conn.query_row(
			"SELECT MIN(timestamp) FROM fragments", [], |row| row.get(0)
		).unwrap_or(None);
		let newest: Option<String> = self.conn.query_row(
			"SELECT MAX(timestamp) FROM fragments", [], |row| row.get(0)
		).unwrap_or(None);

		// 隐私级别分布
		let mut privacy_stmt = self.conn.prepare(
			"SELECT privacy_level, COUNT(*) FROM fragments GROUP BY privacy_level"
		)?;
		let privacy_dist: Vec<(String, i64)> = privacy_stmt.query_map([], |row| {
			Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
		})?.filter_map(|r| r.ok()).collect();

		Ok(StoreStats {
			total_fragments,
			total_sources,
			per_source,
			oldest,
			newest,
			privacy_distribution: privacy_dist,
		})
	}
}

/// 存储统计信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreStats {
	pub total_fragments: i64,
	pub total_sources: i64,
	/// (source_name, fragment_count)
	pub per_source: Vec<(String, i64)>,
	pub oldest: Option<String>,
	pub newest: Option<String>,
	/// (privacy_level, count)
	pub privacy_distribution: Vec<(String, i64)>,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_encrypt_decrypt() {
		let store = Store::open("/tmp/talktome_test", "test_password").unwrap();
		let (encrypted, nonce) = store.encrypt("hello world").unwrap();
		let decrypted = store.decrypt(&encrypted, &nonce).unwrap();
		assert_eq!(decrypted, "hello world");
	}
}
