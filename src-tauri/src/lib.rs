use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    auto_editor: bool,
    auto_editor_path: Option<String>,
    ffmpeg: bool,
    ffmpeg_path: Option<String>,
    ffprobe: bool,
    ffprobe_path: Option<String>,
    whisper: bool,
    whisper_path: Option<String>,
    whisper_model: Option<String>,
    output_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedVideo {
    id: String,
    path: String,
    name: String,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessVideoRequest {
    id: String,
    path: String,
    preset: CutPreset,
    subtitles: bool,
    transcript: bool,
    json_timestamps: bool,
    language: Language,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CutPreset {
    Gentle,
    Normal,
    Aggressive,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Language {
    Auto,
    Russian,
    English,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessVideoResult {
    id: String,
    output_path: String,
    output_dir: String,
    transcript_path: Option<String>,
    subtitles_path: Option<String>,
    timestamps_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    id: String,
    status: String,
    step: String,
    progress: u8,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    settings: Option<serde_json::Value>,
    jobs: Vec<serde_json::Value>,
}

#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_tools,
            videos_from_paths,
            load_app_state,
            save_app_state,
            process_video,
            create_results_zip,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running VideoCleaner");
}

#[tauri::command]
fn load_app_state(app: AppHandle) -> Result<PersistedState, AppError> {
    let conn = open_database(&app)?;
    let settings = conn
        .query_row("select value from settings where key = 'app'", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .map(|value| serde_json::from_str(&value))
        .transpose()?;

    let mut statement = conn.prepare("select payload from jobs order by position asc")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut jobs = Vec::new();

    for row in rows {
        jobs.push(serde_json::from_str(&row?)?);
    }

    Ok(PersistedState { settings, jobs })
}

#[tauri::command]
fn save_app_state(
    app: AppHandle,
    settings: serde_json::Value,
    jobs: Vec<serde_json::Value>,
) -> Result<(), AppError> {
    let mut conn = open_database(&app)?;
    let transaction = conn.transaction()?;

    transaction.execute(
        "insert into settings (key, value) values ('app', ?1)
         on conflict(key) do update set value = excluded.value, updated_at = datetime('now')",
        params![serde_json::to_string(&settings)?],
    )?;
    transaction.execute("delete from jobs", [])?;

    for (position, job) in jobs.into_iter().enumerate() {
        let id = job
            .get("id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| AppError::Message("Persisted job is missing an id".into()))?;
        transaction.execute(
            "insert into jobs (id, position, payload) values (?1, ?2, ?3)",
            params![id, position as i64, serde_json::to_string(&job)?],
        )?;
    }

    transaction.commit()?;
    Ok(())
}

#[tauri::command]
fn check_tools(app: AppHandle) -> Result<ToolStatus, AppError> {
    let auto_editor = resolve_tool(&app, "auto-editor");
    let ffmpeg = resolve_tool(&app, "ffmpeg");
    let ffprobe = resolve_tool(&app, "ffprobe");
    let whisper = resolve_first_tool(&app, &["whisper-cli", "whisper", "main"]);
    let whisper_model = resolve_whisper_model(&app);

    Ok(ToolStatus {
        auto_editor: auto_editor.is_some(),
        auto_editor_path: auto_editor.map(display_path),
        ffmpeg: ffmpeg.is_some(),
        ffmpeg_path: ffmpeg.map(display_path),
        ffprobe: ffprobe.is_some(),
        ffprobe_path: ffprobe.map(display_path),
        whisper: whisper.is_some() && whisper_model.is_some(),
        whisper_path: whisper.map(display_path),
        whisper_model: whisper_model.map(display_path),
        output_dir: ensure_output_dir(&app)?.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn videos_from_paths(paths: Vec<String>) -> Result<Vec<SelectedVideo>, AppError> {
    paths
        .into_iter()
        .filter(|path| is_supported_video(Path::new(path)))
        .map(|path| selected_video(PathBuf::from(path)))
        .collect()
}

#[tauri::command]
async fn process_video(
    app: AppHandle,
    request: ProcessVideoRequest,
) -> Result<ProcessVideoResult, AppError> {
    emit_job(&app, &request.id, "processing", "Preparing", 5, None);

    let auto_editor = resolve_tool(&app, "auto-editor").ok_or_else(|| {
        AppError::Message(
            "auto-editor is not installed. Install it or bundle it as a sidecar binary.".into(),
        )
    })?;

    if !resolve_tool(&app, "ffmpeg").is_some() {
        return Err(AppError::Message(
            "ffmpeg is not available. auto-editor needs FFmpeg to process videos.".into(),
        ));
    }

    let source = PathBuf::from(&request.path);
    if !source.exists() {
        return Err(AppError::Message(format!(
            "Input file does not exist: {}",
            request.path
        )));
    }

    let output_dir = ensure_output_dir(&app)?;
    let output_path = make_output_path(&output_dir, &source);
    let args = auto_editor_args(&request, &output_path);

    emit_job(
        &app,
        &request.id,
        "processing",
        "Cutting silence",
        20,
        Some("Running auto-editor".to_string()),
    );

    let output = Command::new(auto_editor)
        .arg(&source)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        emit_job(
            &app,
            &request.id,
            "failed",
            "Failed",
            100,
            Some(stderr.to_string()),
        );
        return Err(AppError::Message(format!("auto-editor failed: {}", stderr)));
    }

    let transcript_outputs = if request.subtitles || request.transcript || request.json_timestamps {
        transcribe_outputs(&app, &request, &output_path).ok()
    } else {
        None
    };

    emit_job(
        &app,
        &request.id,
        "done",
        if transcript_outputs.is_some() {
            "Video cleaned and transcript outputs generated"
        } else if request.subtitles || request.transcript || request.json_timestamps {
            "Video cleaned; whisper.cpp is missing or transcription failed"
        } else {
            "Video cleaned"
        },
        100,
        None,
    );

    Ok(ProcessVideoResult {
        id: request.id,
        output_path: output_path.to_string_lossy().to_string(),
        output_dir: output_dir.to_string_lossy().to_string(),
        transcript_path: transcript_outputs
            .as_ref()
            .and_then(|outputs| outputs.transcript_path.clone())
            .map(display_path),
        subtitles_path: transcript_outputs
            .as_ref()
            .and_then(|outputs| outputs.subtitles_path.clone())
            .map(display_path),
        timestamps_path: transcript_outputs
            .and_then(|outputs| outputs.timestamps_path)
            .map(display_path),
    })
}

#[tauri::command]
fn create_results_zip(app: AppHandle) -> Result<String, AppError> {
    let output_dir = ensure_output_dir(&app)?;
    let zip_path = output_dir
        .parent()
        .unwrap_or(&output_dir)
        .join("VideoCleaner-results.zip");

    if zip_path.exists() {
        fs::remove_file(&zip_path)?;
    }

    let status = Command::new("ditto")
        .arg("-c")
        .arg("-k")
        .arg("--sequesterRsrc")
        .arg("--keepParent")
        .arg(&output_dir)
        .arg(&zip_path)
        .status()?;

    if status.success() {
        Ok(zip_path.to_string_lossy().to_string())
    } else {
        Err(AppError::Message("Failed to create results ZIP".into()))
    }
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), AppError> {
    let status = Command::new("open").arg(path).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::Message("Failed to open path in Finder".into()))
    }
}

fn resolve_tool(app: &AppHandle, command: &str) -> Option<PathBuf> {
    candidate_tool_paths(app, command)
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| command_in_path(command))
}

fn resolve_first_tool(app: &AppHandle, commands: &[&str]) -> Option<PathBuf> {
    commands
        .iter()
        .find_map(|command| resolve_tool(app, command))
}

fn resolve_whisper_model(app: &AppHandle) -> Option<PathBuf> {
    candidate_model_paths(app)
        .into_iter()
        .find(|path| path.is_file())
}

fn command_in_path(command: &str) -> Option<PathBuf> {
    let output = Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {}", command))
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn candidate_tool_paths(app: &AppHandle, command: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(current_exe) = env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            paths.push(exe_dir.join(command));
            paths.push(exe_dir.join("tools").join(command));
            if let Some(contents_dir) = exe_dir.parent() {
                paths.push(contents_dir.join("Resources").join(command));
                paths.push(contents_dir.join("Resources").join("tools").join(command));
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join(command));
        paths.push(resource_dir.join("tools").join(command));
        paths.push(resource_dir.join("whisper").join(command));
    }

    if let Ok(current_dir) = env::current_dir() {
        paths.push(current_dir.join("tools").join(command));
        paths.push(current_dir.join("src-tauri").join("binaries").join(command));
        paths.push(
            current_dir
                .join("src-tauri")
                .join("binaries")
                .join("tools")
                .join(command),
        );
        paths.push(
            current_dir
                .join("src-tauri")
                .join("binaries")
                .join("whisper")
                .join(command),
        );
    }

    paths
}

fn candidate_model_paths(app: &AppHandle) -> Vec<PathBuf> {
    let names = [
        "ggml-tiny.bin",
        "ggml-tiny.en.bin",
        "ggml-base.bin",
        "ggml-small.bin",
        "ggml-medium.bin",
        "ggml-large-v3.bin",
    ];
    let mut dirs = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("models"));
        dirs.push(resource_dir.join("whisper").join("models"));
    }

    if let Ok(current_dir) = env::current_dir() {
        dirs.push(current_dir.join("models"));
        dirs.push(
            current_dir
                .join("src-tauri")
                .join("binaries")
                .join("models"),
        );
        dirs.push(
            current_dir
                .join("src-tauri")
                .join("binaries")
                .join("whisper")
                .join("models"),
        );
    }

    dirs.into_iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .collect()
}

fn display_path(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

#[derive(Debug)]
struct TranscriptOutputs {
    transcript_path: Option<PathBuf>,
    subtitles_path: Option<PathBuf>,
    timestamps_path: Option<PathBuf>,
}

fn transcribe_outputs(
    app: &AppHandle,
    request: &ProcessVideoRequest,
    video_path: &Path,
) -> Result<TranscriptOutputs, AppError> {
    emit_job(app, &request.id, "processing", "Extracting audio", 82, None);

    let ffmpeg = resolve_tool(app, "ffmpeg")
        .ok_or_else(|| AppError::Message("ffmpeg is required for transcription".into()))?;
    let whisper = resolve_first_tool(app, &["whisper-cli", "whisper", "main"])
        .ok_or_else(|| AppError::Message("whisper.cpp binary is missing".into()))?;
    let model = resolve_whisper_model(app)
        .ok_or_else(|| AppError::Message("whisper.cpp model is missing".into()))?;

    let work_dir = ensure_work_dir(app)?;
    let audio_path = work_dir.join(format!("{}.wav", request.id));
    let transcript_base = transcript_base_path(video_path);

    let audio_status = Command::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(video_path)
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&audio_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()?;

    if !audio_status.success() {
        return Err(AppError::Message(
            "Failed to extract audio for whisper.cpp".into(),
        ));
    }

    emit_job(app, &request.id, "processing", "Transcribing", 90, None);

    let mut command = Command::new(whisper);
    command
        .arg("-m")
        .arg(model)
        .arg("-f")
        .arg(&audio_path)
        .arg("-of")
        .arg(&transcript_base);

    if request.transcript {
        command.arg("-otxt");
    }
    if request.subtitles {
        command.arg("-osrt");
    }
    if request.json_timestamps {
        command.arg("-oj");
    }

    match request.language {
        Language::Auto => {}
        Language::Russian => {
            command.arg("-l").arg("ru");
        }
        Language::English => {
            command.arg("-l").arg("en");
        }
    }

    let whisper_output = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()?;
    let _ = fs::remove_file(&audio_path);

    if !whisper_output.status.success() {
        let stderr = String::from_utf8_lossy(&whisper_output.stderr);
        return Err(AppError::Message(format!("whisper.cpp failed: {}", stderr)));
    }

    Ok(TranscriptOutputs {
        transcript_path: request
            .transcript
            .then(|| transcript_base.with_extension("txt")),
        subtitles_path: request
            .subtitles
            .then(|| transcript_base.with_extension("srt")),
        timestamps_path: request
            .json_timestamps
            .then(|| transcript_base.with_extension("json")),
    })
}

fn ensure_output_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let base = match app.path().document_dir() {
        Ok(path) => path,
        Err(_) => std::env::current_dir()?,
    };
    let dir = base.join("VideoCleaner").join("Outputs");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn make_output_path(output_dir: &Path, source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("video");
    output_dir.join(format!("{}_clean.mp4", stem))
}

fn transcript_base_path(video_path: &Path) -> PathBuf {
    let stem = video_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("transcript");
    video_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(stem)
}

fn ensure_work_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let base = match app.path().app_cache_dir() {
        Ok(path) => path,
        Err(_) => std::env::temp_dir(),
    };
    let dir = base.join("VideoCleaner");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn open_database(app: &AppHandle) -> Result<Connection, AppError> {
    let db_path = ensure_data_dir(app)?.join("state.sqlite");
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "
        pragma journal_mode = wal;
        create table if not exists settings (
          key text primary key,
          value text not null,
          updated_at text not null default (datetime('now'))
        );
        create table if not exists jobs (
          id text primary key,
          position integer not null,
          payload text not null,
          updated_at text not null default (datetime('now'))
        );
        create index if not exists idx_jobs_position on jobs(position);
        ",
    )?;
    Ok(conn)
}

fn ensure_data_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let base = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => env::current_dir()?.join(".video-cleaner"),
    };
    fs::create_dir_all(&base)?;
    Ok(base)
}

fn selected_video(path: PathBuf) -> Result<SelectedVideo, AppError> {
    let metadata = fs::metadata(&path)?;
    Ok(SelectedVideo {
        id: Uuid::new_v4().to_string(),
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("video")
            .to_string(),
        path: path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
    })
}

fn is_supported_video(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("mp4" | "mov" | "m4v" | "avi" | "mkv" | "webm")
    )
}

fn auto_editor_args(request: &ProcessVideoRequest, output_path: &Path) -> Vec<String> {
    let margin = match request.preset {
        CutPreset::Gentle => "0.25sec",
        CutPreset::Normal => "0.15sec",
        CutPreset::Aggressive => "0.05sec",
    };
    let edit_threshold = match request.preset {
        CutPreset::Gentle => "audio:threshold=0.025",
        CutPreset::Normal => "audio:threshold=0.04",
        CutPreset::Aggressive => "audio:threshold=0.06",
    };

    let args = vec![
        "--edit".to_string(),
        edit_threshold.to_string(),
        "--margin".to_string(),
        margin.to_string(),
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
    ];

    args
}

fn emit_job(
    app: &AppHandle,
    id: &str,
    status: &str,
    step: &str,
    progress: u8,
    message: Option<String>,
) {
    let _ = app.emit(
        "job-event",
        JobEvent {
            id: id.to_string(),
            status: status.to_string(),
            step: step.to_string(),
            progress,
            message,
        },
    );
}
