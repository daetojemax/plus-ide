#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{fs, io::{Read, Write}, net::{TcpListener, TcpStream}, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex, time::{Duration, Instant}};
use tauri::Manager;

struct Backend { child: Mutex<Child>, port: u16, data_dir: PathBuf }
#[derive(serde::Serialize)]
struct Connection { url: String, token: String }

#[tauri::command]
async fn get_connection(state: tauri::State<'_, Backend>) -> Result<Connection, String> {
    let port = state.port;
    let directory = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if let Ok(mut stream) = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_millis(150)) {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = stream.write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n");
                let mut body = String::new();
                let _ = stream.read_to_string(&mut body);
                if body.contains("\"ok\":true") {
                    let token = fs::read_to_string(directory.join("owner.key")).map_err(|_| "Не удалось прочитать локальный ключ владельца".to_string())?;
                    return Ok(Connection { url: format!("http://127.0.0.1:{port}"), token: token.trim().to_string() });
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("Локальный сервер не запустился. Подробности в server.log каталога данных Plus.".to_string())
    }).await.map_err(|e| e.to_string())?
}

fn codex_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    paths.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    if let Some(home) = std::env::var_os("HOME") {
        let home=PathBuf::from(home);
        paths.push(home.join(".local/bin"));
        if let Ok(entries)=fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<_>=entries.flatten().map(|e|e.path().join("bin")).collect();
            versions.sort(); versions.reverse(); paths.extend(versions);
        }
    }
    paths
}

fn main() {
    let app=tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_connection])
        .setup(|app| {
            let data_dir=std::env::var_os("PLUS_DATA_DIR").map(PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            fs::create_dir_all(&data_dir)?;
            let resource=app.path().resource_dir()?;
            let manifest=PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let executable=std::env::current_exe()?;
            let target=if cfg!(target_arch="aarch64") {"aarch64-apple-darwin"} else {"x86_64-apple-darwin"};
            let node=if cfg!(debug_assertions) {manifest.join(format!("binaries/plus-node-{target}"))} else {executable.parent().unwrap().join("plus-node")};
            let server=if cfg!(debug_assertions) {manifest.join("resources/server.cjs")} else {resource.join("server.cjs")};
            let web=if cfg!(debug_assertions) {manifest.join("../dist")} else {resource.join("web")};
            // Fixed port makes an existing Funnel mapping survive application restarts.
            let port=std::env::var("PLUS_PORT").ok().and_then(|p|p.parse::<u16>().ok()).unwrap_or(4317);
            let check=TcpListener::bind(("127.0.0.1",port)).map_err(|e|format!("Порт {port} уже занят. Закройте другой экземпляр Plus: {e}"))?;
            drop(check);
            let paths=codex_paths();
            let path=std::env::join_paths(&paths)?;
            let log=fs::OpenOptions::new().create(true).append(true).open(data_dir.join("server.log"))?;
            let mut command=Command::new(node);
            command.arg(server).env("PATH",path).env("PLUS_DATA_DIR",&data_dir).env("PLUS_STATIC_DIR",web).env("PLUS_PORT",port.to_string()).env("PLUS_PARENT_PID",std::process::id().to_string()).current_dir(&data_dir).stdin(Stdio::null()).stdout(Stdio::from(log.try_clone()?)).stderr(Stdio::from(log));
            if std::env::var_os("CODEX_BIN").is_none() {
                let codex=if cfg!(debug_assertions) {manifest.join(format!("binaries/plus-codex-{target}"))} else {executable.parent().unwrap().join("plus-codex")};
                command.env("CODEX_BIN",codex);
            }
            let child=command.spawn()?;
            app.manage(Backend {child:Mutex::new(child),port,data_dir});
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start Plus");
    app.run(|handle,event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(backend)=handle.try_state::<Backend>() {
                if let Ok(mut child)=backend.child.lock() {
                    // Node catches SIGTERM and shuts down its Codex process groups.
                    let _=Command::new("/bin/kill").args(["-TERM",&child.id().to_string()]).status();
                    let deadline=Instant::now()+Duration::from_secs(4);
                    while Instant::now()<deadline {
                        if matches!(child.try_wait(),Ok(Some(_))) {return;}
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    let _=child.kill();let _=child.wait();
                }
            }
        }
    });
}
