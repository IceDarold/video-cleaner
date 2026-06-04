import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  CircleAlert,
  FileVideo,
  FolderOpen,
  Loader2,
  Package,
  Play,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import "./styles.css";

type Preset = "gentle" | "normal" | "aggressive";
type Language = "auto" | "russian" | "english";
type JobStatus = "queued" | "processing" | "done" | "failed";

type ToolStatus = {
  autoEditor: boolean;
  autoEditorPath?: string;
  ffmpeg: boolean;
  ffmpegPath?: string;
  ffprobe: boolean;
  ffprobePath?: string;
  whisper: boolean;
  whisperPath?: string;
  whisperModel?: string;
  outputDir: string;
};

type SelectedVideo = {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
};

type VideoJob = SelectedVideo & {
  status: JobStatus;
  step: string;
  progress: number;
  outputPath?: string;
  transcriptPath?: string;
  subtitlesPath?: string;
  timestampsPath?: string;
  error?: string;
};

type JobEvent = {
  id: string;
  status: JobStatus;
  step: string;
  progress: number;
  message?: string;
};

type Settings = {
  preset: Preset;
  subtitles: boolean;
  transcript: boolean;
  jsonTimestamps: boolean;
  language: Language;
};

type PersistedAppState = {
  settings?: unknown;
  jobs: unknown[];
};

const defaultSettings: Settings = {
  preset: "normal",
  subtitles: true,
  transcript: true,
  jsonTimestamps: true,
  language: "auto",
};

const settingsStorageKey = "video-cleaner-settings";
const jobsStorageKey = "video-cleaner-jobs";

function App() {
  const previewMode = !isTauri();
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [jobs, setJobs] = useState<VideoJob[]>(() => readStoredJobs());
  const [settings, setSettings] = useState<Settings>(() => readStoredSettings());
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTab, setActiveTab] = useState<"queue" | "results">("queue");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const persistenceReady = useRef(previewMode);

  useEffect(() => {
    void refreshTools();
    if (isTauri()) {
      void loadPersistedState();
    }

    const unlisten = isTauri()
      ? listen<JobEvent>("job-event", (event) => {
      setJobs((current) =>
        current.map((job) =>
          job.id === event.payload.id
            ? {
                ...job,
                status: event.payload.status,
                step: event.payload.step,
                progress: event.payload.progress,
                error: event.payload.status === "failed" ? event.payload.message : job.error,
              }
            : job,
        ),
      );
        })
      : Promise.resolve(() => undefined);

    const unlistenDragDrop = isTauri()
      ? getCurrentWindow().onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            void addVideosFromPaths(event.payload.paths);
          }
        })
      : Promise.resolve(() => undefined);

    return () => {
      void unlisten.then((dispose) => dispose());
      void unlistenDragDrop.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    const restorableJobs = jobs.map((job) =>
      job.status === "processing"
        ? { ...job, status: "queued" as JobStatus, step: "Queued", progress: 0 }
        : job,
    );

    localStorage.setItem(jobsStorageKey, JSON.stringify(restorableJobs));
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));

    if (isTauri() && persistenceReady.current) {
      void invoke("save_app_state", { settings, jobs: restorableJobs }).catch((error) => {
        setGlobalError(String(error));
      });
    }
  }, [jobs, settings]);

  const totalSize = useMemo(
    () => jobs.reduce((sum, job) => sum + job.sizeBytes, 0),
    [jobs],
  );
  const doneCount = jobs.filter((job) => job.status === "done").length;
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  const canStart = jobs.length > 0 && !isProcessing && (previewMode || Boolean(tools?.autoEditor));

  async function refreshTools() {
    if (!isTauri()) {
      setTools({
        autoEditor: false,
        autoEditorPath: undefined,
        ffmpeg: false,
        ffmpegPath: undefined,
        ffprobe: false,
        ffprobePath: undefined,
        whisper: false,
        whisperPath: undefined,
        whisperModel: undefined,
        outputDir: "~/Documents/VideoCleaner/Outputs",
      });
      return;
    }

    try {
      const status = await invoke<ToolStatus>("check_tools");
      setTools(status);
    } catch {
      setTools({
        autoEditor: false,
        autoEditorPath: undefined,
        ffmpeg: false,
        ffmpegPath: undefined,
        ffprobe: false,
        ffprobePath: undefined,
        whisper: false,
        whisperPath: undefined,
        whisperModel: undefined,
        outputDir: "~/Documents/VideoCleaner/Outputs",
      });
    }
  }

  async function loadPersistedState() {
    try {
      const state = await invoke<PersistedAppState>("load_app_state");
      setSettings(coerceSettings(state.settings));
      setJobs(coerceJobs(state.jobs));
    } catch (error) {
      setGlobalError(String(error));
    } finally {
      persistenceReady.current = true;
    }
  }

  async function addVideosFromPaths(paths: string[]) {
    if (!isTauri()) return;
    setGlobalError(null);
    const videos = await invoke<SelectedVideo[]>("videos_from_paths", { paths });
    if (!videos.length) return;

    setJobs((current) => [
      ...current,
      ...videos.map((video) => ({
        ...video,
        status: "queued" as JobStatus,
        step: "Queued",
        progress: 0,
      })),
    ]);
    setActiveTab("queue");
  }

  async function selectVideos() {
    if (!isTauri()) {
      addDemoJobs();
      return;
    }

    setGlobalError(null);
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: "Choose videos",
        filters: [
          {
            name: "Video",
            extensions: ["mp4", "mov", "m4v", "avi", "mkv", "webm"],
          },
        ],
      });

      if (!selected) return;
      await addVideosFromPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (error) {
      setGlobalError(String(error));
    }
  }

  async function startProcessing() {
    if (!isTauri()) {
      await simulateProcessing();
      return;
    }
    setGlobalError(null);
    setIsProcessing(true);
    setActiveTab("queue");

    for (const job of jobs.filter((item) => item.status === "queued" || item.status === "failed")) {
      setJobs((current) =>
        current.map((item) =>
          item.id === job.id
            ? { ...item, status: "processing", step: "Starting", progress: 1, error: undefined }
            : item,
        ),
      );

      try {
        const result = await invoke<{
          id: string;
          outputPath: string;
          transcriptPath?: string;
          subtitlesPath?: string;
          timestampsPath?: string;
        }>("process_video", {
          request: {
            id: job.id,
            path: job.path,
            ...settings,
          },
        });
        setJobs((current) =>
          current.map((item) =>
            item.id === job.id
              ? {
                  ...item,
                  status: "done",
                  step: "Done",
                  progress: 100,
                  outputPath: result.outputPath,
                  transcriptPath: result.transcriptPath,
                  subtitlesPath: result.subtitlesPath,
                  timestampsPath: result.timestampsPath,
                }
              : item,
          ),
        );
      } catch (error) {
        setJobs((current) =>
          current.map((item) =>
            item.id === job.id
              ? {
                  ...item,
                  status: "failed",
                  step: "Failed",
                  progress: 100,
                  error: String(error),
                }
              : item,
          ),
        );
      }
    }

    setIsProcessing(false);
    setActiveTab("results");
  }

  function removeJob(id: string) {
    setJobs((current) => current.filter((job) => job.id !== id));
  }

  async function reveal(path?: string) {
    if (!path || !isTauri()) return;
    await invoke("reveal_path", { path });
  }

  async function createZip() {
    if (!isTauri()) {
      setGlobalError("ZIP export is available in the packaged app.");
      return;
    }
    setGlobalError(null);
    try {
      const zipPath = await invoke<string>("create_results_zip");
      await reveal(zipPath);
    } catch (error) {
      setGlobalError(String(error));
    }
  }

  function addDemoJobs() {
    setGlobalError(null);
    setJobs((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: "demo_interview.mp4",
        path: "~/Movies/demo_interview.mp4",
        sizeBytes: 482_344_960,
        status: "queued",
        step: "Queued",
        progress: 0,
      },
      {
        id: crypto.randomUUID(),
        name: "demo_course_clip.mov",
        path: "~/Movies/demo_course_clip.mov",
        sizeBytes: 294_721_536,
        status: "queued",
        step: "Queued",
        progress: 0,
      },
    ]);
    setActiveTab("queue");
  }

  async function simulateProcessing() {
    setGlobalError(null);
    setIsProcessing(true);
    setActiveTab("queue");

    for (const job of jobs.filter((item) => item.status === "queued" || item.status === "failed")) {
      for (const update of [
        ["Starting", 8],
        ["Analyzing audio", 28],
        ["Cutting silence", 58],
        ["Writing output", 84],
      ] as const) {
        setJobs((current) =>
          current.map((item) =>
            item.id === job.id
              ? {
                  ...item,
                  status: "processing",
                  step: update[0],
                  progress: update[1],
                  error: undefined,
                }
              : item,
          ),
        );
        await sleep(350);
      }

      setJobs((current) =>
        current.map((item) =>
          item.id === job.id
            ? {
                ...item,
                status: "done",
                step: "Done",
                progress: 100,
                outputPath: `~/Documents/VideoCleaner/Outputs/${job.name.replace(/\.[^.]+$/, "")}_clean.mp4`,
                transcriptPath: `~/Documents/VideoCleaner/Outputs/${job.name.replace(/\.[^.]+$/, "")}_clean.txt`,
                subtitlesPath: `~/Documents/VideoCleaner/Outputs/${job.name.replace(/\.[^.]+$/, "")}_clean.srt`,
                timestampsPath: `~/Documents/VideoCleaner/Outputs/${job.name.replace(/\.[^.]+$/, "")}_clean.json`,
              }
            : item,
        ),
      );
    }

    setIsProcessing(false);
    setActiveTab("results");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">VC</div>
          <div>
            <h1>VideoCleaner</h1>
            <p>Batch cleaner for local videos</p>
          </div>
        </div>

        <button className="primary-action" onClick={selectVideos}>
          <Upload size={18} />
          {previewMode ? "Add demo" : "Choose videos"}
        </button>

        <nav className="tabs" aria-label="Views">
          <button
            className={activeTab === "queue" ? "active" : ""}
            onClick={() => setActiveTab("queue")}
          >
            <FileVideo size={18} />
            Queue
          </button>
          <button
            className={activeTab === "results" ? "active" : ""}
            onClick={() => setActiveTab("results")}
          >
            <CheckCircle2 size={18} />
            Results
          </button>
        </nav>

        <section className="tools-panel">
          <h2>Engines</h2>
          <ToolLine label="auto-editor" ready={tools?.autoEditor} path={tools?.autoEditorPath} />
          <ToolLine label="ffmpeg" ready={tools?.ffmpeg} path={tools?.ffmpegPath} muted />
          <ToolLine label="ffprobe" ready={tools?.ffprobe} path={tools?.ffprobePath} muted />
          <ToolLine
            label="whisper.cpp"
            ready={tools?.whisper}
            path={tools?.whisperPath || tools?.whisperModel}
            muted
          />
          <button className="subtle-button" onClick={refreshTools}>
            Refresh
          </button>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{jobs.length} files selected</p>
            <h2>{activeTab === "queue" ? "Processing queue" : "Results"}</h2>
          </div>
          <div className="summary">
            <span>{formatBytes(totalSize)}</span>
            <span>{doneCount} done</span>
            <span>{failedCount} failed</span>
          </div>
        </header>

        {previewMode && (
          <div className="banner preview-banner">
            <CircleAlert size={18} />
            <span>Preview mode is running without the Tauri bridge. Demo jobs simulate processing.</span>
          </div>
        )}

        {!previewMode && !tools?.autoEditor && (
          <div className="banner">
            <CircleAlert size={18} />
            <span>
              `auto-editor` is missing. Install it with `python3 -m pip install auto-editor`
              or bundle it as a Tauri sidecar before distributing the app.
            </span>
          </div>
        )}

        {globalError && (
          <div className="banner error-banner">
            <CircleAlert size={18} />
            <span>{globalError}</span>
          </div>
        )}

        <div className="content-grid">
          <section className="main-panel">
            {activeTab === "queue" ? (
              <QueueView jobs={jobs} onRemove={removeJob} onSelect={selectVideos} previewMode={previewMode} />
            ) : (
              <ResultsView
                jobs={jobs}
                outputDir={tools?.outputDir}
                onReveal={reveal}
                onCreateZip={createZip}
              />
            )}
          </section>

          <SettingsPanel
            settings={settings}
            setSettings={setSettings}
            canStart={canStart}
            isProcessing={isProcessing}
            onStart={startProcessing}
          />
        </div>
      </section>
    </main>
  );
}

function QueueView({
  jobs,
  onRemove,
  onSelect,
  previewMode,
}: {
  jobs: VideoJob[];
  onRemove: (id: string) => void;
  onSelect: () => void;
  previewMode: boolean;
}) {
  if (!jobs.length) {
    return (
      <button className="drop-zone" onClick={onSelect}>
        <Upload size={32} />
        <strong>{previewMode ? "Add demo videos" : "Drop videos here"}</strong>
        <span>
          {previewMode
            ? "Use sample jobs to preview the queue and results flow"
            : "Drag MP4, MOV, M4V, AVI, MKV, or WebM files into this window"}
        </span>
      </button>
    );
  }

  return (
    <div className="job-list">
      {jobs.map((job) => (
        <article className="job-card" key={job.id}>
          <div className="job-icon">
            {job.status === "processing" ? <Loader2 className="spin" /> : <FileVideo />}
          </div>
          <div className="job-body">
            <div className="job-title-row">
              <div>
                <h3>{job.name}</h3>
                <p>{job.step}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => onRemove(job.id)}
                aria-label={`Remove ${job.name}`}
                disabled={job.status === "processing"}
              >
                <X size={17} />
              </button>
            </div>
            <div className="progress-track">
              <div style={{ width: `${job.progress}%` }} />
            </div>
            {job.error && <p className="error-text">{job.error}</p>}
          </div>
          <span className={`status-pill ${job.status}`}>{job.status}</span>
        </article>
      ))}
    </div>
  );
}

function ResultsView({
  jobs,
  outputDir,
  onReveal,
  onCreateZip,
}: {
  jobs: VideoJob[];
  outputDir?: string;
  onReveal: (path?: string) => void;
  onCreateZip: () => void;
}) {
  const finished = jobs.filter((job) => job.status === "done" || job.status === "failed");

  if (!finished.length) {
    return <div className="empty-state">No processed videos yet.</div>;
  }

  return (
    <div className="results-list">
      <div className="results-actions">
        <button className="secondary-action" onClick={onCreateZip}>
          <Package size={18} />
          Create ZIP
        </button>
        <button className="secondary-action" onClick={() => onReveal(outputDir)}>
          <FolderOpen size={18} />
          Open output folder
        </button>
      </div>
      {finished.map((job) => (
        <article className="result-row" key={job.id}>
          <div>
            <h3>{job.name}</h3>
            <p>{job.outputPath || job.error || "No output"}</p>
            {(job.transcriptPath || job.subtitlesPath || job.timestampsPath) && (
              <p className="result-artifacts">
                {[job.subtitlesPath && "SRT", job.transcriptPath && "TXT", job.timestampsPath && "JSON"]
                  .filter(Boolean)
                  .join(" / ")}
              </p>
            )}
          </div>
          {job.outputPath && (
            <button className="icon-button" onClick={() => onReveal(job.outputPath)}>
              <FolderOpen size={17} />
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

function SettingsPanel({
  settings,
  setSettings,
  canStart,
  isProcessing,
  onStart,
}: {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  canStart: boolean;
  isProcessing: boolean;
  onStart: () => void;
}) {
  return (
    <aside className="settings-panel">
      <div className="panel-heading">
        <Settings2 size={18} />
        <h2>Settings</h2>
      </div>

      <fieldset>
        <legend>Cut style</legend>
        <Segmented
          value={settings.preset}
          options={[
            ["gentle", "Careful"],
            ["normal", "Normal"],
            ["aggressive", "Aggressive"],
          ]}
          onChange={(preset) => setSettings((current) => ({ ...current, preset }))}
        />
      </fieldset>

      <fieldset>
        <legend>Language</legend>
        <Segmented
          value={settings.language}
          options={[
            ["auto", "Auto"],
            ["russian", "Russian"],
            ["english", "English"],
          ]}
          onChange={(language) => setSettings((current) => ({ ...current, language }))}
        />
      </fieldset>

      <fieldset>
        <legend>Outputs</legend>
        <Toggle
          label="SRT subtitles"
          checked={settings.subtitles}
          onChange={(subtitles) => setSettings((current) => ({ ...current, subtitles }))}
        />
        <Toggle
          label="TXT transcript"
          checked={settings.transcript}
          onChange={(transcript) => setSettings((current) => ({ ...current, transcript }))}
        />
        <Toggle
          label="JSON timestamps"
          checked={settings.jsonTimestamps}
          onChange={(jsonTimestamps) =>
            setSettings((current) => ({ ...current, jsonTimestamps }))
          }
        />
      </fieldset>

      <button className="start-button" disabled={!canStart} onClick={onStart}>
        {isProcessing ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
        Start processing
      </button>
    </aside>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map(([option, label]) => (
        <button
          className={value === option ? "selected" : ""}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function ToolLine({
  label,
  ready,
  path,
  muted = false,
}: {
  label: string;
  ready?: boolean;
  path?: string;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "tool-line muted" : "tool-line"}>
      <span>
        {label}
        {path && <small title={path}>{compactPath(path)}</small>}
      </span>
      <strong className={ready ? "ok" : "missing"}>{ready ? "Ready" : "Missing"}</strong>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

function compactPath(path: string) {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return `${parts[parts.length - 3]}/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readStoredSettings(): Settings {
  try {
    const raw = localStorage.getItem(settingsStorageKey);
    if (!raw) return defaultSettings;
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return defaultSettings;
  }
}

function readStoredJobs(): VideoJob[] {
  try {
    const raw = localStorage.getItem(jobsStorageKey);
    if (!raw) return [];
    const jobs = JSON.parse(raw) as VideoJob[];
    if (!Array.isArray(jobs)) return [];
    return jobs.map((job) =>
      job.status === "processing"
        ? { ...job, status: "queued", step: "Queued", progress: 0 }
        : job,
    );
  } catch {
    return [];
  }
}

function coerceSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") return defaultSettings;
  return { ...defaultSettings, ...(value as Partial<Settings>) };
}

function coerceJobs(value: unknown): VideoJob[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((job): job is VideoJob => Boolean(job && typeof job === "object" && "id" in job))
    .map((job) =>
      job.status === "processing"
        ? { ...job, status: "queued", step: "Queued", progress: 0 }
        : job,
    );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
