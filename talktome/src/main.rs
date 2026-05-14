//! TalkToMe 服务入口

use clap::{Parser, Subcommand};
use talktome::{serve, Store};
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "talktome")]
#[command(about = "自托管的个人树洞分身")]
struct Args {
    /// 数据存储路径
    #[arg(short, long, default_value = "~/.talktome/data")]
    data: String,

    /// 设置密码（首次启动）
    #[arg(short, long)]
    password: Option<String>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// 启动 HTTP 服务
    Serve {
        /// 服务端口
        #[arg(short, long, default_value = "3838")]
        port: u16,
    },

    /// 导入 JSON 聊天记录
    ImportJson {
        /// 数据源名称
        #[arg(short, long)]
        name: String,

        /// JSON 文件路径
        #[arg(short, long)]
        path: String,
    },

    /// 导入文本文件
    ImportText {
        /// 数据源名称
        #[arg(short, long)]
        name: String,

        /// 文本文件路径
        #[arg(short, long)]
        path: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    // 展开路径中的 ~/
    let data_path = shellexpand::tilde(&args.data).to_string();

    info!("TalkToMe starting...");
    info!("Data path: {}", data_path);

    // 获取或设置密码
    let password = args.password.unwrap_or_else(|| {
        println!("请输入密码（用于加密数据）：");
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        input.trim().to_string()
    });

    // 打开存储
    let store = Store::open(&data_path, &password)?;
    info!("Storage initialized");

    // 处理子命令
    match args.command {
        Some(Commands::Serve { port }) => {
            info!("Starting HTTP server on port {}", port);
            serve(store, port).await?;
        }
        Some(Commands::ImportJson { name, path }) => {
            use std::path::PathBuf;
            let path = PathBuf::from(shellexpand::tilde(&path).to_string());
            talktome::commands::import_json(&store, &name, &path)?;
        }
        Some(Commands::ImportText { name, path }) => {
            use std::path::PathBuf;
            let path = PathBuf::from(shellexpand::tilde(&path).to_string());
            talktome::commands::import_text(&store, &name, &path)?;
        }
        None => {
            // 默认启动服务
            info!("No command specified, starting HTTP server...");
            serve(store, 3838).await?;
        }
    }

    Ok(())
}
