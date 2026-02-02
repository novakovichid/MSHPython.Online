import { gzipSync, gunzipSync, unzipSync } from "./fflate.esm.js";
import { mergeUniqueIds } from "./utils/recent-utils.js";
import { getBaseName, createNumberedImportName } from "./utils/import-utils.js";

const CONFIG = {
  RUN_TIMEOUT_MS: 10000,
  MAX_OUTPUT_BYTES: 2000000,
  MAX_FILES: 30,
  MAX_TOTAL_TEXT_BYTES: 250000,
  MAX_SINGLE_FILE_BYTES: 50000,
  TAB_SIZE: 4,
  WORD_WRAP: true
};
const MAIN_FILE = "main.py";
const STDIN_SHARED_BYTES = 8192;

const VALID_FILENAME = /^[A-Za-z0-9._\-\u0400-\u04FF]+$/;
const encoder = typeof TextEncoder !== "undefined"
  ? new TextEncoder()
  : {
      encode: (text) => {
        const utf8 = unescape(encodeURIComponent(String(text)));
        const bytes = new Uint8Array(utf8.length);
        for (let i = 0; i < utf8.length; i += 1) {
          bytes[i] = utf8.charCodeAt(i);
        }
        return bytes;
      }
    };
const decoder = typeof TextDecoder !== "undefined"
  ? new TextDecoder()
  : {
      decode: (input) => {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return decodeURIComponent(escape(binary));
      }
    };
const supportsPointerEvents = "PointerEvent" in window;
const supportsPassiveEvents = (() => {
  let supported = false;
  try {
    const noop = () => {};
    const opts = Object.defineProperty({}, "passive", {
      get() {
        supported = true;
        return true;
      }
    });
    window.addEventListener("test-passive", noop, opts);
    window.removeEventListener("test-passive", noop, opts);
  } catch (error) {
    supported = false;
  }
  return supported;
})();
const touchEventOptions = supportsPassiveEvents ? { passive: false } : false;
const RUN_STATUS_LABELS = {
  idle: "Ожидание",
  running: "Выполняется",
  done: "Готово",
  error: "Ошибка",
  stopped: "Остановлено"
};
const COI_RELOAD_KEY = "shp-coi-reload";
const TURTLE_CANVAS_WIDTH = 400;
const TURTLE_CANVAS_HEIGHT = 300;
const TURTLE_SPEED_PRESETS = [
  { key: "slow", label: "Черепаха: Спокойно", multiplier: 1.3 },
  { key: "fast", label: "Черепаха: Быстро", multiplier: 2.2 },
  { key: "ultra", label: "Черепаха: Супер", multiplier: 3.6 }
];
const TURTLE_BASE_SPEED_PX_PER_MS = 1.1;
const TURTLE_MIN_STEP_MS = 16;
const DEFAULT_TURTLE_ID = "default";
const IMAGE_ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp"
]);

const state = {
  db: null,
  mode: "landing",
  project: null,
  snapshot: null,
  activeFile: null,
  settings: {
    tabSize: CONFIG.TAB_SIZE,
    wordWrap: CONFIG.WORD_WRAP,
    turtleSpeed: "ultra"
  },
  worker: null,
  workerReady: false,
  runtimeBlocked: false,
  runStatus: "idle",
  stdinQueue: [],
  stdinWaiting: false,
  stdinMode: "message",
  stdinShared: null,
  stdinHeader: null,
  stdinBuffer: null,
  lastStdinRequestMode: null,
  runTimeout: null,
  hardStopTimer: null,
  outputBytes: 0,
  saveTimer: null,
  draftTimer: null,
  embed: {
    active: false,
    display: "side",
    mode: "allowEither",
    autorun: false,
    readonly: false
  }
};

let workerGeneration = 0;

const els = {
  guard: document.getElementById("guard"),
  guardReload: document.getElementById("guard-reload"),
  modal: document.getElementById("modal"),
  toasts: document.getElementById("toasts"),
  viewLanding: document.getElementById("view-landing"),
  viewIde: document.getElementById("view-ide"),
  snapshotBanner: document.getElementById("snapshot-banner"),
  newProject: document.getElementById("new-project"),
  clearRecent: document.getElementById("clear-recent"),
  trashRecent: document.getElementById("trash-recent"),
  recentList: document.getElementById("recent-list"),
  projectTitle: document.getElementById("project-title"),
  projectMode: document.getElementById("project-mode"),
  saveIndicator: document.getElementById("save-indicator"),
  runBtn: document.getElementById("run-btn"),
  stopBtn: document.getElementById("stop-btn"),
  clearBtn: document.getElementById("clear-btn"),
  shareBtn: document.getElementById("share-btn"),
  exportBtn: document.getElementById("export-btn"),
  importBtn: document.getElementById("import-btn"),
  remixBtn: document.getElementById("remix-btn"),
  resetBtn: document.getElementById("reset-btn"),
  tabSizeBtn: document.getElementById("tab-size-btn"),
  wrapBtn: document.getElementById("wrap-btn"),
  turtleSpeedRange: document.getElementById("turtle-speed"),
  turtleSpeedLabel: document.getElementById("turtle-speed-label"),
  sidebar: document.getElementById("sidebar"),
  fileList: document.getElementById("file-list"),
  assetList: document.getElementById("asset-list"),
  fileCreate: document.getElementById("file-create"),
  fileRename: document.getElementById("file-rename"),
  fileDuplicate: document.getElementById("file-duplicate"),
  fileDelete: document.getElementById("file-delete"),
  assetInput: document.getElementById("asset-input"),
  fileTabs: document.getElementById("file-tabs"),
  lineNumbers: document.getElementById("line-numbers"),
  editorHighlight: document.getElementById("editor-highlight"),
  editor: document.getElementById("editor"),
  importInput: document.getElementById("import-input"),
  consoleOutput: document.getElementById("console-output"),
  consoleInput: document.getElementById("console-input"),
  consoleSend: document.getElementById("console-send"),
  runStatus: document.getElementById("run-status"),
  turtleCanvas: document.getElementById("turtle-canvas"),
  turtleClear: document.getElementById("turtle-clear")
};

const DEBUG_ENABLED = typeof location !== "undefined" && location.search.includes("debug=1");
if (DEBUG_ENABLED && typeof window !== "undefined") {
  window.__mshpDebug = {
    getStdinMode: () => state.stdinMode,
    getStdinWaiting: () => state.stdinWaiting,
    getLastStdinRequestMode: () => state.lastStdinRequestMode,
    getStdinHeader: () => {
      if (!state.stdinHeader) {
        return null;
      }
      const flag = Atomics.load(state.stdinHeader, 0);
      const length = Atomics.load(state.stdinHeader, 1);
      return [flag, length];
    },
    getStdinBytes: (count = 8) => {
      if (!state.stdinBuffer) {
        return null;
      }
      return Array.from(state.stdinBuffer.slice(0, count));
    },
    writeSharedDebug: (value) => writeSharedStdin(value)
  };
}

const turtleRenderer = {
  ready: false,
  canvas: null,
  ctx: null,
  drawCanvas: null,
  drawCtx: null,
  strokeCanvas: null,
  strokeCtx: null,
  bg: "#f5f9ff",
  bgImage: null,
  bgImageName: null,
  centerX: 0,
  centerY: 0,
  world: null,
  mode: "standard",
  turtles: new Map(),
  turtleOrder: [],
  queue: [],
  animating: false,
  current: null,
  assetUrls: new Map(),
  assetImages: new Map(),
  fileRequests: new Map()
};

const turtleInput = {
  listen: false,
  active: false,
  dragging: false,
  dragButton: 1,
  dragTarget: "screen"
};

function createUuid() {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
    }
  }
  const rand = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${rand()}${rand()}-${rand()}-${rand()}-${rand()}-${rand()}${rand()}${rand()}`;
}

const memoryDb = {
  projects: new Map(),
  blobs: new Map(),
  drafts: new Map(),
  recent: new Map(),
  trash: new Map()
};

function getStoreKey(storeName, value) {
  if (!value) {
    return null;
  }
  if (storeName === "projects") {
    return value.projectId;
  }
  if (storeName === "blobs") {
    return value.blobId;
  }
  if (storeName === "drafts") {
    return value.key;
  }
  if (storeName === "recent") {
    return value.key;
  }
  if (storeName === "trash") {
    return value.key;
  }
  return null;
}

function getMemoryStore(storeName) {
  return memoryDb[storeName] || null;
}

function safeSessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

function safeSessionRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch (error) {
    // Ignore.
  }
}

function safeLocalGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function safeLocalSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

init();

async function init() {
  showGuard(true);
  if (!("Worker" in window) || !("WebAssembly" in window)) {
    setGuardMessage("Unsupported browser", "This app needs WebAssembly and Web Workers.");
    return;
  }
  bindUi();
  const swEnabled = await registerServiceWorker();
  const compat = await ensureRuntimeCompatibility(swEnabled);
  if (compat.reloading) {
    return;
  }
  state.db = await openDb();
  if (!state.db) {
    showToast("Storage fallback: changes will not persist in this browser.");
  }
  loadSettings();
  initWorker();
  await router();
  window.addEventListener("hashchange", router);
}

async function ensureRuntimeCompatibility(swEnabled) {
  if (typeof globalThis !== "undefined" && globalThis.crossOriginIsolated === true) {
    safeSessionRemove(COI_RELOAD_KEY);
    return { ok: true, reloading: false };
  }
  if (!swEnabled) {
    return { ok: true, reloading: false };
  }

  await waitForServiceWorkerReady();
  if (typeof globalThis !== "undefined" && globalThis.crossOriginIsolated === true) {
    safeSessionRemove(COI_RELOAD_KEY);
    return { ok: true, reloading: false };
  }

  if (!safeSessionGet(COI_RELOAD_KEY)) {
    if (!safeSessionSet(COI_RELOAD_KEY, "1")) {
      return { ok: true, reloading: false };
    }
    location.reload();
    return { ok: false, reloading: true };
  }
  return { ok: true, reloading: false };
}

function waitForServiceWorkerReady(timeoutMs = 1500) {
  if (!("serviceWorker" in navigator)) {
    return Promise.resolve(false);
  }
  return Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

function bindUi() {
  if (els.guardReload) {
    els.guardReload.addEventListener("click", () => location.reload());
  }
  els.newProject.addEventListener("click", () => createProjectAndOpen());
  els.clearRecent.addEventListener("click", clearRecentProjects);
  if (els.trashRecent) {
    els.trashRecent.addEventListener("click", openTrashModal);
  }

  els.runBtn.addEventListener("click", runActiveFile);
  els.stopBtn.addEventListener("click", stopRun);
  els.clearBtn.addEventListener("click", clearConsole);
  els.shareBtn.addEventListener("click", shareProject);
  els.exportBtn.addEventListener("click", exportProject);
  if (els.importBtn) {
    els.importBtn.addEventListener("click", () => {
      if (state.mode !== "project" || state.embed.readonly || !els.importInput) {
        return;
      }
      els.importInput.value = "";
      els.importInput.click();
    });
  }
  if (els.importInput) {
    els.importInput.addEventListener("change", (event) => {
      const files = Array.from(event.target.files || []);
      if (!files.length) {
        return;
      }
      importFiles(files);
    });
  }
  els.remixBtn.addEventListener("click", remixSnapshot);
  els.resetBtn.addEventListener("click", resetSnapshot);
  els.tabSizeBtn.addEventListener("click", toggleTabSize);
  els.wrapBtn.addEventListener("click", toggleWrap);
  if (els.turtleSpeedRange) {
    els.turtleSpeedRange.addEventListener("input", onTurtleSpeedInput);
  }

  els.fileCreate.addEventListener("click", () => createFile());
  els.fileRename.addEventListener("click", () => renameFile());
  els.fileDuplicate.addEventListener("click", () => duplicateFile());
  els.fileDelete.addEventListener("click", () => deleteFile());
  els.assetInput.addEventListener("change", onAssetUpload);

  els.editor.addEventListener("input", onEditorInput);
  els.editor.addEventListener("keydown", onEditorKeydown);
  els.editor.addEventListener("scroll", syncEditorScroll);

  els.consoleSend.addEventListener("click", submitConsoleInput);
  els.consoleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitConsoleInput();
    }
  });

  els.turtleClear.addEventListener("click", () => clearTurtleCanvas());
  if (els.turtleCanvas) {
    if (supportsPointerEvents) {
      els.turtleCanvas.addEventListener("pointerdown", onTurtlePointerDown);
      els.turtleCanvas.addEventListener("pointermove", onTurtlePointerMove);
      els.turtleCanvas.addEventListener("pointerup", onTurtlePointerUp);
      els.turtleCanvas.addEventListener("pointercancel", onTurtlePointerUp);
    } else {
      els.turtleCanvas.addEventListener("mousedown", onTurtlePointerDown);
      window.addEventListener("mousemove", onTurtlePointerMove);
      window.addEventListener("mouseup", onTurtlePointerUp);
      els.turtleCanvas.addEventListener("touchstart", onTurtlePointerDown, touchEventOptions);
      els.turtleCanvas.addEventListener("touchmove", onTurtlePointerMove, touchEventOptions);
      els.turtleCanvas.addEventListener("touchend", onTurtlePointerUp);
      els.turtleCanvas.addEventListener("touchcancel", onTurtlePointerUp);
    }
    els.turtleCanvas.addEventListener("blur", () => {
      turtleInput.active = false;
    });
    els.turtleCanvas.addEventListener("focus", () => {
      turtleInput.active = true;
    });
    els.turtleCanvas.addEventListener("contextmenu", (event) => {
      if (turtleInput.active) {
        event.preventDefault();
      }
    });
  }
  document.addEventListener("keydown", onTurtleKeyDown);
  document.addEventListener("keyup", onTurtleKeyUp);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return false;
  }
  try {
    await navigator.serviceWorker.register("./sw.js");
    return true;
  } catch (error) {
    console.warn("Service worker failed", error);
    return false;
  }
}

function showGuard(show) {
  els.guard.classList.toggle("hidden", !show);
}

function setGuardMessage(title, message) {
  const heading = els.guard.querySelector("h2");
  const text = els.guard.querySelector("p");
  if (heading) {
    heading.textContent = title;
  }
  if (text) {
    text.textContent = message;
  }
}

function showView(view) {
  els.viewLanding.classList.toggle("hidden", view !== "landing");
  els.viewIde.classList.toggle("hidden", view !== "ide");
  state.mode = view === "landing" ? "landing" : state.mode;
}

async function router() {
  const { route, id, query } = parseHash();
  if (route === "landing") {
    showView("landing");
    await renderRecent();
    return;
  }

  showView("ide");
  resetEmbed();

  if (route === "project") {
    await openProject(id);
  } else if (route === "snapshot") {
    await openSnapshot(id, query.get("p"));
  } else if (route === "embed") {
    applyEmbedSettings(query);
    const payload = query.get("p");
    const shareId = query.get("s");
    if (payload && shareId) {
      await openSnapshot(shareId, payload);
    } else {
      openEphemeralProject();
    }
  } else {
    showToast("Неизвестный маршрут, переход на главную.");
    location.hash = "#/";
  }
}

function parseHash() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash || hash === "/") {
    return { route: "landing" };
  }

  const [pathPart, queryString] = hash.split("?");
  const path = pathPart.startsWith("/") ? pathPart.slice(1) : pathPart;
  const parts = path.split("/").filter(Boolean);
  const query = new URLSearchParams(queryString || "");

  if (parts[0] === "p") {
    return { route: "project", id: parts[1], query };
  }
  if (parts[0] === "s") {
    return { route: "snapshot", id: parts[1], query };
  }
  if (parts[0] === "embed") {
    return { route: "embed", query };
  }
  return { route: "landing" };
}
function resetEmbed() {
  state.embed = {
    active: false,
    display: "side",
    mode: "allowEither",
    autorun: false,
    readonly: false
  };
  els.editor.closest(".editor-pane").classList.remove("hidden");
  els.sidebar.classList.remove("hidden");
  els.consoleOutput.closest(".console-pane").classList.remove("hidden");
}

function applyEmbedSettings(query) {
  state.embed.active = true;
  state.embed.display = query.get("display") || "side";
  state.embed.mode = query.get("mode") || "allowEither";
  state.embed.autorun = query.get("autorun") === "1";
  state.embed.readonly = query.get("readonly") === "0" ? false : true;
  if (state.embed.mode !== "allowEither") {
    state.embed.readonly = true;
  }

  const hideEditor = state.embed.display === "output" || state.embed.mode === "consoleOnly";
  const hideConsole = state.embed.mode === "runOnly";

  els.editor.closest(".editor-pane").classList.toggle("hidden", hideEditor);
  els.sidebar.classList.toggle("hidden", hideEditor);
  els.consoleOutput.closest(".console-pane").classList.toggle("hidden", hideConsole);
}

async function openProject(projectId) {
  let project = projectId ? await dbGet("projects", projectId) : null;
  if (!project) {
    project = createDefaultProject(projectId);
    await saveProject(project);
  }
  state.project = project;
  state.snapshot = null;
  state.activeFile = project.lastActiveFile || project.files[0]?.name || null;
  ensureMainProject();
  state.activeFile = MAIN_FILE;

  setMode("project");
  renderProject();
  await rememberRecent(project.projectId);
}

async function createProjectAndOpen() {
  const name = await promptModal({
    title: "Название проекта",
    placeholder: "Мой проект",
    confirmText: "Создать"
  });
  if (name === null) {
    return;
  }
  const trimmed = name.trim();
  const project = createDefaultProject(undefined, trimmed || "Без названия");
  await saveProject(project);
  location.hash = `#/p/${project.projectId}`;
}

function openEphemeralProject() {
  const project = createDefaultProject();
  state.project = project;
  state.snapshot = null;
  state.activeFile = project.lastActiveFile || project.files[0]?.name || null;
  ensureMainProject();
  state.activeFile = MAIN_FILE;
  setMode("project");
  renderProject();
}

function createDefaultProject(projectId, title) {
  const id = projectId || createUuid();
  return {
    projectId: id,
    title: title || "Без названия",
    files: [
      {
        name: MAIN_FILE,
        content: ""
      }
    ],
    assets: [],
    lastActiveFile: MAIN_FILE,
    updatedAt: Date.now()
  };
}

function ensureMainFileRecord(files) {
  if (!Array.isArray(files)) {
    return false;
  }
  const mainIndex = files.findIndex((file) => file.name === MAIN_FILE);
  if (mainIndex === -1) {
    files.unshift({ name: MAIN_FILE, content: "" });
    return true;
  }
  if (mainIndex > 0) {
    const [main] = files.splice(mainIndex, 1);
    files.unshift(main);
    return true;
  }
  return false;
}

function ensureMainProject() {
  if (!state.project) {
    return;
  }
  const changed = ensureMainFileRecord(state.project.files);
  if (!state.project.lastActiveFile || !getFileByName(state.project.lastActiveFile)) {
    state.project.lastActiveFile = MAIN_FILE;
  }
  if (changed) {
    scheduleSave();
  }
}

function ensureMainSnapshot() {
  if (!state.snapshot) {
    return;
  }
  const { baseline, draft } = state.snapshot;
  const hasMainInBaseline = baseline.files.some((file) => file.name === MAIN_FILE);
  const hasMainInOverlay = Object.prototype.hasOwnProperty.call(draft.overlayFiles, MAIN_FILE);
  if (!hasMainInBaseline && !hasMainInOverlay) {
    draft.overlayFiles[MAIN_FILE] = "";
  }
  draft.deletedFiles = draft.deletedFiles.filter((name) => name !== MAIN_FILE);
  if (!draft.draftLastActiveFile || draft.draftLastActiveFile === MAIN_FILE) {
    draft.draftLastActiveFile = MAIN_FILE;
  }
  scheduleDraftSave();
}

async function openSnapshot(shareId, payload) {
  if (!payload) {
    showToast("В ссылке нет payload снимка.");
    location.hash = "#/";
    return;
  }

  try {
    const baseline = await decodePayload(payload);
    const draftKey = `draft:s:${shareId}`;
    const draft = (await dbGet("drafts", draftKey)) || {
      key: draftKey,
      overlayFiles: {},
      deletedFiles: [],
      draftLastActiveFile: null,
      updatedAt: Date.now()
    };

    state.snapshot = {
      shareId,
      baseline,
      draft
    };

    state.project = null;
    state.activeFile = draft.draftLastActiveFile || baseline.lastActiveFile || baseline.files[0]?.name || null;
    ensureMainSnapshot();
    state.activeFile = MAIN_FILE;

    setMode("snapshot");
    renderSnapshot();
  } catch (error) {
    console.error(error);
    showToast("Не удалось открыть снимок.");
    location.hash = "#/";
  }
}

function setMode(mode) {
  state.mode = mode;
  const isProject = mode === "project";
  const isSnapshot = mode === "snapshot";

  els.projectMode.textContent = isProject ? "Проект" : "Снимок";
  els.snapshotBanner.classList.toggle("hidden", !isSnapshot);
  els.shareBtn.classList.toggle("hidden", !isProject);
  els.exportBtn.classList.toggle("hidden", !isProject);
  if (els.importBtn) {
    els.importBtn.classList.toggle("hidden", !isProject);
  }
  els.remixBtn.classList.toggle("hidden", !isSnapshot);
  els.resetBtn.classList.toggle("hidden", !isSnapshot);
  els.saveIndicator.classList.toggle("hidden", !isProject);

  const disableEdits = state.embed.readonly;
  els.editor.readOnly = disableEdits;
  els.fileCreate.disabled = disableEdits;
  els.fileRename.disabled = disableEdits;
  els.fileDuplicate.disabled = disableEdits;
  els.fileDelete.disabled = disableEdits;
  els.assetInput.disabled = disableEdits || !isProject;
}

function renderProject() {
  els.projectTitle.textContent = state.project.title;
  ensureMainFileRecord(state.project.files);
  renderFiles(state.project.files);
  renderAssets(state.project.assets || []);
  updateFileActionState();
  updateEditorContent();
  updateTabs();
  updateSaveIndicator("Сохранено");
  if (state.embed.active && state.embed.autorun) {
    setTimeout(() => runActiveFile(), 200);
  }
}

function renderSnapshot() {
  const baseline = state.snapshot.baseline;
  els.projectTitle.textContent = baseline.title || "Общий снимок";
  renderFiles(getEffectiveFiles());
  renderAssets([]);
  updateFileActionState();
  updateEditorContent();
  updateTabs();
  updateSaveIndicator("Локальный черновик");
  if (state.embed.active && state.embed.autorun) {
    setTimeout(() => runActiveFile(), 200);
  }
}

function renderFiles(files) {
  els.fileList.innerHTML = "";
  files.forEach((file) => {
    const item = document.createElement("div");
    item.className = "file-item" + (file.name === state.activeFile ? " active" : "");
    const label = document.createElement("span");
    label.textContent = file.name;
    item.appendChild(label);
    item.addEventListener("click", () => setActiveFile(file.name));
    els.fileList.appendChild(item);
  });
}

function renderAssets(assets) {
  els.assetList.innerHTML = "";
  if (!assets.length) {
    const empty = document.createElement("div");
    empty.className = "asset-item";
    empty.innerHTML = "<span>Нет ресурсов</span>";
    els.assetList.appendChild(empty);
    return;
  }
  assets.forEach((asset) => {
    const item = document.createElement("div");
    item.className = "asset-item";
    const label = document.createElement("span");
    label.textContent = asset.name;
    const remove = document.createElement("button");
    remove.className = "btn small";
    remove.textContent = "Удалить";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeAsset(asset.name);
    });
    item.append(label, remove);
    els.assetList.appendChild(item);
  });
}

function updateTabs() {
  const files = getCurrentFiles();
  els.fileTabs.innerHTML = "";
  files.forEach((file) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (file.name === state.activeFile ? " active" : "");
    tab.textContent = file.name;
    tab.dataset.name = file.name;
    tab.addEventListener("click", () => setActiveFile(file.name));
    els.fileTabs.appendChild(tab);
  });
}

function setActiveFile(name) {
  state.activeFile = name;
  if (state.mode === "project") {
    state.project.lastActiveFile = name;
    scheduleSave();
  } else if (state.mode === "snapshot") {
    state.snapshot.draft.draftLastActiveFile = name;
    scheduleDraftSave();
  }
  updateFileActionState();
  renderFiles(getCurrentFiles());
  updateTabs();
  updateEditorContent();
}

function updateFileActionState() {
  const locked = state.activeFile === MAIN_FILE;
  if (els.fileRename) {
    els.fileRename.disabled = locked || state.embed.readonly;
  }
  if (els.fileDelete) {
    els.fileDelete.disabled = locked || state.embed.readonly;
  }
}

function updateEditorContent() {
  const file = getFileByName(state.activeFile);
  els.editor.value = file ? file.content : "";
  els.editor.focus();
  refreshEditorDecorations();
}

function onEditorInput() {
  const file = getFileByName(state.activeFile);
  if (!file || state.embed.readonly) {
    refreshEditorDecorations();
    return;
  }

  const content = els.editor.value;
  if (state.mode === "project") {
    file.content = content;
    scheduleSave();
  } else if (state.mode === "snapshot") {
    updateDraftFile(state.activeFile, content);
  }
  refreshEditorDecorations();
}

function onEditorKeydown(event) {
  const tabSize = state.settings.tabSize;
  const spaces = " ".repeat(tabSize);
  const start = els.editor.selectionStart;
  const end = els.editor.selectionEnd;
  const value = els.editor.value;

  if (event.key === "Tab") {
    event.preventDefault();
    els.editor.value = value.slice(0, start) + spaces + value.slice(end);
    els.editor.selectionStart = els.editor.selectionEnd = start + spaces.length;
    onEditorInput();
    return;
  }

  if (event.key === "Enter") {
    const before = value.slice(0, start);
    const lineStart = before.lastIndexOf("\n") + 1;
    const line = value.slice(lineStart, start);
    const indentMatch = line.match(/^[ \t]*/);
    const baseIndent = indentMatch ? indentMatch[0] : "";
    const trimmed = line.trimEnd();
    const shouldIndent = trimmed.endsWith(":") || baseIndent.length > 0;
    if (shouldIndent) {
      event.preventDefault();
      const extraIndent = trimmed.endsWith(":") ? spaces : "";
      const insert = `\n${baseIndent}${extraIndent}`;
      els.editor.value = value.slice(0, start) + insert + value.slice(end);
      els.editor.selectionStart = els.editor.selectionEnd = start + insert.length;
      onEditorInput();
    }
  }
}

function syncEditorScroll() {
  if (!els.editorHighlight || !els.lineNumbers) {
    return;
  }
  els.editorHighlight.scrollTop = els.editor.scrollTop;
  els.editorHighlight.scrollLeft = els.editor.scrollLeft;
  els.lineNumbers.scrollTop = els.editor.scrollTop;
}

function refreshEditorDecorations() {
  if (!els.editorHighlight || !els.lineNumbers) {
    return;
  }
  const code = els.editor.value || "";
  els.editorHighlight.innerHTML = highlightPython(code);
  const lineCount = Math.max(1, code.split("\n").length);
  const lines = new Array(lineCount);
  for (let i = 0; i < lineCount; i += 1) {
    lines[i] = String(i + 1);
  }
  els.lineNumbers.textContent = lines.join("\n");
  syncEditorScroll();
}

function highlightPython(code) {
  const keywordList = [
    "and", "as", "assert", "break", "class", "continue", "def", "del", "elif", "else",
    "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
    "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
    "True", "False", "None"
  ];
  const builtinList = [
    "print", "input", "range", "len", "int", "float", "str", "list", "dict", "set",
    "tuple", "open", "min", "max", "sum", "abs", "enumerate", "zip", "map", "filter"
  ];
  const keywordSet = new Set(keywordList);
  const builtinSet = new Set(builtinList);
  const keywordPattern = `(?:${keywordList.join("|")})`;
  const builtinPattern = `(?:${builtinList.join("|")})`;
  const tokenRegex = new RegExp(`\\b${keywordPattern}\\b|\\b${builtinPattern}\\b|\\b\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b`, "g");
  const numberRegex = /^\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?$/i;

  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next3 = code.slice(i, i + 3);
    if (next3 === "'''" || next3 === '"""') {
      const end = code.indexOf(next3, i + 3);
      const endIndex = end === -1 ? code.length : end + 3;
      const chunk = code.slice(i, endIndex);
      out += wrapToken(escapeHtml(chunk), "string");
      i = endIndex;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < code.length) {
        const cj = code[j];
        if (escaped) {
          escaped = false;
          j += 1;
          continue;
        }
        if (cj === "\\") {
          escaped = true;
          j += 1;
          continue;
        }
        if (cj === ch || cj === "\n") {
          if (cj === ch) {
            j += 1;
          }
          break;
        }
        j += 1;
      }
      const chunk = code.slice(i, j);
      out += wrapToken(escapeHtml(chunk), "string");
      i = j;
      continue;
    }
    if (ch === "#") {
      let j = i;
      while (j < code.length && code[j] !== "\n") {
        j += 1;
      }
      const chunk = code.slice(i, j);
      out += wrapToken(escapeHtml(chunk), "comment");
      i = j;
      continue;
    }
    let j = i;
    while (j < code.length) {
      const cj = code[j];
      if (cj === "#" || cj === "'" || cj === '"') {
        break;
      }
      j += 1;
    }
    const chunk = code.slice(i, j);
    out += highlightPlain(chunk, tokenRegex, numberRegex, keywordSet, builtinSet);
    i = j;
  }
  return out;
}

function highlightPlain(text, tokenRegex, numberRegex, keywordSet, builtinSet) {
  if (!text) {
    return "";
  }
  let out = "";
  let lastIndex = 0;
  for (const match of text.matchAll(tokenRegex)) {
    const index = match.index ?? 0;
    const value = match[0];
    out += escapeHtml(text.slice(lastIndex, index));
    let type = "number";
    if (numberRegex.test(value)) {
      type = "number";
    } else if (builtinSet.has(value)) {
      type = "builtin";
    } else if (keywordSet.has(value)) {
      type = "keyword";
    }
    out += wrapToken(escapeHtml(value), type);
    lastIndex = index + value.length;
  }
  out += escapeHtml(text.slice(lastIndex));
  return out;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wrapToken(value, type) {
  return `<span class="token ${type}">${value}</span>`;
}
async function createFile() {
  if (state.embed.readonly) {
    showToast("Режим только чтение.");
    return;
  }
  const name = await promptModal({
    title: "Создать модуль",
    placeholder: "main.py",
    confirmText: "Создать"
  });
  if (!name) {
    return;
  }
  const trimmed = name.trim();
  const normalized = normalizePythonFileName(trimmed);
  if (!normalized) {
    showToast("Можно создавать только модули .py.");
    return;
  }
  if (!validateFileName(normalized)) {
    showToast("Некорректное имя модуля.");
    return;
  }
  if (getFileByName(normalized)) {
    showToast("Модуль уже существует.");
    return;
  }
  if (getCurrentFiles().length >= CONFIG.MAX_FILES) {
    showToast("Достигнут лимит модулей.");
    return;
  }

  if (state.mode === "project") {
    state.project.files.push({ name: normalized, content: "" });
    state.project.lastActiveFile = normalized;
    scheduleSave();
  } else if (state.mode === "snapshot") {
    const { draft } = state.snapshot;
    draft.overlayFiles[normalized] = "";
    draft.deletedFiles = draft.deletedFiles.filter((item) => item !== normalized);
    draft.draftLastActiveFile = normalized;
    scheduleDraftSave();
  }

  setActiveFile(normalized);
  renderFiles(getCurrentFiles());
  updateTabs();
}

async function renameFile() {
  if (state.embed.readonly) {
    showToast("Режим только чтение.");
    return;
  }
  if (!state.activeFile) {
    return;
  }
  if (state.activeFile === MAIN_FILE) {
    showToast("main.py нельзя переименовать.");
    return;
  }
  const nextName = await promptModal({
    title: "Переименовать модуль",
    value: state.activeFile,
    confirmText: "Переименовать"
  });
  if (!nextName) {
    return;
  }
  const trimmed = nextName.trim();
  const normalized = normalizePythonFileName(trimmed);
  if (!normalized) {
    showToast("Можно создавать только модули .py.");
    return;
  }
  if (normalized === state.activeFile) {
    return;
  }
  if (!validateFileName(normalized)) {
    showToast("Некорректное имя модуля.");
    return;
  }
  if (getFileByName(normalized)) {
    showToast("Модуль уже существует.");
    return;
  }

  if (state.mode === "project") {
    const file = getFileByName(state.activeFile);
    file.name = normalized;
    state.project.lastActiveFile = normalized;
    scheduleSave();
  } else if (state.mode === "snapshot") {
    renameSnapshotFile(state.activeFile, normalized);
  }

  setActiveFile(normalized);
  renderFiles(getCurrentFiles());
  updateTabs();
}

function renameSnapshotFile(oldName, newName) {
  const { baseline, draft } = state.snapshot;
  const baseFile = baseline.files.find((file) => file.name === oldName);
  const overlayContent = draft.overlayFiles[oldName];

  if (baseFile) {
    draft.deletedFiles = draft.deletedFiles.filter((name) => name !== newName);
    draft.deletedFiles.push(oldName);
    const content = overlayContent ?? baseFile.content;
    draft.overlayFiles[newName] = content;
    delete draft.overlayFiles[oldName];
  } else {
    draft.overlayFiles[newName] = overlayContent ?? "";
    delete draft.overlayFiles[oldName];
  }
  draft.deletedFiles = draft.deletedFiles.filter((name) => name !== newName);
  draft.draftLastActiveFile = newName;
  scheduleDraftSave();
}

async function deleteFile() {
  if (state.embed.readonly) {
    showToast("Режим только чтение.");
    return;
  }
  const name = state.activeFile;
  if (!name) {
    return;
  }
  if (name === MAIN_FILE) {
    showToast("main.py нельзя удалить.");
    return;
  }
  const ok = await confirmModal({
    title: "Удалить модуль",
    message: `Удалить модуль ${name}?`,
    confirmText: "Удалить"
  });
  if (!ok) {
    return;
  }

  if (state.mode === "project") {
    state.project.files = state.project.files.filter((file) => file.name !== name);
    if (!state.project.files.length) {
      state.project.files.push({ name: MAIN_FILE, content: "" });
    }
    state.project.lastActiveFile = state.project.files[0].name;
    scheduleSave();
  } else if (state.mode === "snapshot") {
    const { baseline, draft } = state.snapshot;
    const baseFile = baseline.files.find((file) => file.name === name);
    if (baseFile) {
      if (!draft.deletedFiles.includes(name)) {
        draft.deletedFiles.push(name);
      }
    }
    delete draft.overlayFiles[name];
    draft.draftLastActiveFile = null;
    scheduleDraftSave();
  }

  setActiveFile(getCurrentFiles()[0]?.name || null);
  renderFiles(getCurrentFiles());
  updateTabs();
  updateEditorContent();
}

async function duplicateFile() {
  if (state.embed.readonly) {
    showToast("Режим только чтение.");
    return;
  }
  const file = getFileByName(state.activeFile);
  if (!file) {
    return;
  }
  const baseName = file.name.replace(/\.py$/, "");
  let index = 1;
  let newName = `${baseName}_copy.py`;
  while (getFileByName(newName)) {
    index += 1;
    newName = `${baseName}_copy${index}.py`;
  }

  if (state.mode === "project") {
    state.project.files.push({ name: newName, content: file.content });
    scheduleSave();
  } else if (state.mode === "snapshot") {
    state.snapshot.draft.overlayFiles[newName] = file.content;
    scheduleDraftSave();
  }

  setActiveFile(newName);
  renderFiles(getCurrentFiles());
  updateTabs();
}

function validateFileName(name) {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return false;
  }
  return VALID_FILENAME.test(name);
}

function normalizePythonFileName(name) {
  if (!name) {
    return null;
  }
  const trimmed = String(name).trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.includes(".")) {
    return `${trimmed}.py`;
  }
  if (!trimmed.toLowerCase().endsWith(".py")) {
    return null;
  }
  return trimmed;
}

function getCurrentFiles() {
  if (state.mode === "project") {
    return state.project.files;
  }
  if (state.mode === "snapshot") {
    return getEffectiveFiles();
  }
  return [];
}

function getFileByName(name) {
  const files = getCurrentFiles();
  return files.find((file) => file.name === name);
}

function getEffectiveFiles() {
  const { baseline, draft } = state.snapshot;
  const map = new Map();
  baseline.files.forEach((file) => map.set(file.name, { ...file }));
  draft.deletedFiles.forEach((name) => map.delete(name));
  Object.entries(draft.overlayFiles).forEach(([name, content]) => {
    map.set(name, { name, content });
  });
  const list = Array.from(map.values());
  ensureMainFileRecord(list);
  return list;
}

function updateDraftFile(name, content) {
  const { baseline, draft } = state.snapshot;
  const baseFile = baseline.files.find((file) => file.name === name);
  const baselineContent = baseFile ? baseFile.content : null;

  if (baselineContent !== null && content === baselineContent) {
    delete draft.overlayFiles[name];
  } else {
    draft.overlayFiles[name] = content;
  }

  draft.deletedFiles = draft.deletedFiles.filter((item) => item !== name);
  draft.draftLastActiveFile = name;
  scheduleDraftSave();
}

async function onAssetUpload(event) {
  if (state.mode !== "project") {
    showToast("Ресурсы доступны только в проектах.");
    return;
  }
  const files = Array.from(event.target.files || []);
  if (!files.length) {
    return;
  }
  for (const file of files) {
    await addAsset(file);
  }
  event.target.value = "";
}

async function addAsset(file) {
  const name = file.name;
  if (!validateFileName(name)) {
    showToast(`Некорректное имя ресурса: ${name}`);
    return;
  }
  if (state.project.assets.find((asset) => asset.name === name)) {
    showToast(`Ресурс уже существует: ${name}`);
    return;
  }
  const blobId = createUuid();
  await dbPut("blobs", { blobId, data: file });
  state.project.assets.push({ name, mime: file.type || "application/octet-stream", blobId });
  scheduleSave();
  renderAssets(state.project.assets);
}

async function removeAsset(name) {
  if (state.mode !== "project") {
    return;
  }
  const asset = state.project.assets.find((item) => item.name === name);
  if (!asset) {
    return;
  }
  await dbDelete("blobs", asset.blobId);
  state.project.assets = state.project.assets.filter((item) => item.name !== name);
  scheduleSave();
  renderAssets(state.project.assets);
}
function toggleTabSize() {
  state.settings.tabSize = state.settings.tabSize === 4 ? 2 : 4;
  saveSettings();
  applyEditorSettings();
}

function toggleWrap() {
  state.settings.wordWrap = !state.settings.wordWrap;
  saveSettings();
  applyEditorSettings();
}

function getTurtleSpeedPreset() {
  const current = state.settings.turtleSpeed;
  return TURTLE_SPEED_PRESETS.find((preset) => preset.key === current) || TURTLE_SPEED_PRESETS[0];
}

function getTurtleSpeedIndex() {
  const currentIndex = TURTLE_SPEED_PRESETS.findIndex((preset) => preset.key === state.settings.turtleSpeed);
  return currentIndex >= 0 ? currentIndex : 0;
}

function setTurtleSpeedByIndex(index) {
  const maxIndex = TURTLE_SPEED_PRESETS.length - 1;
  const clamped = Math.max(0, Math.min(maxIndex, index));
  state.settings.turtleSpeed = TURTLE_SPEED_PRESETS[clamped].key;
  saveSettings();
  applyEditorSettings();
}

function onTurtleSpeedInput() {
  if (!els.turtleSpeedRange) {
    return;
  }
  setTurtleSpeedByIndex(Number(els.turtleSpeedRange.value));
}

function applyEditorSettings() {
  els.editor.style.tabSize = state.settings.tabSize;
  els.editor.wrap = state.settings.wordWrap ? "soft" : "off";
  els.tabSizeBtn.textContent = `Таб: ${state.settings.tabSize}`;
  els.wrapBtn.textContent = `Перенос: ${state.settings.wordWrap ? "Вкл" : "Выкл"}`;
  if (els.turtleSpeedLabel) {
    els.turtleSpeedLabel.textContent = getTurtleSpeedPreset().label;
  }
  if (els.turtleSpeedRange) {
    els.turtleSpeedRange.value = String(getTurtleSpeedIndex());
  }
  if (els.editorHighlight) {
    els.editorHighlight.style.tabSize = state.settings.tabSize;
    els.editorHighlight.style.whiteSpace = state.settings.wordWrap ? "pre-wrap" : "pre";
  }
  refreshEditorDecorations();
}

function loadSettings() {
  const raw = safeLocalGet("shp-settings");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      state.settings = { ...state.settings, ...parsed };
    } catch (error) {
      console.warn("Failed to parse settings", error);
    }
  }
  if (!TURTLE_SPEED_PRESETS.some((preset) => preset.key === state.settings.turtleSpeed)) {
    state.settings.turtleSpeed = "ultra";
  }
  applyEditorSettings();
}

function saveSettings() {
  safeLocalSet("shp-settings", JSON.stringify(state.settings));
}

function updateSaveIndicator(text) {
  els.saveIndicator.textContent = text;
}

function scheduleSave() {
  if (state.mode !== "project" || state.embed.active) {
    return;
  }
  updateSaveIndicator("Сохранение...");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    await saveProject(state.project);
    updateSaveIndicator("Сохранено");
  }, 400);
}

function scheduleDraftSave() {
  if (state.mode !== "snapshot") {
    return;
  }
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(async () => {
    const draft = state.snapshot.draft;
    draft.updatedAt = Date.now();
    await dbPut("drafts", draft);
  }, 400);
}

async function saveProject(project) {
  project.updatedAt = Date.now();
  await dbPut("projects", project);
}

async function rememberRecent(projectId) {
  const list = await getRecent();
  const next = [projectId, ...list.filter((id) => id !== projectId)].slice(0, 12);
  await dbPut("recent", { key: "recent", list: next });
}

async function renderRecent() {
  const recent = await getRecent();
  els.recentList.innerHTML = "";
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "recent-card";
    empty.innerHTML = "<h3>Пока нет проектов</h3><small>Создайте новый проект, чтобы начать работу.</small>";
    els.recentList.appendChild(empty);
    return;
  }

  for (const id of recent) {
    const project = await dbGet("projects", id);
    if (!project) {
      continue;
    }
    const card = document.createElement("div");
    card.className = "recent-card";
    const title = document.createElement("h3");
    title.textContent = project.title || "Без названия";
    const meta = document.createElement("small");
    meta.textContent = `Обновлено ${new Date(project.updatedAt).toLocaleString()}`;
    const open = document.createElement("button");
    open.className = "btn small recent-open";
    open.textContent = "Открыть";
    open.addEventListener("click", () => {
      location.hash = `#/p/${project.projectId}`;
    });
    const remove = document.createElement("button");
    remove.className = "btn small square danger";
    remove.textContent = "🗑";
    remove.title = "Удалить";
    remove.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: "Удалить проект?",
        message: "Проект будет перемещен в корзину.",
        confirmText: "Удалить"
      });
      if (!ok) {
        return;
      }
      const trash = await getTrash();
      const merged = mergeUniqueIds([project.projectId], trash);
      await dbPut("trash", { key: "trash", list: merged });
      const nextRecent = recent.filter((item) => item !== project.projectId);
      await dbPut("recent", { key: "recent", list: nextRecent });
      await renderRecent();
    });
    const actions = document.createElement("div");
    actions.className = "recent-actions-row";
    actions.append(open, remove);
    card.append(title, meta, actions);
    els.recentList.appendChild(card);
  }
}

async function clearRecentProjects() {
  const recent = await getRecent();
  if (!recent.length) {
    return;
  }
  const ok = await confirmModal({
    title: "Очистить список?",
    message: "Проекты будут перемещены в корзину.",
    confirmText: "Очистить"
  });
  if (!ok) {
    return;
  }
  const trash = await getTrash();
  const merged = mergeUniqueIds(recent, trash);
  await dbPut("trash", { key: "trash", list: merged });
  await dbPut("recent", { key: "recent", list: [] });
  await renderRecent();
}

async function getRecent() {
  const record = await dbGet("recent", "recent");
  return record?.list || [];
}

async function getTrash() {
  const record = await dbGet("trash", "trash");
  return record?.list || [];
}

async function setTrash(list) {
  await dbPut("trash", { key: "trash", list });
}

async function restoreFromTrash(projectId) {
  const project = await dbGet("projects", projectId);
  const recent = await getRecent();
  if (project) {
    const nextRecent = [projectId, ...recent.filter((id) => id !== projectId)].slice(0, 12);
    await dbPut("recent", { key: "recent", list: nextRecent });
  }
  const trash = await getTrash();
  await setTrash(trash.filter((id) => id !== projectId));
  await renderRecent();
}

async function deleteFromTrash(projectId) {
  await dbDelete("projects", projectId);
  const trash = await getTrash();
  await setTrash(trash.filter((id) => id !== projectId));
  const recent = await getRecent();
  if (recent.includes(projectId)) {
    await dbPut("recent", { key: "recent", list: recent.filter((id) => id !== projectId) });
    await renderRecent();
  }
}

async function emptyTrash() {
  const trash = await getTrash();
  if (!trash.length) {
    return;
  }
  for (const id of trash) {
    await dbDelete("projects", id);
  }
  await setTrash([]);
  const recent = await getRecent();
  if (recent.length) {
    const nextRecent = recent.filter((id) => !trash.includes(id));
    await dbPut("recent", { key: "recent", list: nextRecent });
  }
  await renderRecent();
}

async function openTrashModal() {
  const trash = await getTrash();
  if (!trash.length) {
    const html = `
      <div class="modal-card">
        <h3>Корзина</h3>
        <p>Корзина пуста.</p>
        <div class="modal-actions">
          <button class="btn ghost" data-action="close">Закрыть</button>
        </div>
      </div>
    `;
    openModal(html, (action) => {
      if (action === "close") {
        closeModal();
      }
    });
    return;
  }

  const items = [];
  for (const id of trash) {
    const project = await dbGet("projects", id);
    const title = project?.title || "Без названия";
    const updated = project?.updatedAt
      ? `Обновлено ${new Date(project.updatedAt).toLocaleString()}`
      : "Проект не найден";
    items.push(`
      <div class="trash-item">
        <div class="trash-meta">
          <div class="trash-title">${escapeHtml(title)}</div>
          <div class="trash-sub">${escapeHtml(updated)}</div>
        </div>
        <div class="trash-actions">
          <button class="btn small" data-action="restore:${id}">Восстановить</button>
          <button class="btn small danger" data-action="delete:${id}">Удалить</button>
        </div>
      </div>
    `);
  }

  const html = `
    <div class="modal-card">
      <h3>Корзина</h3>
      <div class="trash-list">${items.join("")}</div>
      <div class="modal-actions">
        <button class="btn ghost" data-action="close">Закрыть</button>
        <button class="btn danger" data-action="empty">Очистить корзину</button>
      </div>
    </div>
  `;

  openModal(html, async (action) => {
    if (action === "close") {
      closeModal();
      return;
    }
    if (action === "empty") {
      const ok = await confirmModal({
        title: "Очистить корзину?",
        message: "Проекты будут удалены навсегда.",
        confirmText: "Удалить"
      });
      if (ok) {
        await emptyTrash();
        closeModal();
      }
      return;
    }
    if (action && action.startsWith("restore:")) {
      const projectId = action.slice("restore:".length);
      await restoreFromTrash(projectId);
      closeModal();
      openTrashModal();
      return;
    }
    if (action && action.startsWith("delete:")) {
      const projectId = action.slice("delete:".length);
      const ok = await confirmModal({
        title: "Удалить проект?",
        message: "Проект будет удален навсегда.",
        confirmText: "Удалить"
      });
      if (ok) {
        await deleteFromTrash(projectId);
        closeModal();
        openTrashModal();
      }
    }
  });
}

async function shareProject() {
  if (state.mode !== "project") {
    return;
  }
  const files = state.project.files;
  const assets = state.project.assets || [];
  if (assets.length) {
    showToast("Шеринг недоступен при наличии ресурсов. Используйте экспорт.");
    return;
  }
  if (!validateShareLimits(files)) {
    return;
  }

  const payloadData = {
    title: state.project.title,
    files: files.map((file) => ({ name: file.name, content: file.content })),
    lastActiveFile: state.project.lastActiveFile || files[0]?.name || null
  };
  const payloadJson = JSON.stringify(payloadData);
  const payloadBytes = encoder.encode(payloadJson);

  const { payload, shareId } = await buildPayload(payloadBytes);
  const url = `${location.origin}${location.pathname}#/s/${shareId}?p=${payload}`;
  const modalBody = `
    <div class="modal-card">
      <h3>Ссылка на снимок</h3>
      <p>Неизменяемая ссылка на текущий снимок проекта.</p>
      <input class="modal-input" value="${url}" readonly />
      <div class="modal-actions">
        <button class="btn ghost" data-action="close">Закрыть</button>
        <button class="btn primary" data-action="copy">Скопировать</button>
      </div>
    </div>
  `;
  openModal(modalBody, (action) => {
    if (action === "copy") {
      copyToClipboard(url);
    }
    closeModal();
  });
}

function validateShareLimits(files) {
  if (files.length > CONFIG.MAX_FILES) {
    showToast("Шеринг недоступен: слишком много модулей.");
    return false;
  }
  let totalBytes = 0;
  for (const file of files) {
    const bytes = encoder.encode(file.content || "").length;
    if (bytes > CONFIG.MAX_SINGLE_FILE_BYTES) {
      showToast(`Шеринг недоступен: модуль ${file.name} слишком большой.`);
      return false;
    }
    totalBytes += bytes;
    if (totalBytes > CONFIG.MAX_TOTAL_TEXT_BYTES) {
      showToast("Шеринг недоступен: проект слишком большой.");
      return false;
    }
  }
  return true;
}

async function buildPayload(payloadBytes) {
  let prefix = "u";
  let bodyBytes = payloadBytes;
  try {
    const compressed = await compressBytes(payloadBytes);
    if (compressed && compressed.length < payloadBytes.length) {
      prefix = "g";
      bodyBytes = compressed;
    }
  } catch (error) {
    console.warn("Compression failed", error);
  }
  const payload = `${prefix}.${base64UrlEncode(bodyBytes)}`;
  const shareId = await computeShareId(bodyBytes);
  return { payload, shareId };
}

async function decodePayload(payload) {
  const [prefix, data] = payload.split(".");
  const bytes = base64UrlDecode(data || payload);
  if (prefix === "g") {
    try {
      const decompressed = await decompressBytes(bytes);
      return JSON.parse(decoder.decode(decompressed));
    } catch (error) {
      console.warn("Decompression failed", error);
    }
  }
  return JSON.parse(decoder.decode(bytes));
}

async function compressBytes(bytes) {
  if ("CompressionStream" in window && typeof Blob !== "undefined" && Blob.prototype && Blob.prototype.stream) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    const response = new Response(stream);
    return new Uint8Array(await response.arrayBuffer());
  }
  return gzipSync(bytes);
}

async function decompressBytes(bytes) {
  if ("DecompressionStream" in window && typeof Blob !== "undefined" && Blob.prototype && Blob.prototype.stream) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const response = new Response(stream);
    return new Uint8Array(await response.arrayBuffer());
  }
  return gunzipSync(bytes);
}

async function computeShareId(bytes) {
  if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
    try {
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      return base64UrlEncode(new Uint8Array(hash)).slice(0, 12);
    } catch (error) {
      // Fall back to non-crypto hash.
    }
  }
  const h1 = hashBytesFNV1a(bytes, 0x811c9dc5);
  const h2 = hashBytesFNV1a(bytes, 0x811c9dc5 ^ 0xdeadbeef);
  const hex = h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  return hex.slice(0, 12);
}

function hashBytesFNV1a(bytes, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash >>> 0;
}

function base64UrlEncode(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(text) {
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function readBlobData(blob) {
  if (!blob) {
    return new Uint8Array();
  }
  if (blob instanceof Uint8Array) {
    return blob;
  }
  if (ArrayBuffer.isView(blob)) {
    return new Uint8Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  }
  if (blob instanceof ArrayBuffer) {
    return new Uint8Array(blob);
  }
  if (blob.arrayBuffer) {
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result || []));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function remixSnapshot() {
  if (state.mode !== "snapshot") {
    return;
  }
  const files = getEffectiveFiles();
  const project = {
    projectId: createUuid(),
    title: state.snapshot.baseline.title || "Ремикс",
    files,
    assets: [],
    lastActiveFile: state.activeFile || files[0]?.name || null,
    updatedAt: Date.now()
  };
  await saveProject(project);
  location.hash = `#/p/${project.projectId}`;
}

async function resetSnapshot() {
  if (state.mode !== "snapshot") {
    return;
  }
  const ok = await confirmModal({
    title: "Сбросить снимок",
    message: "Удалить локальные правки и вернуть общий снимок?",
    confirmText: "Сбросить"
  });
  if (!ok) {
    return;
  }
  const draftKey = state.snapshot.draft.key;
  await dbDelete("drafts", draftKey);
  state.snapshot.draft = {
    key: draftKey,
    overlayFiles: {},
    deletedFiles: [],
    draftLastActiveFile: null,
    updatedAt: Date.now()
  };
  state.activeFile = state.snapshot.baseline.lastActiveFile || state.snapshot.baseline.files[0]?.name || null;
  renderSnapshot();
}
async function exportProject() {
  if (state.mode !== "project") {
    return;
  }
  const modalBody = `
    <div class="modal-card">
      <h3>Экспорт проекта</h3>
      <p>Выберите формат экспорта.</p>
      <div class="modal-actions">
        <button class="btn ghost" data-action="close">Отмена</button>
        <button class="btn" data-action="json">JSON</button>
        <button class="btn primary" data-action="zip">ZIP</button>
      </div>
    </div>
  `;
  openModal(modalBody, async (action) => {
    if (action === "json") {
      await exportAsJson();
    }
    if (action === "zip") {
      await exportAsZip();
    }
    closeModal();
  });
}

async function importFiles(files) {
  if (state.mode !== "project" || state.embed.readonly) {
    return;
  }
  const imports = [];
  let skipped = 0;
  for (const file of files) {
    const name = String(file.name || "");
    const lower = name.toLowerCase();
    if (lower.endsWith(".py")) {
      const content = await file.text();
      imports.push({ name, content });
      continue;
    }
    if (lower.endsWith(".zip")) {
      const buffer = await file.arrayBuffer();
      const items = extractPyFromZip(new Uint8Array(buffer));
      imports.push(...items);
      continue;
    }
    if (lower.endsWith(".json")) {
      const text = await file.text();
      const items = extractPyFromJson(text);
      if (!items) {
        showToast("Некорректный JSON для импорта.");
        return;
      }
      imports.push(...items);
      continue;
    }
    skipped += 1;
  }
  if (!imports.length) {
    showToast("Не найдено .py файлов для импорта.");
    return;
  }
  if (skipped) {
    showToast("Некоторые файлы пропущены (поддерживаются .py, .zip, .json).");
  }
  await applyImportedFiles(imports);
}

function extractPyFromZip(bytes) {
  const out = [];
  let entries = {};
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    console.warn("Zip import failed", error);
    showToast("Не удалось прочитать ZIP архив.");
    return out;
  }
  for (const [entryName, data] of Object.entries(entries)) {
    if (!entryName || entryName.endsWith("/")) {
      continue;
    }
    if (!entryName.toLowerCase().endsWith(".py")) {
      continue;
    }
    const base = getBaseName(entryName);
    const content = decoder.decode(data);
    out.push({ name: base, content });
  }
  return out;
}

function extractPyFromJson(text) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return null;
  }
  if (!payload || payload.version !== 1 || !payload.project || !Array.isArray(payload.project.files)) {
    return null;
  }
  const out = [];
  let skippedAssets = false;
  if (Array.isArray(payload.project.assets) && payload.project.assets.length) {
    skippedAssets = true;
  }
  for (const file of payload.project.files) {
    if (!file || !file.name) {
      continue;
    }
    const name = String(file.name);
    if (!name.toLowerCase().endsWith(".py")) {
      continue;
    }
    out.push({ name, content: String(file.content || "") });
  }
  if (skippedAssets) {
    showToast("Ресурсы из JSON сейчас не импортируются.");
  }
  return out;
}

function isNameTaken(name, added) {
  return Boolean(getFileByName(name) || added.has(name));
}

async function applyImportedFiles(imports) {
  const added = new Set();
  let changed = false;
  let applyAllAction = null;
  for (const item of imports) {
    const normalized = normalizePythonFileName(item.name);
    if (!normalized || !validateFileName(normalized)) {
      showToast(`Некорректное имя файла: ${item.name}`);
      continue;
    }
    if (isNameTaken(normalized, added)) {
      const decision = await resolveImportConflict(normalized, applyAllAction, added);
      if (decision.action === "cancelAll") {
        return;
      }
      if (decision.applyAll && decision.action !== "none") {
        applyAllAction = decision.action;
      }
      if (decision.action === "skip") {
        continue;
      }
      if (decision.action === "replace") {
        const target = getFileByName(normalized);
        if (target) {
          target.content = item.content || "";
          changed = true;
        }
        continue;
      }
      if (decision.action === "rename") {
        const finalName = decision.newName;
        if (!finalName) {
          continue;
        }
        state.project.files.push({ name: finalName, content: item.content || "" });
        added.add(finalName);
        changed = true;
        continue;
      }
    } else {
      state.project.files.push({ name: normalized, content: item.content || "" });
      added.add(normalized);
      changed = true;
    }
  }
  if (changed) {
    renderProject();
    scheduleSave();
  }
}

async function resolveImportConflict(name, applyAllAction, added) {
  if (applyAllAction === "replace") {
    return { action: "replace", applyAll: false };
  }
  if (applyAllAction === "rename") {
    const autoName = createNumberedImportName(name, (candidate) => isNameTaken(candidate, added));
    return { action: "rename", applyAll: false, newName: autoName };
  }
  if (applyAllAction === "cancel") {
    return { action: "cancelAll", applyAll: false };
  }
  return new Promise((resolve) => {
    const autoName = createNumberedImportName(name, (candidate) => isNameTaken(candidate, added));
    const html = `
      <div class="modal-card modal-card-fit">
        <h3>Файл уже существует</h3>
        <p>Модуль <span class="modal-file-name">${escapeHtml(name)}</span> уже есть. Что сделать?</p>
        <label class="modal-check">
          <input type="checkbox" id="import-apply-all" />
          Применить ко всем конфликтам
        </label>
        <input class="modal-input" id="import-new-name" value="${escapeHtml(autoName)}" />
        <div class="modal-actions">
          <button class="btn ghost" data-action="cancel">Отмена</button>
          <button class="btn" data-action="replace">Заменить</button>
          <button class="btn primary" data-action="rename">Импортировать с новым именем</button>
        </div>
      </div>
    `;
    openModal(html, (action) => {
      const applyAll = Boolean(els.modal.querySelector("#import-apply-all")?.checked);
      if (action === "replace") {
        closeModal();
        resolve({ action: "replace", applyAll });
        return;
      }
      if (action === "rename") {
        const input = els.modal.querySelector("#import-new-name");
        const value = input ? input.value : "";
        const normalized = normalizePythonFileName(value);
        if (!normalized || !validateFileName(normalized) || isNameTaken(normalized, added)) {
          showToast("Некорректное или занятое имя файла.");
          return;
        }
        closeModal();
        resolve({ action: "rename", applyAll, newName: normalized });
        return;
      }
      closeModal();
      resolve({ action: applyAll ? "cancelAll" : "skip", applyAll });
    });
    const input = els.modal.querySelector("#import-new-name");
    if (input) {
      input.focus();
      input.select();
    }
  });
}

async function exportAsJson() {
  const assets = [];
  for (const asset of state.project.assets) {
    const blobRecord = await dbGet("blobs", asset.blobId);
    if (!blobRecord) {
      continue;
    }
    const buffer = await readBlobData(blobRecord.data);
    const base64 = base64UrlEncode(buffer);
    assets.push({
      name: asset.name,
      mime: asset.mime,
      dataBase64: base64
    });
  }
  const payload = {
    version: 1,
    project: {
      title: state.project.title,
      files: state.project.files,
      assets
    }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${state.project.title || "proekt"}.json`);
}

async function exportAsZip() {
  const entries = [];
  state.project.files.forEach((file) => {
    entries.push({ name: file.name, data: encoder.encode(file.content || "") });
  });
  for (const asset of state.project.assets) {
    const blobRecord = await dbGet("blobs", asset.blobId);
    if (!blobRecord) {
      continue;
    }
    const buffer = await readBlobData(blobRecord.data);
    entries.push({ name: asset.name, data: buffer });
  }

  const zipBytes = createZip(entries);
  const blob = new Blob([zipBytes], { type: "application/zip" });
  downloadBlob(blob, `${state.project.title || "proekt"}.zip`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createZip(entries) {
  const fileHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    fileHeaders.push(localHeader, data);
    centralHeaders.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralHeaders.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return concatArrays([...fileHeaders, ...centralHeaders, endRecord]);
}

function concatArrays(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}

function crc32(data) {
  let crc = 0 ^ -1;
  for (let i = 0; i < data.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();
function clearConsole() {
  els.consoleOutput.textContent = "";
  state.outputBytes = 0;
}

function appendConsole(text, isError) {
  if (state.outputBytes >= CONFIG.MAX_OUTPUT_BYTES) {
    return;
  }
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!normalized) {
    return;
  }
  const chunkBytes = encoder.encode(normalized).length;
  state.outputBytes += chunkBytes;
  if (state.outputBytes > CONFIG.MAX_OUTPUT_BYTES) {
    els.consoleOutput.appendChild(document.createTextNode("\n[вывод обрезан]\n"));
    return;
  }
  if (isError) {
    const span = document.createElement("span");
    span.className = "console-error";
    appendConsoleText(span, normalized);
    els.consoleOutput.appendChild(span);
  } else {
    appendConsoleText(els.consoleOutput, normalized);
  }
  els.consoleOutput.scrollTop = els.consoleOutput.scrollHeight;
}

function appendConsoleText(target, text) {
  const parts = String(text).split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i]) {
      target.appendChild(document.createTextNode(parts[i]));
    }
    if (i < parts.length - 1) {
      target.appendChild(document.createElement("br"));
    }
  }
}

function updateRunStatus(status) {
  const key = String(status || "").toLowerCase();
  els.runStatus.textContent = RUN_STATUS_LABELS[key] || status;
  state.runStatus = key || status;
}

function isRuntimeErrorText(text) {
  const message = String(text || "");
  return message.includes("Traceback") || /\b(Error|Exception)\b/.test(message);
}

function enableConsoleInput(enable) {
  els.consoleInput.disabled = !enable;
  els.consoleSend.disabled = !enable;
}

function submitConsoleInput() {
  const value = els.consoleInput.value;
  if (!value) {
    return;
  }
  els.consoleInput.value = "";
  appendConsole(`${value}\n`, false);
  if (state.worker && state.workerReady) {
    if (canUseSharedStdin()) {
      writeSharedStdin(value);
    }
    state.worker.postMessage({ type: "stdin_response", value });
    state.stdinWaiting = false;
    return;
  }
  state.stdinQueue.push(value);
  if (state.stdinWaiting) {
    deliverInput();
  }
}

function deliverInput() {
  if (!state.stdinQueue.length) {
    return;
  }
  if (!state.worker) {
    state.stdinQueue = [];
    state.stdinWaiting = false;
    return;
  }
  const value = state.stdinQueue.shift();
  const usedShared = canUseSharedStdin() && writeSharedStdin(value);
  if (usedShared && state.stdinMode === "shared") {
    state.stdinWaiting = false;
    return;
  }
  state.worker.postMessage({ type: "stdin_response", value });
  state.stdinWaiting = false;
}

function resetSharedStdin() {
  state.stdinShared = null;
  state.stdinHeader = null;
  state.stdinBuffer = null;
  state.stdinMode = "message";
}

function setupSharedStdin() {
  resetSharedStdin();
  if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object" || typeof Atomics.notify !== "function") {
    return null;
  }
  try {
    const shared = new SharedArrayBuffer(STDIN_SHARED_BYTES + 8);
    state.stdinShared = shared;
    state.stdinHeader = new Int32Array(shared, 0, 2);
    state.stdinBuffer = new Uint8Array(shared, 8);
    return shared;
  } catch (error) {
    resetSharedStdin();
    return null;
  }
}

function canUseSharedStdin() {
  return state.stdinHeader && state.stdinBuffer && typeof Atomics === "object" && typeof Atomics.notify === "function";
}

function writeSharedStdin(value) {
  if (!state.stdinHeader || !state.stdinBuffer || typeof Atomics !== "object" || typeof Atomics.notify !== "function") {
    return false;
  }
  const bytes = encoder.encode(String(value ?? ""));
  const maxLength = state.stdinBuffer.length;
  const length = Math.min(bytes.length, maxLength);
  if (length > 0) {
    state.stdinBuffer.set(bytes.subarray(0, length), 0);
  }
  Atomics.store(state.stdinHeader, 1, length);
  Atomics.store(state.stdinHeader, 0, 1);
  Atomics.notify(state.stdinHeader, 0, 1);
  return true;
}

function initWorker() {
  spawnWorker();
}

function spawnWorker() {
  if (state.worker) {
    state.worker.terminate();
  }
  state.worker = null;
  state.workerReady = false;
  resetSharedStdin();
  showGuard(true);

  const generation = workerGeneration + 1;
  workerGeneration = generation;
  const workerUrl = new URL("assets/worker.js", location.href).toString();

  if (typeof fetch !== "function") {
    const fallbackUrl = `${workerUrl}?v=${Date.now()}`;
    const worker = new Worker(fallbackUrl);
    registerWorker(worker);
    return;
  }

  fetch(workerUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Worker fetch failed: ${response.status}`);
      }
      return response.text();
    })
    .then((code) => {
      if (generation !== workerGeneration) {
        return;
      }
      const blob = new Blob([code], { type: "text/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      const worker = new Worker(blobUrl);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      registerWorker(worker);
    })
    .catch(() => {
      if (generation !== workerGeneration) {
        return;
      }
      const fallbackUrl = `${workerUrl}?v=${Date.now()}`;
      const worker = new Worker(fallbackUrl);
      registerWorker(worker);
    });
}

function registerWorker(worker) {
  state.worker = worker;
  state.workerReady = false;
  worker.addEventListener("message", (event) => handleWorkerMessage(event.data));
  worker.addEventListener("error", (event) => handleWorkerFailure(event));
  worker.addEventListener("messageerror", (event) => handleWorkerFailure(event));
  const stdinShared = setupSharedStdin();
  worker.postMessage({
    type: "init",
    indexURL: new URL("pyodide-0.29.1/pyodide/", location.href).toString(),
    stdinShared
  });
}

function handleWorkerFailure(event) {
  const detail = event && event.message ? `Worker error: ${event.message}` : "Worker error.";
  appendConsole(`\n${detail}\n`, true);
  updateRunStatus("error");
  setGuardMessage("Ошибка среды", "Не удалось загрузить среду выполнения.");
  showGuard(true);
}

function handleWorkerMessage(message) {
  if (message.type === "ready") {
    state.workerReady = true;
    updateRunStatus("idle");
    showGuard(false);
    return;
  }
  if (message.type === "stdout") {
    appendConsole(message.data, false);
    return;
  }
  if (message.type === "stderr") {
    appendConsole(message.data, true);
    if (state.runStatus === "running" && isRuntimeErrorText(message.data)) {
      updateRunStatus("error");
      enableConsoleInput(false);
      els.stopBtn.disabled = true;
    }
    return;
  }
  if (message.type === "status") {
    updateRunStatus(message.state);
    if (message.state === "running") {
      els.stopBtn.disabled = false;
      enableConsoleInput(true);
    } else {
      els.stopBtn.disabled = true;
      enableConsoleInput(false);
      if (state.runTimeout) {
        clearTimeout(state.runTimeout);
        state.runTimeout = null;
      }
      if (state.hardStopTimer) {
        clearTimeout(state.hardStopTimer);
        state.hardStopTimer = null;
      }
    }
    return;
  }
  if (message.type === "stdin_mode") {
    state.stdinMode = message.mode === "shared" ? "shared" : "message";
    return;
  }
  if (message.type === "stdin_request") {
    state.stdinWaiting = true;
    state.lastStdinRequestMode = message.mode || null;
    if (message.mode === "shared" || message.mode === "message") {
      state.stdinMode = message.mode;
    }
    if (state.stdinQueue.length) {
      deliverInput();
    }
    return;
  }
  if (message.type === "turtle") {
    renderTurtleEvent(message.event);
    return;
  }
  if (message.type === "file_data") {
    handleFileData(message);
    return;
  }
}


function getActiveTabName() {
  if (!els.fileTabs) {
    return null;
  }
  const tab = els.fileTabs.querySelector(".tab.active");
  if (tab && tab.dataset.name) {
    return tab.dataset.name;
  }
  return tab ? tab.textContent : null;
}

async function runActiveFile() {
  if (state.runtimeBlocked) {
    showGuard(true);
    return;
  }
  if (!state.workerReady) {
    showGuard(true);
    return;
  }
  const entryName = "main.py";
  const file = getFileByName(entryName);
  if (!file) {
    showToast("Нет main.py.");
    return;
  }
  clearConsole();
  clearTurtleCanvas();
  updateRunStatus("running");

  state.stdinQueue = [];
  state.stdinWaiting = false;

  const files = getCurrentFiles();
  const assets = state.mode === "project" ? await loadAssets() : [];
  setRuntimeAssets(assets);

  state.worker.postMessage({
    type: "run",
    entry: entryName,
    files,
    assets,
    runTimeoutMs: CONFIG.RUN_TIMEOUT_MS
  });

  if (state.runTimeout) {
    clearTimeout(state.runTimeout);
  }
  state.runTimeout = setTimeout(() => {
    softInterrupt("Превышен лимит времени.");
    state.hardStopTimer = setTimeout(() => {
      hardStop();
    }, 250);
  }, CONFIG.RUN_TIMEOUT_MS);
}

function stopRun() {
  softInterrupt("Остановлено пользователем.");
  hardStop();
}

function softInterrupt(message) {
  appendConsole(`\n${message}\n`, true);
}

function hardStop() {
  if (!state.worker) {
    return;
  }
  stopTurtleAnimation();
  if (state.runTimeout) {
    clearTimeout(state.runTimeout);
    state.runTimeout = null;
  }
  if (state.hardStopTimer) {
    clearTimeout(state.hardStopTimer);
    state.hardStopTimer = null;
  }
  state.worker.terminate();
  state.worker = null;
  state.workerReady = false;
  state.stdinQueue = [];
  state.stdinWaiting = false;
  spawnWorker();
  updateRunStatus("stopped");
  enableConsoleInput(false);
  els.stopBtn.disabled = true;
}

async function loadAssets() {
  const assets = [];
  for (const asset of state.project.assets) {
    const record = await dbGet("blobs", asset.blobId);
    if (!record) {
      continue;
    }
    const buffer = await readBlobData(record.data);
    assets.push({
      name: asset.name,
      mime: asset.mime,
      data: buffer
    });
  }
  return assets;
}

function normalizeAssetName(name) {
  if (!name) {
    return "";
  }
  let normalized = String(name);
  if (normalized.startsWith("/project/")) {
    normalized = normalized.slice("/project/".length);
  }
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function getAssetExtension(name) {
  const normalized = normalizeAssetName(name);
  const idx = normalized.lastIndexOf(".");
  if (idx === -1) {
    return "";
  }
  return normalized.slice(idx).toLowerCase();
}

function isImageAsset(name, mime) {
  if (mime && mime.startsWith("image/")) {
    return true;
  }
  return IMAGE_ASSET_EXTENSIONS.has(getAssetExtension(name));
}

function guessImageMime(name) {
  switch (getAssetExtension(name)) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

function revokeAssetUrls(renderer) {
  if (!renderer.assetUrls || typeof URL === "undefined") {
    return;
  }
  const uniqueUrls = new Set(renderer.assetUrls.values());
  uniqueUrls.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch (error) {
      // ignore revoke failures
    }
  });
  renderer.assetUrls.clear();
  renderer.assetImages.clear();
  renderer.fileRequests.clear();
}

function setRuntimeAssets(assets) {
  const renderer = getTurtleRenderer();
  revokeAssetUrls(renderer);
  if (!assets || !assets.length) {
    return;
  }
  assets.forEach((asset) => {
    const name = String(asset.name || "");
    if (!name || !isImageAsset(name, asset.mime)) {
      return;
    }
    let url = null;
    if (typeof URL !== "undefined" && typeof Blob !== "undefined") {
      try {
        const blob = new Blob([asset.data], { type: asset.mime || guessImageMime(name) });
        url = URL.createObjectURL(blob);
      } catch (error) {
        url = null;
      }
    }
    if (!url) {
      return;
    }
    const normalized = normalizeAssetName(name);
    renderer.assetUrls.set(name, url);
    renderer.assetUrls.set(normalized, url);
    renderer.assetUrls.set(`/project/${normalized}`, url);
    renderer.assetUrls.set(`./${normalized}`, url);
  });
}

function getAssetUrl(renderer, name) {
  if (!name || !renderer.assetUrls) {
    return null;
  }
  const normalized = normalizeAssetName(name);
  return (
    renderer.assetUrls.get(name) ||
    renderer.assetUrls.get(normalized) ||
    renderer.assetUrls.get(`/project/${normalized}`) ||
    renderer.assetUrls.get(`./${normalized}`) ||
    null
  );
}

function requestAssetImage(renderer, name, onReady) {
  if (!name) {
    if (onReady) {
      onReady(null);
    }
    return null;
  }
  const normalized = normalizeAssetName(name);
  const cached = renderer.assetImages.get(normalized);
  if (cached) {
    if (cached.status === "ready") {
      if (onReady) {
        onReady(cached.image);
      }
      return cached.image;
    }
    if (cached.status === "loading") {
      if (onReady) {
        cached.callbacks = cached.callbacks || [];
        cached.callbacks.push(onReady);
      }
      return null;
    }
  }
  const url = getAssetUrl(renderer, name);
  if (url) {
    const image = new Image();
    const entry = { image, status: "loading", callbacks: onReady ? [onReady] : [] };
    renderer.assetImages.set(normalized, entry);
    image.onload = () => {
      entry.status = "ready";
      const callbacks = entry.callbacks || [];
      entry.callbacks = [];
      callbacks.forEach((cb) => cb(image));
      drawTurtleFrame(renderer);
    };
    image.onerror = () => {
      entry.status = "error";
      entry.callbacks = [];
    };
    image.src = url;
    return null;
  }
  // Если изображение не найдено в assetUrls, попробуем загрузить из файловой системы Pyodide
  if (!state.worker || !state.workerReady) {
    if (onReady) {
      onReady(null);
    }
    return null;
  }
  if (!isImageAsset(name)) {
    if (onReady) {
      onReady(null);
    }
    return null;
  }
  // Проверяем, не запрашиваем ли мы уже этот файл
  if (renderer.fileRequests.has(normalized)) {
    const request = renderer.fileRequests.get(normalized);
    if (onReady) {
      request.callbacks = request.callbacks || [];
      request.callbacks.push(onReady);
    }
    return null;
  }
  // Запрашиваем файл из worker
  const requestId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const entry = { status: "loading", callbacks: onReady ? [onReady] : [], requestId };
  renderer.assetImages.set(normalized, entry);
  renderer.fileRequests.set(normalized, entry);
  state.worker.postMessage({
    type: "get_file",
    requestId: requestId,
    filename: name,
    mime: guessImageMime(name)
  });
  return null;
}

function handleFileData(message) {
  const renderer = getTurtleRenderer();
  let foundRequest = null;
  let normalized = null;
  for (const [key, request] of renderer.fileRequests.entries()) {
    if (request.requestId === message.requestId) {
      foundRequest = request;
      normalized = key;
      break;
    }
  }
  if (!foundRequest) {
    return;
  }
  renderer.fileRequests.delete(normalized);
  if (message.error) {
    foundRequest.status = "error";
    const callbacks = foundRequest.callbacks || [];
    foundRequest.callbacks = [];
    callbacks.forEach((cb) => cb(null));
    renderer.assetImages.delete(normalized);
    return;
  }
  if (!message.data) {
    foundRequest.status = "error";
    const callbacks = foundRequest.callbacks || [];
    foundRequest.callbacks = [];
    callbacks.forEach((cb) => cb(null));
    renderer.assetImages.delete(normalized);
    return;
  }
  // Создаем blob URL из данных файла
  try {
    const blob = new Blob([message.data], { type: message.mime || guessImageMime(message.filename || normalized) });
    const url = URL.createObjectURL(blob);
    const normalizedName = normalizeAssetName(message.filename || normalized);
    renderer.assetUrls.set(normalizedName, url);
    renderer.assetUrls.set(message.filename || normalized, url);
    renderer.assetUrls.set(`/project/${normalizedName}`, url);
    renderer.assetUrls.set(`./${normalizedName}`, url);
    const image = new Image();
    foundRequest.image = image;
    image.onload = () => {
      foundRequest.status = "ready";
      const callbacks = foundRequest.callbacks || [];
      foundRequest.callbacks = [];
      callbacks.forEach((cb) => cb(image));
      drawTurtleFrame(renderer);
    };
    image.onerror = () => {
      foundRequest.status = "error";
      foundRequest.callbacks = [];
      renderer.assetImages.delete(normalized);
    };
    image.src = url;
  } catch (error) {
    foundRequest.status = "error";
    const callbacks = foundRequest.callbacks || [];
    foundRequest.callbacks = [];
    callbacks.forEach((cb) => cb(null));
    renderer.assetImages.delete(normalized);
  }
}

function getTurtleRenderer() {
  if (!turtleRenderer.ready) {
    turtleRenderer.canvas = els.turtleCanvas;
    turtleRenderer.ctx = turtleRenderer.canvas.getContext("2d");
    turtleRenderer.drawCanvas = document.createElement("canvas");
    turtleRenderer.drawCtx = turtleRenderer.drawCanvas.getContext("2d");
    turtleRenderer.strokeCanvas = document.createElement("canvas");
    turtleRenderer.strokeCtx = turtleRenderer.strokeCanvas.getContext("2d");
    const width = turtleRenderer.canvas.width || TURTLE_CANVAS_WIDTH;
    const height = turtleRenderer.canvas.height || TURTLE_CANVAS_HEIGHT;
    turtleRenderer.drawCanvas.width = width;
    turtleRenderer.drawCanvas.height = height;
    turtleRenderer.strokeCanvas.width = width;
    turtleRenderer.strokeCanvas.height = height;
    turtleRenderer.centerX = width / 2;
    turtleRenderer.centerY = height / 2;
    turtleRenderer.drawCtx.fillStyle = turtleRenderer.bg;
    turtleRenderer.drawCtx.fillRect(0, 0, width, height);
    turtleRenderer.ready = true;
  }
  return turtleRenderer;
}

function createTurtleState() {
  return {
    x: 0,
    y: 0,
    heading: 0,
    visible: true,
    penSize: 2,
    penColor: "#000",
    fillColor: "#20b46a",
    shape: "classic",
    stretchWid: 1,
    stretchLen: 1,
    fillActive: false
  };
}

function getEventTurtleId(event) {
  if (event && event.tid !== undefined && event.tid !== null) {
    return String(event.tid);
  }
  return DEFAULT_TURTLE_ID;
}

function getTurtleState(renderer, id) {
  const key = id ? String(id) : DEFAULT_TURTLE_ID;
  let turtle = renderer.turtles.get(key);
  if (!turtle) {
    turtle = createTurtleState();
    renderer.turtles.set(key, turtle);
    renderer.turtleOrder.push(key);
  }
  return turtle;
}

function refreshTurtleBackground(renderer) {
  renderer.drawCtx.fillStyle = renderer.bg;
  renderer.drawCtx.fillRect(0, 0, renderer.drawCanvas.width, renderer.drawCanvas.height);
  if (renderer.bgImage) {
    renderer.drawCtx.drawImage(renderer.bgImage, 0, 0, renderer.drawCanvas.width, renderer.drawCanvas.height);
  }
}

function setTurtleBackgroundImage(renderer, name) {
  if (!name) {
    renderer.bgImageName = null;
    renderer.bgImage = null;
    refreshTurtleBackground(renderer);
    drawTurtleFrame(renderer);
    return;
  }
  const nextName = String(name);
  renderer.bgImageName = nextName;
  requestAssetImage(renderer, nextName, (image) => {
    if (!image || renderer.bgImageName !== nextName) {
      return;
    }
    renderer.bgImage = image;
    refreshTurtleBackground(renderer);
    drawTurtleFrame(renderer);
  });
}

function resetTurtleRenderer(width, height, bg, meta = {}) {
  const renderer = getTurtleRenderer();
  const fixedWidth = TURTLE_CANVAS_WIDTH;
  const fixedHeight = TURTLE_CANVAS_HEIGHT;
  renderer.bg = bg || renderer.bg;
  renderer.canvas.width = fixedWidth;
  renderer.canvas.height = fixedHeight;
  renderer.drawCanvas.width = fixedWidth;
  renderer.drawCanvas.height = fixedHeight;
  if (renderer.strokeCanvas) {
    renderer.strokeCanvas.width = fixedWidth;
    renderer.strokeCanvas.height = fixedHeight;
  }
  renderer.centerX = fixedWidth / 2;
  renderer.centerY = fixedHeight / 2;
  renderer.world = normalizeWorld(meta.world);
  renderer.mode = meta.mode || "standard";
  renderer.bgImage = null;
  renderer.bgImageName = null;
  refreshTurtleBackground(renderer);
  if (renderer.strokeCtx) {
    renderer.strokeCtx.clearRect(0, 0, fixedWidth, fixedHeight);
  }
  renderer.queue = [];
  renderer.current = null;
  renderer.animating = false;
  renderer.turtles.clear();
  renderer.turtleOrder = [];
  getTurtleState(renderer, DEFAULT_TURTLE_ID);
  drawTurtleFrame(renderer);
}

function clearTurtleLayer(bg) {
  const renderer = getTurtleRenderer();
  renderer.bg = bg || renderer.bg;
  refreshTurtleBackground(renderer);
  if (renderer.strokeCtx) {
    renderer.strokeCtx.clearRect(0, 0, renderer.strokeCanvas.width, renderer.strokeCanvas.height);
  }
  drawTurtleFrame(renderer);
}

function stopTurtleAnimation() {
  const renderer = getTurtleRenderer();
  renderer.queue = [];
  renderer.current = null;
  renderer.animating = false;
  drawTurtleFrame(renderer);
}

function enqueueTurtleEvent(event) {
  const renderer = getTurtleRenderer();
  if (event && typeof event === "object") {
    event._tid = getEventTurtleId(event);
  }
  renderer.queue.push(event);
  if (!renderer.animating) {
    renderer.animating = true;
    requestAnimationFrame(processTurtleQueue);
  }
}

function processTurtleQueue(timestamp) {
  const renderer = getTurtleRenderer();
  if (!renderer.current) {
    renderer.current = renderer.queue.shift();
    if (!renderer.current) {
      renderer.animating = false;
      return;
    }
  }

  const event = renderer.current;
  applyTurtleMeta(renderer, event);
  if (event.type === "move") {
    if (animateMove(renderer, event, timestamp)) {
      renderer.current = null;
    }
  } else if (event.type === "turn") {
    if (animateTurn(renderer, event, timestamp)) {
      renderer.current = null;
    }
  } else {
    applyTurtleEvent(renderer, event);
    renderer.current = null;
  }

  if (!renderer.current && renderer.queue.length === 0) {
    renderer.animating = false;
    return;
  }
  requestAnimationFrame(processTurtleQueue);
}

function animateMove(renderer, event, timestamp) {
  const turtle = getTurtleState(renderer, event._tid);
  if (!event._started) {
    event._started = true;
    event._startTime = timestamp;
    event._lastX = event.x1;
    event._lastY = event.y1;
    event._heading = Number.isFinite(event.heading)
      ? event.heading
      : headingFromMove(event, turtle.heading, renderer.mode);
    const distance = Math.hypot((event.x2 || 0) - (event.x1 || 0), (event.y2 || 0) - (event.y1 || 0));
    const duration = distance / turtleSpeedPxPerMs(event.speed);
    event._duration = Math.max(TURTLE_MIN_STEP_MS, duration);
  }

  const t = Math.min(1, (timestamp - event._startTime) / event._duration);
  const x = event.x1 + (event.x2 - event.x1) * t;
  const y = event.y1 + (event.y2 - event.y1) * t;

  if (event.pen) {
    const start = toCanvasCoords(renderer, event._lastX, event._lastY);
    const end = toCanvasCoords(renderer, x, y);
    const ctx = turtle.fillActive && renderer.strokeCtx ? renderer.strokeCtx : renderer.drawCtx;
    ctx.strokeStyle = event.color || "#1c6bff";
    ctx.lineWidth = event.width || 2;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  turtle.x = x;
  turtle.y = y;
  turtle.heading = event._heading;
  turtle.visible = event.visible !== false;
  if (event.width) {
    turtle.penSize = event.width;
  }

  event._lastX = x;
  event._lastY = y;
  drawTurtleFrame(renderer);

  return t >= 1;
}

function animateTurn(renderer, event, timestamp) {
  const turtle = getTurtleState(renderer, event._tid);
  if (!event._started) {
    event._started = true;
    event._startTime = timestamp;
    event._from = turtle.heading;
    event._to = Number.isFinite(event.heading) ? event.heading : turtle.heading;
    event._duration = TURTLE_MIN_STEP_MS * 2;
  }

  const t = Math.min(1, (timestamp - event._startTime) / event._duration);
  const delta = ((event._to - event._from + 540) % 360) - 180;
  turtle.heading = event._from + delta * t;
  if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
    turtle.x = event.x;
    turtle.y = event.y;
  }
  if (event.visible !== undefined) {
    turtle.visible = event.visible;
  }
  drawTurtleFrame(renderer);
  return t >= 1;
}

function applyTurtleEvent(renderer, event) {
  if (event.type === "fill_start") {
    const turtle = getTurtleState(renderer, event._tid);
    turtle.fillActive = true;
    if (renderer.strokeCtx) {
      renderer.strokeCtx.clearRect(0, 0, renderer.strokeCanvas.width, renderer.strokeCanvas.height);
    }
    return;
  }

  if (event.type === "fill_end") {
    const turtle = getTurtleState(renderer, event._tid);
    turtle.fillActive = false;
    if (renderer.strokeCtx) {
      renderer.strokeCtx.clearRect(0, 0, renderer.strokeCanvas.width, renderer.strokeCanvas.height);
    }
    drawTurtleFrame(renderer);
    return;
  }

  if (event.type === "turtle") {
    const turtle = getTurtleState(renderer, event._tid);
    if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
      turtle.x = event.x;
      turtle.y = event.y;
    }
    if (Number.isFinite(event.heading)) {
      turtle.heading = event.heading;
    }
    if (event.visible !== undefined) {
      turtle.visible = event.visible;
    }
    if (event.shape) {
      turtle.shape = String(event.shape);
    }
    if (Array.isArray(event.stretch)) {
      const wid = Number(event.stretch[0]);
      const len = Number(event.stretch[1]);
      if (Number.isFinite(wid)) {
        turtle.stretchWid = wid;
      }
      if (Number.isFinite(len)) {
        turtle.stretchLen = len;
      }
    }
    if (event.pencolor) {
      turtle.penColor = String(event.pencolor);
    }
    if (event.fillcolor) {
      turtle.fillColor = String(event.fillcolor);
    }
    if (Number.isFinite(event.pensize)) {
      turtle.penSize = event.pensize;
    }
    drawTurtleFrame(renderer);
    return;
  }

  if (event.type === "dot") {
    const turtle = getTurtleState(renderer, event._tid);
    if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
      turtle.x = event.x;
      turtle.y = event.y;
    }
    const size = event.size || 4;
    const pos = toCanvasCoords(renderer, event.x || 0, event.y || 0);
    const ctx = turtle.fillActive && renderer.strokeCtx ? renderer.strokeCtx : renderer.drawCtx;
    ctx.fillStyle = event.color || "#1c6bff";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    drawTurtleFrame(renderer);
    return;
  }

  if (event.type === "fill") {
    const points = Array.isArray(event.points) ? event.points : [];
    if (points.length < 2) {
      return;
    }
    renderer.drawCtx.fillStyle = event.color || "#1c6bff";
    renderer.drawCtx.beginPath();
    const first = toCanvasCoords(renderer, points[0][0], points[0][1]);
    renderer.drawCtx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i += 1) {
      const point = toCanvasCoords(renderer, points[i][0], points[i][1]);
      renderer.drawCtx.lineTo(point.x, point.y);
    }
    renderer.drawCtx.closePath();
    renderer.drawCtx.fill();
    if (renderer.strokeCanvas) {
      renderer.drawCtx.drawImage(renderer.strokeCanvas, 0, 0);
      renderer.strokeCtx.clearRect(0, 0, renderer.strokeCanvas.width, renderer.strokeCanvas.height);
    }
    const turtle = getTurtleState(renderer, event._tid);
    turtle.fillActive = false;
    drawTurtleFrame(renderer);
    return;
  }

  if (event.type === "text") {
    const turtle = getTurtleState(renderer, event._tid);
    const pos = toCanvasCoords(renderer, event.x || 0, event.y || 0);
    const ctx = turtle.fillActive && renderer.strokeCtx ? renderer.strokeCtx : renderer.drawCtx;
    ctx.fillStyle = event.color || "#1c6bff";
    ctx.font = event.font || "16px Rubik";
    const prevAlign = ctx.textAlign;
    const prevBaseline = ctx.textBaseline;
    if (event.align) {
      ctx.textAlign = String(event.align);
    }
    ctx.textBaseline = "middle";
    ctx.fillText(event.text || "", pos.x, pos.y);
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBaseline;
    drawTurtleFrame(renderer);
  }
}

function drawTurtleFrame(renderer) {
  if (!renderer.ctx) {
    return;
  }
  renderer.ctx.clearRect(0, 0, renderer.canvas.width, renderer.canvas.height);
  renderer.ctx.drawImage(renderer.drawCanvas, 0, 0);
  if (renderer.strokeCanvas) {
    renderer.ctx.drawImage(renderer.strokeCanvas, 0, 0);
  }
  renderer.turtleOrder.forEach((id) => {
    const turtle = renderer.turtles.get(id);
    if (turtle) {
      drawTurtleIcon(renderer, turtle);
    }
  });
}

function applyTurtleMeta(renderer, event) {
  if (!event) {
    return;
  }
  if (event.mode) {
    renderer.mode = event.mode;
  }
  if (event.type === "world") {
    renderer.world = normalizeWorld(event);
  } else if (event.world !== undefined) {
    renderer.world = normalizeWorld(event.world);
  }
}

function normalizeWorld(world) {
  if (!world) {
    return null;
  }
  const llx = Number(world.llx);
  const lly = Number(world.lly);
  const urx = Number(world.urx);
  const ury = Number(world.ury);
  if (![llx, lly, urx, ury].every(Number.isFinite)) {
    return null;
  }
  if (urx === llx || ury === lly) {
    return null;
  }
  return { llx, lly, urx, ury };
}

function displayHeading(renderer, heading) {
  const base = Number.isFinite(heading) ? heading : 0;
  if (renderer.mode === "logo") {
    return ((90 - base) % 360 + 360) % 360;
  }
  return ((base % 360) + 360) % 360;
}

function drawTurtleIcon(renderer, turtle) {
  if (!turtle || !turtle.visible) {
    return;
  }
  const pos = toCanvasCoords(renderer, turtle.x, turtle.y);
  const baseSize = 10 + Math.min(6, turtle.penSize || 2);
  const stretchLen = Number.isFinite(turtle.stretchLen) ? turtle.stretchLen : 1;
  const stretchWid = Number.isFinite(turtle.stretchWid) ? turtle.stretchWid : 1;
  const sizeX = baseSize * Math.max(0.2, stretchLen);
  const sizeY = baseSize * Math.max(0.2, stretchWid);
  const heading = displayHeading(renderer, turtle.heading);
  const ctx = renderer.ctx;
  const shape = String(turtle.shape || "classic").toLowerCase();
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate((-heading * Math.PI) / 180);
  ctx.fillStyle = turtle.fillColor || "#20b46a";
  ctx.strokeStyle = turtle.penColor || "rgba(0, 0, 0, 0.25)";
  ctx.lineWidth = 1;
  const assetUrl = getAssetUrl(renderer, turtle.shape);
  if (assetUrl || isImageAsset(shape) || isImageAsset(turtle.shape)) {
    const image = requestAssetImage(renderer, turtle.shape, () => drawTurtleFrame(renderer));
    if (image) {
      ctx.drawImage(image, -sizeX, -sizeY, sizeX * 2, sizeY * 2);
      ctx.restore();
      return;
    }
  }
  if (shape === "circle") {
    ctx.beginPath();
    if (typeof ctx.ellipse === "function") {
      ctx.ellipse(0, 0, sizeX, sizeY, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(0, 0, Math.max(sizeX, sizeY), 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  } else if (shape === "square") {
    ctx.beginPath();
    ctx.rect(-sizeX, -sizeY, sizeX * 2, sizeY * 2);
    ctx.fill();
    ctx.stroke();
  } else if (shape === "turtle") {
    const bodyX = sizeX * 1.1;
    const bodyY = sizeY * 0.8;
    ctx.beginPath();
    if (typeof ctx.ellipse === "function") {
      ctx.ellipse(0, 0, bodyX, bodyY, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(0, 0, Math.max(bodyX, bodyY), 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bodyX * 0.9, 0, Math.max(2, Math.min(bodyX, bodyY) * 0.35), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(sizeX, 0);
    ctx.lineTo(-sizeX * 0.6, sizeY * 0.6);
    ctx.lineTo(-sizeX * 0.6, -sizeY * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function toCanvasCoords(renderer, x, y) {
  if (renderer.world) {
    const { llx, lly, urx, ury } = renderer.world;
    const width = renderer.drawCanvas.width || TURTLE_CANVAS_WIDTH;
    const height = renderer.drawCanvas.height || TURTLE_CANVAS_HEIGHT;
    return {
      x: ((x - llx) / (urx - llx)) * width,
      y: height - ((y - lly) / (ury - lly)) * height
    };
  }
  return {
    x: renderer.centerX + x,
    y: renderer.centerY - y
  };
}

function fromCanvasCoords(renderer, x, y) {
  if (renderer.world) {
    const { llx, lly, urx, ury } = renderer.world;
    const width = renderer.drawCanvas.width || TURTLE_CANVAS_WIDTH;
    const height = renderer.drawCanvas.height || TURTLE_CANVAS_HEIGHT;
    return {
      x: llx + (x / width) * (urx - llx),
      y: lly + ((height - y) / height) * (ury - lly)
    };
  }
  return {
    x: x - renderer.centerX,
    y: renderer.centerY - y
  };
}

function headingFromMove(event, fallback, mode) {
  const dx = (event.x2 || 0) - (event.x1 || 0);
  const dy = (event.y2 || 0) - (event.y1 || 0);
  if (dx === 0 && dy === 0) {
    return fallback;
  }
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const standard = (angle + 360) % 360;
  if (mode === "logo") {
    return ((90 - standard) % 360 + 360) % 360;
  }
  return standard;
}

function isTouchEvent(event) {
  return !!(event && (event.touches || event.changedTouches));
}

function getEventClientPoint(event) {
  if (event && event.touches && event.touches.length) {
    return { clientX: event.touches[0].clientX, clientY: event.touches[0].clientY };
  }
  if (event && event.changedTouches && event.changedTouches.length) {
    return { clientX: event.changedTouches[0].clientX, clientY: event.changedTouches[0].clientY };
  }
  const clientX = event && typeof event.clientX === "number" ? event.clientX : 0;
  const clientY = event && typeof event.clientY === "number" ? event.clientY : 0;
  return { clientX, clientY };
}

function getEventPointerId(event) {
  if (supportsPointerEvents && event && typeof event.pointerId === "number") {
    return event.pointerId;
  }
  if (event && event.changedTouches && event.changedTouches.length) {
    return event.changedTouches[0].identifier;
  }
  return null;
}

function getEventButton(event) {
  if (isTouchEvent(event)) {
    return 0;
  }
  if (event && typeof event.button === "number") {
    return event.button;
  }
  if (event && typeof event.which === "number") {
    if (event.which === 2) {
      return 1;
    }
    if (event.which === 3) {
      return 2;
    }
    return 0;
  }
  return 0;
}

function buttonFromPointer(event) {
  const button = getEventButton(event);
  if (button === 1) {
    return 2;
  }
  if (button === 2) {
    return 3;
  }
  return 1;
}

function getCanvasPoint(event) {
  const rect = els.turtleCanvas.getBoundingClientRect();
  const scaleX = els.turtleCanvas.width / rect.width;
  const scaleY = els.turtleCanvas.height / rect.height;
  const point = getEventClientPoint(event);
  return {
    x: (point.clientX - rect.left) * scaleX,
    y: (point.clientY - rect.top) * scaleY
  };
}

function isPointOnTurtle(renderer, x, y) {
  for (let i = renderer.turtleOrder.length - 1; i >= 0; i -= 1) {
    const turtle = renderer.turtles.get(renderer.turtleOrder[i]);
    if (!turtle || !turtle.visible) {
      continue;
    }
    const pos = toCanvasCoords(renderer, turtle.x, turtle.y);
    const size = 12 + Math.min(8, turtle.penSize || 2);
    const dx = x - pos.x;
    const dy = y - pos.y;
    if (Math.hypot(dx, dy) <= size) {
      return true;
    }
  }
  return false;
}

function sendTurtleInputEvent(event) {
  if (!state.worker) {
    return;
  }
  state.worker.postMessage({ type: "turtle_event", event });
}

function onTurtlePointerDown(event) {
  if (!els.turtleCanvas) {
    return;
  }
  if (isTouchEvent(event) && event.cancelable) {
    event.preventDefault();
  }
  els.turtleCanvas.focus();
  turtleInput.active = true;
  const renderer = getTurtleRenderer();
  const point = getCanvasPoint(event);
  const worldPoint = fromCanvasCoords(renderer, point.x, point.y);
  const target = isPointOnTurtle(renderer, point.x, point.y) ? "turtle" : "screen";
  const button = buttonFromPointer(event);
  turtleInput.dragging = target === "turtle";
  turtleInput.dragButton = button;
  turtleInput.dragTarget = target;
  const pointerId = getEventPointerId(event);
  if (supportsPointerEvents && pointerId !== null && els.turtleCanvas.setPointerCapture) {
    els.turtleCanvas.setPointerCapture(pointerId);
  }
  sendTurtleInputEvent({
    type: "mouse",
    kind: "click",
    button,
    x: worldPoint.x,
    y: worldPoint.y,
    target
  });
}

function onTurtlePointerMove(event) {
  if (!turtleInput.dragging || !els.turtleCanvas) {
    return;
  }
  if (isTouchEvent(event) && event.cancelable) {
    event.preventDefault();
  }
  const renderer = getTurtleRenderer();
  const point = getCanvasPoint(event);
  const worldPoint = fromCanvasCoords(renderer, point.x, point.y);
  sendTurtleInputEvent({
    type: "mouse",
    kind: "drag",
    button: turtleInput.dragButton,
    x: worldPoint.x,
    y: worldPoint.y,
    target: turtleInput.dragTarget
  });
}

function onTurtlePointerUp(event) {
  if (!els.turtleCanvas) {
    return;
  }
  if (isTouchEvent(event) && event.cancelable) {
    event.preventDefault();
  }
  const pointerId = getEventPointerId(event);
  if (
    supportsPointerEvents &&
    pointerId !== null &&
    els.turtleCanvas.hasPointerCapture &&
    els.turtleCanvas.hasPointerCapture(pointerId)
  ) {
    els.turtleCanvas.releasePointerCapture(pointerId);
  }
  const renderer = getTurtleRenderer();
  const point = getCanvasPoint(event);
  const worldPoint = fromCanvasCoords(renderer, point.x, point.y);
  const target = turtleInput.dragTarget;
  sendTurtleInputEvent({
    type: "mouse",
    kind: "release",
    button: turtleInput.dragButton,
    x: worldPoint.x,
    y: worldPoint.y,
    target
  });
  turtleInput.dragging = false;
  turtleInput.dragTarget = "screen";
}

function mapTurtleKey(event) {
  const key = event.key;
  if (!key) {
    return null;
  }
  if (key === " ") {
    return "space";
  }
  if (key === "ArrowUp") {
    return "Up";
  }
  if (key === "ArrowDown") {
    return "Down";
  }
  if (key === "ArrowLeft") {
    return "Left";
  }
  if (key === "ArrowRight") {
    return "Right";
  }
  if (key === "Enter") {
    return "Return";
  }
  if (key === "Escape") {
    return "Escape";
  }
  if (key === "Backspace") {
    return "BackSpace";
  }
  if (key === "Delete") {
    return "Delete";
  }
  if (key === "Tab") {
    return "Tab";
  }
  return key;
}

function shouldHandleTurtleKey(event) {
  if (!turtleInput.listen || !turtleInput.active) {
    return false;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
    return false;
  }
  return true;
}

function onTurtleKeyDown(event) {
  if (!shouldHandleTurtleKey(event)) {
    return;
  }
  const key = mapTurtleKey(event);
  if (!key) {
    return;
  }
  sendTurtleInputEvent({ type: "key", kind: "press", key });
  event.preventDefault();
}

function onTurtleKeyUp(event) {
  if (!shouldHandleTurtleKey(event)) {
    return;
  }
  const key = mapTurtleKey(event);
  if (!key) {
    return;
  }
  sendTurtleInputEvent({ type: "key", kind: "release", key });
  event.preventDefault();
}

function turtleSpeedPxPerMs(speed) {
  const normalized = Math.max(0, Math.min(10, Number(speed ?? 3)));
  const turtleFactor = normalized === 0 ? 3.2 : 0.6 + normalized * 0.2;
  const preset = getTurtleSpeedPreset();
  return TURTLE_BASE_SPEED_PX_PER_MS * turtleFactor * preset.multiplier;
}

function renderTurtleEvent(event) {
  if (!event || !event.type) {
    return;
  }
  if (event.type === "init") {
    resetTurtleRenderer(TURTLE_CANVAS_WIDTH, TURTLE_CANVAS_HEIGHT, event.bg || "#f5f9ff", {
      mode: event.mode,
      world: event.world
    });
    return;
  }
  if (event.type === "listen") {
    turtleInput.listen = event.enabled !== false;
    if (turtleInput.listen && els.turtleCanvas) {
      els.turtleCanvas.focus();
    }
    return;
  }
  if (event.type === "bgpic") {
    const renderer = getTurtleRenderer();
    setTurtleBackgroundImage(renderer, event.name);
    return;
  }
  const renderer = getTurtleRenderer();
  if (event.type === "world") {
    applyTurtleMeta(renderer, event);
    drawTurtleFrame(renderer);
    return;
  }
  if (event.type === "mode") {
    renderer.mode = event.mode || renderer.mode;
    drawTurtleFrame(renderer);
    return;
  }
  applyTurtleMeta(renderer, event);
  if (event.type === "clear") {
    clearTurtleLayer(event.bg || "#f5f9ff");
    return;
  }
  if (event.type === "line") {
    enqueueTurtleEvent({
      type: "move",
      x1: event.x1,
      y1: event.y1,
      x2: event.x2,
      y2: event.y2,
      pen: true,
      color: event.color,
      width: event.width,
      heading: event.heading,
      visible: true,
      tid: event.tid,
      mode: event.mode || renderer.mode
    });
    return;
  }
  enqueueTurtleEvent(event);
}

function clearTurtleCanvas() {
  const renderer = getTurtleRenderer();
  resetTurtleRenderer(TURTLE_CANVAS_WIDTH, TURTLE_CANVAS_HEIGHT, renderer.bg);
}

function openModal(html, onAction) {
  els.modal.innerHTML = html;
  els.modal.classList.remove("hidden");
  els.modal.setAttribute("aria-hidden", "false");

  const buttons = els.modal.querySelectorAll("[data-action]");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      if (onAction) {
        onAction(action);
      }
    });
  });
}

function closeModal() {
  els.modal.classList.add("hidden");
  els.modal.setAttribute("aria-hidden", "true");
  els.modal.innerHTML = "";
}

async function promptModal({ title, placeholder, value, confirmText }) {
  return new Promise((resolve) => {
    const html = `
      <div class="modal-card">
        <h3>${title}</h3>
        <input class="modal-input" value="${value || ""}" placeholder="${placeholder || ""}" />
        <div class="modal-actions">
          <button class="btn ghost" data-action="cancel">Отмена</button>
          <button class="btn primary" data-action="confirm">${confirmText || "Ок"}</button>
        </div>
      </div>
    `;
    openModal(html, (action) => {
      if (action === "confirm") {
        const input = els.modal.querySelector(".modal-input");
        const valueText = input ? input.value : "";
        closeModal();
        resolve(valueText);
      } else {
        closeModal();
        resolve(null);
      }
    });
  });
}

async function confirmModal({ title, message, confirmText }) {
  return new Promise((resolve) => {
    const html = `
      <div class="modal-card">
        <h3>${title}</h3>
        <p>${message}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-action="cancel">Отмена</button>
          <button class="btn danger" data-action="confirm">${confirmText || "Подтвердить"}</button>
        </div>
      </div>
    `;
    openModal(html, (action) => {
      closeModal();
      resolve(action === "confirm");
    });
  });
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  els.toasts.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast("Ссылка скопирована.");
      return;
    }
  } catch (error) {
    // Fall back to manual copy.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (error) {
    ok = false;
  }
  textarea.remove();
  if (ok) {
    showToast("Ссылка скопирована.");
  } else {
    showToast("Не удалось скопировать.");
  }
}

async function openDb() {
  if (!("indexedDB" in window)) {
    return null;
  }
  return new Promise((resolve) => {
    let request = null;
    try {
      request = indexedDB.open("mshp-ide", 2);
    } catch (error) {
      console.warn("IndexedDB open failed", error);
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "projectId" });
      }
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs", { keyPath: "blobId" });
      }
      if (!db.objectStoreNames.contains("drafts")) {
        db.createObjectStore("drafts", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("recent")) {
        db.createObjectStore("recent", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("trash")) {
        db.createObjectStore("trash", { keyPath: "key" });
      }
    };
    request.onerror = () => {
      console.warn("IndexedDB error", request.error);
      resolve(null);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function dbGet(storeName, key) {
  if (!state.db) {
    const store = getMemoryStore(storeName);
    return store ? store.get(key) || null : null;
  }
  try {
    return await new Promise((resolve, reject) => {
      const tx = state.db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn("IndexedDB get failed", error);
    state.db = null;
    const store = getMemoryStore(storeName);
    return store ? store.get(key) || null : null;
  }
}

async function dbPut(storeName, value) {
  if (!state.db) {
    const store = getMemoryStore(storeName);
    const key = getStoreKey(storeName, value);
    if (store && key) {
      store.set(key, value);
      return true;
    }
    return false;
  }
  try {
    return await new Promise((resolve, reject) => {
      const tx = state.db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.put(value);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn("IndexedDB put failed", error);
    state.db = null;
    const store = getMemoryStore(storeName);
    const key = getStoreKey(storeName, value);
    if (store && key) {
      store.set(key, value);
      return true;
    }
    return false;
  }
}

async function dbDelete(storeName, key) {
  if (!state.db) {
    const store = getMemoryStore(storeName);
    if (store) {
      store.delete(key);
    }
    return true;
  }
  try {
    return await new Promise((resolve, reject) => {
      const tx = state.db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn("IndexedDB delete failed", error);
    state.db = null;
    const store = getMemoryStore(storeName);
    if (store) {
      store.delete(key);
    }
    return true;
  }
}
