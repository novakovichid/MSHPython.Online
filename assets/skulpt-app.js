import { gzipSync, gunzipSync } from "./skulpt-fflate.esm.js";

const CONFIG = {
  RUN_TIMEOUT_MS: 60000,
  MAX_OUTPUT_BYTES: 2000000,
  MAX_FILES: 30,
  MAX_TOTAL_TEXT_BYTES: 250000,
  MAX_SINGLE_FILE_BYTES: 50000,
  TAB_SIZE: 4,
  WORD_WRAP: true
};
const MAIN_FILE = "main.py";

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
    const noop = () => { };
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
const TURTLE_CANVAS_WIDTH = 400;
const TURTLE_CANVAS_HEIGHT = 400;
const TURTLE_SPEED_PRESETS = [
  { key: "slow", label: "Черепаха: Спокойно", multiplier: 1.3 },
  { key: "fast", label: "Черепаха: Быстро", multiplier: 2.2 },
  { key: "ultra", label: "Черепаха: Супер", multiplier: 3.6 }
];
const TURTLE_BASE_SPEED_PX_PER_MS = 1.1;
const TURTLE_MIN_STEP_MS = 16;
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
  runtimeReady: false,
  stdinResolver: null,
  runToken: 0,
  skulptFiles: null,
  skulptAssets: null,
  skulptAssetUrls: new Map(),
  runtimeBlocked: false,
  stdinQueue: [],
  stdinWaiting: false,
  runTimeout: null,
  turtleVisible: false,
  turtleUsedLastRun: false,
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
  recentList: document.getElementById("recent-list"),
  projectTitle: document.getElementById("project-title"),
  projectMode: document.getElementById("project-mode"),
  saveIndicator: document.getElementById("save-indicator"),
  restartIdeButtons: document.querySelectorAll("[data-action=\"restart-ide\"]"),
  runBtn: document.getElementById("run-btn"),
  stopBtn: document.getElementById("stop-btn"),
  clearBtn: document.getElementById("clear-btn"),
  shareBtn: document.getElementById("share-btn"),
  exportBtn: document.getElementById("export-btn"),
  remixBtn: document.getElementById("remix-btn"),
  resetBtn: document.getElementById("reset-btn"),
  tabSizeBtn: document.getElementById("tab-size-btn"),
  wrapBtn: document.getElementById("wrap-btn"),
  hotkeysBtn: document.getElementById("hotkeys-btn"),
  turtleSpeedRange: document.getElementById("turtle-speed"),
  turtleSpeedLabel: document.getElementById("turtle-speed-label"),
  sidebar: document.getElementById("sidebar"),
  fileList: document.getElementById("file-list"),
  assetList: document.getElementById("asset-list"), // Панель "Ресурсы" скрыта - см. комментарий перед onAssetUpload()
  fileCreate: document.getElementById("file-create"),
  fileRename: document.getElementById("file-rename"),
  fileDuplicate: document.getElementById("file-duplicate"),
  fileDelete: document.getElementById("file-delete"),
  assetInput: document.getElementById("asset-input"), // Законсервировано - см. комментарий перед onAssetUpload()
  fileTabs: document.getElementById("file-tabs"),
  lineNumbers: document.getElementById("line-numbers"),
  editorHighlight: document.getElementById("editor-highlight"),
  editor: document.getElementById("editor"),
  consoleOutput: document.getElementById("console-output"),
  consoleInput: document.getElementById("console-input"),
  consoleSend: document.getElementById("console-send"),
  runStatus: document.getElementById("run-status"),
  workspace: document.querySelector(".workspace"),
  turtlePane: document.querySelector(".turtle-pane"),
  turtleCanvas: document.getElementById("turtle-canvas"),
  turtleClear: document.getElementById("turtle-clear"),
  renameBtn: document.getElementById("rename-btn")
};

/**
 * Generates a UUID v4 string.
 * Uses crypto.randomUUID if available, falls back to crypto.getRandomValues,
 * and finally to Math.random() on older browsers.
 * @returns {string} A UUID v4 identifier
 */
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
  recent: new Map()
};

/**
 * Extracts the appropriate key for a given object from a database store.
 * @param {string} storeName - Store name: "projects", "blobs", "drafts", or "recent"
 * @param {Object} value - The object to extract key from
 * @returns {string|null} The key for this object or null if not found
 */
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
  return null;
}

function getMemoryStore(storeName) {
  return memoryDb[storeName] || null;
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

/**
 * Application initialization: opens database, sets up UI, loads settings, and starts router.
 * Called once on page load. Shows loading guard while initializing.
 * @async
 */
async function init() {
  showGuard(true);
  bindUi();
  setTurtlePaneVisible(false);
  state.db = await openDb();
  if (!state.db) {
    showToast("Storage fallback: changes will not persist in this browser.");
  }
  loadSettings();
  /**
   * Binds all UI event handlers: buttons, hotkeys, editor, file list, etc.
   * Must be called before any UI interactions.
   */
  initSkulpt();
  await router();
  window.addEventListener("hashchange", router);
}

function bindUi() {
  if (els.guardReload) {
    els.guardReload.addEventListener("click", () => location.reload());
  }
  els.newProject.addEventListener("click", () => createProjectAndOpen());
  els.clearRecent.addEventListener("click", clearRecentProjects);
  if (els.renameBtn) {
    els.renameBtn.addEventListener("click", renameProject);
  }
  if (els.restartIdeButtons && els.restartIdeButtons.length) {
    els.restartIdeButtons.forEach((button) => {
      button.addEventListener("click", restartIdeWithCacheClear);
    });
  }

  els.runBtn.addEventListener("click", runActiveFile);
  els.stopBtn.addEventListener("click", stopRun);
  els.clearBtn.addEventListener("click", clearConsole);
  els.shareBtn.addEventListener("click", shareProject);
  els.exportBtn.addEventListener("click", exportProject);
  els.remixBtn.addEventListener("click", remixSnapshot);
  els.resetBtn.addEventListener("click", resetSnapshot);
  els.tabSizeBtn.addEventListener("click", toggleTabSize);
  els.wrapBtn.addEventListener("click", toggleWrap);
  if (els.hotkeysBtn) {
    els.hotkeysBtn.addEventListener("click", showHotkeysModal);
  }
  if (els.turtleSpeedRange) {
    els.turtleSpeedRange.addEventListener("input", onTurtleSpeedInput);
  }

  els.fileCreate.addEventListener("click", () => createFile());
  els.fileRename.addEventListener("click", () => renameFile());
  els.fileDuplicate.addEventListener("click", () => duplicateFile());
  els.fileDelete.addEventListener("click", () => deleteFile());
  if (els.assetInput) {
    // Обработчик остаётся в коде для возможности восстановления функционала
    els.assetInput.addEventListener("change", onAssetUpload);
  }

  els.editor.addEventListener("input", onEditorInput);
  els.editor.addEventListener("keydown", onEditorKeydown);
  els.editor.addEventListener("scroll", syncEditorScroll);

  els.consoleSend.addEventListener("click", submitConsoleInput);
  els.consoleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitConsoleInput();
    }
  });

  els.turtleClear.addEventListener("click", () => clearTurtleCanvas());

  document.addEventListener("keydown", (event) => {
    if (!els.modal.classList.contains("hidden")) {
      return;
    }
    // Run code
    if (event.key === "F8" || (event.altKey && event.key === "r")) {
      event.preventDefault();
      runActiveFile();
    }
    // Stop execution
    if (event.altKey && event.key === "x") {
      event.preventDefault();
      stopExecution();
    }
    // Clear console
    if (event.altKey && event.key === "c") {
      event.preventDefault();
      clearConsole();
    }
    // Focus on editor (Alt+1)
    if (event.altKey && event.key === "1") {
      event.preventDefault();
      els.editor.focus();
    }
    // Focus on console input (Alt+2)
    if (event.altKey && event.key === "2") {
      event.preventDefault();
      els.consoleInput.focus();
    }
    // Focus on turtle canvas (Alt+3)
    if (event.altKey && event.key === "3") {
      event.preventDefault();
      els.turtleCanvas.focus();
    }
  });
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
  /**
   * Handles URL hash changes and navigates to the appropriate view.
   * Routes: "/"=home, "/p/{projectId}"=edit project, "/s/{shareId}"=view snapshot, "/embed"=embed mode.
   * @async
   */
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
    /**
     * Parses the current URL hash into route components (action, projectId, etc.).
     * @returns {{action: string, projectId: string|null, shareId: string|null, query: Object}}
     */
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
  /**
   * Opens an existing project by ID and switches to edit mode.
   * @async
   * @param {string} projectId - The project ID to open
   */
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
  /**
   * Creates a new project with default files and opens it in edit mode.
   * @async
   */
  ensureMainProject();
  state.activeFile = MAIN_FILE;

  setMode("project");
  renderProject();
  updateTurtleVisibilityForRun(state.project.files);
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
  /**
   * Creates a default project structure with main.py.
   * @param {string} projectId - Unique project identifier
   * @param {string} title - Project title
   * @returns {Object} Project object with files array
   */
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
        content: "print(\"Привет из MSHP-IDE!\")\n\nname = input(\"Как вас зовут? \")\nprint(\"Привет,\", name)\n"
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
    /**
     * Opens a shared snapshot by shareId and optional payload, switching to snapshot mode (read-only).
     * Creates draft for local edits.
     * @async
     * @param {string} shareId - The snapshot share ID
     * @param {string} payload - Compressed/encoded project data
     */
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
    updateTurtleVisibilityForRun(getEffectiveFiles());
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
  els.remixBtn.classList.toggle("hidden", !isSnapshot);
  els.resetBtn.classList.toggle("hidden", !isSnapshot);
  els.saveIndicator.classList.toggle("hidden", !isProject);
  if (els.renameBtn) {
    els.renameBtn.classList.toggle("hidden", !isProject);
  }

  const disableEdits = state.embed.readonly;
  els.editor.readOnly = disableEdits;
  els.fileCreate.disabled = disableEdits;
  els.fileRename.disabled = disableEdits;
  els.fileDuplicate.disabled = disableEdits;
  els.fileDelete.disabled = disableEdits;
  if (els.assetInput) {
    els.assetInput.disabled = disableEdits || !isProject;
  }
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
  if (!els.assetList) {
    return; // Asset panel is hidden/deprecated
  }
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
  
  // Tab indentation
  if (event.key === "Tab") {
    event.preventDefault();
    els.editor.value = value.slice(0, start) + spaces + value.slice(end);
    els.editor.selectionStart = els.editor.selectionEnd = start + spaces.length;
    onEditorInput();
    return;
  }

  // Get current line info
  const beforeSelection = value.slice(0, start);
  const lineStart = beforeSelection.lastIndexOf("\n") + 1;
  const currentLine = value.split("\n")[beforeSelection.split("\n").length - 1];
  const fullLineStart = start - currentLine.length;
  const fullLineEnd = fullLineStart + currentLine.length;

  // Alt+/ - Comment/uncomment current line
  if (event.altKey && event.key === "/") {
    event.preventDefault();
    const currentLineNum = value.slice(0, start).split("\n").length - 1;
    const lines = value.split("\n");
    const line = lines[currentLineNum];
    const trimmed = line.trim();
    
    if (trimmed.startsWith("#")) {
      // Uncomment
      lines[currentLineNum] = line.replace(/^(\s*)#\s?/, "$1");
    } else if (trimmed) {
      // Comment
      lines[currentLineNum] = line.replace(/^(\s*)/, "$1# ");
    }
    
    els.editor.value = lines.join("\n");
    onEditorInput();
    return;
  }

  // Alt+Up - Move line up
  if (event.altKey && event.key === "ArrowUp") {
    event.preventDefault();
    const currentLineNum = value.slice(0, start).split("\n").length - 1;
    if (currentLineNum === 0) return;
    
    const lines = value.split("\n");
    [lines[currentLineNum - 1], lines[currentLineNum]] = [lines[currentLineNum], lines[currentLineNum - 1]];
    els.editor.value = lines.join("\n");
    
    // Keep cursor at same position relative to text
    const newStart = start - currentLine.length - 1 - lines[currentLineNum - 1].length - 1;
    els.editor.selectionStart = els.editor.selectionEnd = newStart;
    onEditorInput();
    return;
  }

  // Alt+Down - Move line down
  if (event.altKey && event.key === "ArrowDown") {
    event.preventDefault();
    const lines = value.split("\n");
    const currentLineNum = value.slice(0, start).split("\n").length - 1;
    if (currentLineNum === lines.length - 1) return;
    
    [lines[currentLineNum], lines[currentLineNum + 1]] = [lines[currentLineNum + 1], lines[currentLineNum]];
    els.editor.value = lines.join("\n");
    
    // Keep cursor at same position relative to text
    const newStart = start + lines[currentLineNum + 1].length + 1;
    els.editor.selectionStart = els.editor.selectionEnd = newStart;
    onEditorInput();
    return;
  }

  // Ctrl+D - Duplicate line
  if (event.ctrlKey && event.key === "d") {
    event.preventDefault();
    const lines = value.split("\n");
    const currentLineNum = value.slice(0, start).split("\n").length - 1;
    lines.splice(currentLineNum + 1, 0, lines[currentLineNum]);
    els.editor.value = lines.join("\n");
    onEditorInput();
    return;
  }

  // Ctrl+Shift+K - Delete line
  if (event.ctrlKey && event.shiftKey && event.key === "K") {
    event.preventDefault();
    const lines = value.split("\n");
    const currentLineNum = value.slice(0, start).split("\n").length - 1;
    lines.splice(currentLineNum, 1);
    els.editor.value = lines.join("\n");
    
    // Move cursor to deleted line position or end
    const newPos = Math.min(start, els.editor.value.length);
    els.editor.selectionStart = els.editor.selectionEnd = newPos;
    onEditorInput();
    return;
  }

  // Ctrl+L - Select line
  if (event.ctrlKey && event.key === "l") {
    event.preventDefault();
    const currentLineNum = value.slice(0, start).split("\n").length - 1;
    const lines = value.split("\n");
    
    let lineStart = 0;
    for (let i = 0; i < currentLineNum; i++) {
      lineStart += lines[i].length + 1; // +1 for newline
    }
    const lineEnd = lineStart + lines[currentLineNum].length;
    
    els.editor.selectionStart = lineStart;
    els.editor.selectionEnd = lineEnd;
    return;
  }
}

function syncEditorScroll() {
  if (!els.editorHighlight || !els.lineNumbers) {
    return;
  }
  els.editorHighlight.scrollTop = els.editor.scrollTop;
  els.editorHighlight.scrollLeft = els.editor.scrollLeft;
  els.lineNumbers.scrollTop = els.editor.scrollTop;
  updateLineHighlightPosition();
}

function ensureLineHighlightElement() {
  if (els.lineHighlight) {
    return;
  }
  const host = els.editorHighlight ? els.editorHighlight.parentElement : null;
  if (!host) {
    return;
  }
  const highlight = document.createElement("div");
  highlight.className = "editor-line-highlight";
  highlight.style.display = "none";
  host.insertBefore(highlight, els.editorHighlight);
  els.lineHighlight = highlight;
}

function setEditorLineHighlight(lineNumber) {
  if (!Number.isFinite(lineNumber)) {
    return;
  }
  state.stepLine = Math.max(1, Math.floor(lineNumber));
  ensureLineHighlightElement();
  updateLineHighlightPosition();
  scrollEditorToLine(state.stepLine);
}

function clearEditorLineHighlight() {
  state.stepLine = null;
  if (els.lineHighlight) {
    els.lineHighlight.style.display = "none";
  }
}

function scrollEditorToLine(lineNumber) {
  if (!els.editor) {
    return;
  }
  const computed = getComputedStyle(els.editor);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 22;
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
  const lineTop = paddingTop + (lineNumber - 1) * lineHeight;
  const viewTop = els.editor.scrollTop;
  const viewBottom = viewTop + els.editor.clientHeight - lineHeight;
  if (lineTop < viewTop) {
    els.editor.scrollTop = Math.max(0, lineTop);
  } else if (lineTop > viewBottom) {
    els.editor.scrollTop = Math.max(0, lineTop - els.editor.clientHeight + lineHeight);
  }
}

function updateLineHighlightPosition() {
  if (!els.editor || !els.lineHighlight || !state.stepLine) {
    return;
  }
  const computed = getComputedStyle(els.editor);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 22;
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
  const maxLine = Math.max(1, (els.editor.value || "").split("\n").length);
  const lineNumber = Math.min(state.stepLine, maxLine);
  const top = paddingTop + (lineNumber - 1) * lineHeight - els.editor.scrollTop;
  els.lineHighlight.style.height = `${lineHeight}px`;
  els.lineHighlight.style.transform = `translateY(${Math.round(top)}px)`;
  els.lineHighlight.style.display = "block";
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
  updateLineHighlightPosition();
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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapToken(value, type) {
  return `<span class="token ${type}">${value}</span>`;
}
function getDefaultModuleName() {
  const files = getCurrentFiles();
  const existing = new Set(files.map((file) => String(file.name || "").toLowerCase()));
  let index = 1;
  let candidate = `module${index}.py`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `module${index}.py`;
  }
  return candidate;
}
async function createFile() {
  if (state.embed.readonly) {
    showToast("Режим только чтение.");
    return;
  }
  const defaultName = getDefaultModuleName();
  const name = await promptModal({
    title: "Создать модуль",
    placeholder: defaultName,
    fallbackValue: defaultName,
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

  state.activeFile = getCurrentFiles()[0]?.name || null;
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

/**
 * ЗАКОНСЕРВИРОВАНО: Загрузка ресурсов (изображений)
 * 
 * Причина: Skulpt не поддерживает загрузку изображений как форм черепахи.
 * Это архитектурное ограничение - Skulpt's Shape класс был разработан только для
 * полигонов (массивов координат). Когда вызывается Shape("image", name), создаётся
 * объект, но нет механизма для загрузки актуального файла PNG/JPG или рендеринга
 * через canvas drawImage().
 * 
 * Trinket.io работает, потому что использует собственный turtle.js модуль (JavaScript)
 * вместо встроенного Skulpt turtle, с явной поддержкой Image DOM элементов.
 * 
 * Решение: либо переписать turtle модуль как в Trinket, либо обновить Skulpt
 * до версии с поддержкой image shapes, либо использовать другую библиотеку графики.
 * 
 * Функция остаётся в коде для возможности восстановления в будущем.
 */
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
    open.className = "btn small";
    open.textContent = "Открыть";
    open.addEventListener("click", () => {
      location.hash = `#/p/${project.projectId}`;
    });
    card.append(title, meta, open);
    els.recentList.appendChild(card);
  }
}

async function clearRecentProjects() {
  await dbPut("recent", { key: "recent", list: [] });
  await renderRecent();
}

async function getRecent() {
  const record = await dbGet("recent", "recent");
  return record?.list || [];
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
  const safeUrl = escapeHtml(url);
  const modalBody = `
    <div class="modal-card">
      <h3>Ссылка на снимок</h3>
      <p>Неизменяемая ссылка на текущий снимок проекта.</p>
      <input class="modal-input" value="${safeUrl}" readonly />
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

async function restartIdeWithCacheClear() {
  const ok = await confirmModal({
    title: "Перезапуск IDE",
    message: "IDE будет перезапущена. Локальные данные и кеш будут очищены. Несохранённые изменения пропадут.",
    confirmText: "Перезапустить"
  });
  if (!ok) {
    return;
  }
  setGuardMessage("Перезапуск", "Очищаем кеш и перезагружаем IDE...");
  showGuard(true);
  try {
    if (state.db) {
      try {
        state.db.close();
      } catch (error) {
        console.warn("Failed to close db", error);
      }
    }
    if ("indexedDB" in window) {
      await new Promise((resolve) => {
        let request = null;
        try {
          request = indexedDB.deleteDatabase("mshp-ide-skulpt");
        } catch (error) {
          console.warn("IndexedDB delete failed", error);
          resolve();
          return;
        }
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    }
    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch (error) {
        console.warn("CacheStorage delete failed", error);
      }
    }
    try {
      if ("sessionStorage" in window) {
        sessionStorage.clear();
      }
    } catch (error) {
      console.warn("SessionStorage clear failed", error);
    }
    try {
      if ("localStorage" in window) {
        const keys = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key && (key.startsWith("shp-") || key.startsWith("mshp-"))) {
            keys.push(key);
          }
        }
        keys.forEach((key) => localStorage.removeItem(key));
      }
    } catch (error) {
      console.warn("LocalStorage clear failed", error);
    }
  } finally {
    location.reload();
  }
}

async function renameProject() {
  if (state.mode !== "project" || !state.project) {
    return;
  }
  const currentTitle = state.project.title || "Без названия";
  const modalBody = `
    <div class="modal-card">
      <h3>Переименовать проект</h3>
      <input type="text" id="rename-input" class="modal-input" value="${currentTitle.replace(/"/g, "&quot;")}" placeholder="Введите название..." />
      <div class="modal-actions">
        <button class="btn ghost" data-action="close">Отмена</button>
        <button class="btn primary" data-action="confirm">Сохранить</button>
      </div>
    </div>
  `;
  openModal(modalBody, async (action) => {
    if (action === "confirm") {
      const input = document.getElementById("rename-input");
      const newTitle = input ? input.value.trim() : "";
      if (newTitle && newTitle !== currentTitle) {
        state.project.title = newTitle;
        state.project.updatedAt = Date.now();
        await saveProject(state.project);
        renderProject();
        showToast("Проект переименован");
      }
    }
    closeModal();
  });

  // Handle Enter key for rename modal
  const input = document.getElementById("rename-input");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const confirmBtn = els.modal.querySelector('[data-action="confirm"]');
        if (confirmBtn) confirmBtn.click();
      }
    });
    setTimeout(() => input.focus(), 100);
  }
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
}

function enableConsoleInput(enable) {
  els.consoleInput.disabled = !enable;
  els.consoleSend.disabled = !enable;
}

function setConsoleInputWaiting(waiting) {
  state.stdinWaiting = waiting;
  if (!els.consoleInput) {
    return;
  }
  els.consoleInput.classList.toggle("awaiting-input", waiting);
  if (waiting) {
    els.consoleInput.focus();
    els.consoleInput.select();
  }
}

function submitConsoleInput() {
  const value = els.consoleInput.value;
  els.consoleInput.value = "";
  if (!value && !state.stdinWaiting && !state.stdinResolver) {
    return;
  }
  // Split input by lines and process each separately
  const lines = value.split("\n");
  lines.forEach((line) => {
    appendConsole(`${line}\n`, false);
  });
  
  // If waiting for input, deliver the first line
  if (state.stdinResolver) {
    const resolver = state.stdinResolver;
    state.stdinResolver = null;
    setConsoleInputWaiting(false);
    resolver(lines[0] || "");
    // Add remaining lines to queue
    for (let i = 1; i < lines.length; i++) {
      state.stdinQueue.push(lines[i]);
    }
    return;
  }
  // Add all lines to queue
  lines.forEach((line) => {
    state.stdinQueue.push(line);
  });
}

function deliverInput() {
  if (!state.stdinQueue.length || !state.stdinResolver) {
    return;
  }
  const value = state.stdinQueue.shift();
  const resolver = state.stdinResolver;
  state.stdinResolver = null;
  setConsoleInputWaiting(false);
  resolver(value);
}

function skulptInput(prompt) {
  if (prompt) {
    appendConsole(String(prompt), false);
  }
  if (state.stdinQueue.length) {
    return state.stdinQueue.shift();
  }
  setConsoleInputWaiting(true);
  enableConsoleInput(true);
  return new Promise((resolve) => {
    state.stdinResolver = resolve;
  });
}

function formatSkulptError(error) {
  if (!error) {
    return "Unknown error";
  }
  try {
    const baseException = Sk && Sk.builtin && Sk.builtin.BaseException;
    if (baseException && error instanceof baseException) {
      return error.toString();
    }
  } catch (e) {
    // fall through to generic formatting
  }
  if (error.stack) {
    return error.stack;
  }
  return String(error);
}

function initSkulpt() {
  if (typeof window === "undefined" || typeof window.Sk === "undefined") {
    state.runtimeBlocked = true;
    setGuardMessage("Среда не загружена", "Проверьте подключение библиотек.");
    return;
  }
  state.runtimeReady = true;
  updateRunStatus("idle");
  showGuard(false);
}



function getTurtleCanvasSize() {
  if (!els.turtleCanvas) {
    return { width: TURTLE_CANVAS_WIDTH, height: TURTLE_CANVAS_HEIGHT };
  }
  const rect = els.turtleCanvas.getBoundingClientRect();
  const width = Math.round(els.turtleCanvas.clientWidth || rect.width) || TURTLE_CANVAS_WIDTH;
  const height = Math.round(els.turtleCanvas.clientHeight || rect.height) || TURTLE_CANVAS_HEIGHT;
  return {
    width: Math.max(1, width),
    height: Math.max(1, height)
  };
}

function configureSkulptRuntime(files, assets, options = {}) {
  state.skulptFiles = buildSkulptFileMap(files);
  state.skulptAssets = buildSkulptAssetMap(assets);
  const turtleAssets = setSkulptTurtleAssets(assets);
  const turtleSize = getTurtleCanvasSize();
  const debugSession = null; // options.debugger || null;
  // const enableDebugging = Boolean(debugSession); // Forced off
  Sk.inBrowser = true;
  if (!Sk.asserts) {
    Sk.asserts = {
      assert: () => true,
      fail: () => { }
    };
  } else {
    if (typeof Sk.asserts.assert !== "function") {
      Sk.asserts.assert = () => true;
    }
    if (typeof Sk.asserts.fail !== "function") {
      Sk.asserts.fail = () => { };
    }
  }

  // POLYFILL SK.CONFIGURE
  if (typeof Sk.configure !== "function") {
    Sk.configure = function (config) {
      Sk.output = config.output;
      Sk.read = config.read;
      Sk.inputfun = config.inputfun;
      Sk.inputfunTakesPrompt = config.inputfunTakesPrompt;
      Sk.execLimit = config.execLimit;
      Sk.yieldLimit = config.yieldLimit;
      Sk.syspath = config.syspath;
      // Debugging and breakpoints suppressed
    };
  }

  Sk.configure({
    output: (text) => appendConsole(text, false),
    read: skulptRead,
    inputfun: skulptInput,
    inputfunTakesPrompt: true,
    execLimit: CONFIG.RUN_TIMEOUT_MS,
    yieldLimit: 100,
    syspath: ["/project"],
    debugging: false,
    breakpoints: undefined
  });
  Sk.execLimit = CONFIG.RUN_TIMEOUT_MS;
  Sk.execStart = Date.now();
  Sk.TurtleGraphics = {
    target: "turtle-canvas",
    width: TURTLE_CANVAS_WIDTH,
    height: TURTLE_CANVAS_HEIGHT,
    assets: turtleAssets
  };
  resetNativeTurtle();
}

function skulptRead(path) {
  const files = state.skulptFiles;
  const assets = state.skulptAssets;
  const normalized = normalizeSkulptPath(path);

  if (files && files.has(normalized)) {
    return files.get(normalized);
  }
  if (assets && assets.has(normalized)) {
    return assets.get(normalized);
  }
  if (Sk.builtinFiles && Sk.builtinFiles["files"] && Sk.builtinFiles["files"][path] !== undefined) {
    return Sk.builtinFiles["files"][path];
  }
  if (Sk.builtinFiles && Sk.builtinFiles["files"] && Sk.builtinFiles["files"][normalized] !== undefined) {
    return Sk.builtinFiles["files"][normalized];
  }
  throw new Sk.builtin.IOError(`File not found: '${path}'`);
}

function normalizeSkulptPath(path) {
  if (!path) {
    return "";
  }
  if (path.startsWith("/project/")) {
    return path;
  }
  if (path.startsWith("./")) {
    return `/project/${path.slice(2)}`;
  }
  if (path.startsWith("/")) {
    return path;
  }
  return `/project/${path}`;
}

function buildSkulptFileMap(files) {
  const map = new Map();
  files.forEach((file) => {
    const name = String(file.name || "");
    map.set(`/project/${name}`, String(file.content ?? ""));
  });
  return map;
}

function buildSkulptAssetMap(assets) {
  const map = new Map();
  assets.forEach((asset) => {
    const name = String(asset.name || "");
    const data = asset.data instanceof Uint8Array ? asset.data : new Uint8Array(asset.data || []);
    const decoded = decodeAssetBytes(data, name);
    map.set(`/project/${name}`, decoded);
    map.set(name, decoded);
  });
  return map;
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



function getSkulptAssetUrl(name) {
  if (!name) {
    return null;
  }
  const normalized = normalizeAssetName(name);
  const lower = normalized.toLowerCase();

  // Case-insensitive lookup in skulptAssetUrls
  let url = state.skulptAssetUrls.get(name) ||
    state.skulptAssetUrls.get(normalized) ||
    state.skulptAssetUrls.get(lower) ||
    state.skulptAssetUrls.get(`/project/${normalized}`) ||
    state.skulptAssetUrls.get(`./${normalized}`) ||
    null;

  // If not found, try iterating and finding case-insensitive match
  if (!url) {
    for (let [k, v] of state.skulptAssetUrls) {
      if (k.toLowerCase() === lower) {
        url = v;
        break;
      }
    }
  }

  if (url) {
    return url;
  }
  // Если не найдено в ассетах, пытаемся прочитать из файловой системы Skulpt
  if (!isImageAsset(name)) {
    return null;
  }
  // Проверяем, что Skulpt готов и skulptRead доступна
  if (!state.skulptFiles || typeof skulptRead !== "function") {
    return null;
  }
  try {
    const normalizedPath = normalizeSkulptPath(name);
    const data = skulptRead(normalizedPath);
    if (!data) {
      return null;
    }
    // Преобразуем данные в Uint8Array, если это строка
    let bytes;
    if (typeof data === "string") {
      bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 0xff;
      }
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      return null;
    }
    // Создаем blob URL
    if (typeof URL === "undefined" || typeof Blob === "undefined") {
      return null;
    }
    const blob = new Blob([bytes], { type: guessImageMime(name) });
    url = URL.createObjectURL(blob);
    // Сохраняем в кэш
    state.skulptAssetUrls.set(name, url);
    state.skulptAssetUrls.set(normalized, url);
    state.skulptAssetUrls.set(`/project/${name}`, url);
    state.skulptAssetUrls.set(`./${name}`, url);
    state.skulptAssetUrls.set(`/project/${normalized}`, url);
    state.skulptAssetUrls.set(`./${normalized}`, url);
    return url;
  } catch (error) {
    // Файл не найден или ошибка чтения
    // Игнорируем IOError и другие ошибки
    return null;
  }
}

function setSkulptTurtleAssets(assets) {
  revokeSkulptAssetUrls();
  const assetMap = {};
  const urlMap = new Map();

  if (assets && assets.length) {
    assets.forEach((asset) => {
      const name = String(asset.name || "");
      if (!name || !isImageAsset(name, asset.mime)) {
        return;
      }
      if (typeof URL === "undefined" || typeof Blob === "undefined") {
        return;
      }
      let url = null;
      try {
        const blob = new Blob([asset.data], { type: asset.mime || guessImageMime(name) });
        url = URL.createObjectURL(blob);
      } catch (error) {
        url = null;
      }
      if (!url) {
        return;
      }
      const normalized = normalizeAssetName(name);
      assetMap[name] = url;
      assetMap[normalized] = url;
      assetMap[`/project/${name}`] = url;
      assetMap[`./${name}`] = url;
      assetMap[`/project/${normalized}`] = url;
      assetMap[`./${normalized}`] = url;
      urlMap.set(name, url);
      urlMap.set(normalized, url);
      urlMap.set(`/project/${name}`, url);
      urlMap.set(`./${name}`, url);
      urlMap.set(`/project/${normalized}`, url);
      urlMap.set(`./${normalized}`, url);
      if (asset.blobId) {
        urlMap.set(asset.blobId, url);
      }
    });
  }

  state.skulptAssetUrls = urlMap;

  return new Proxy(assetMap, {
    get(target, prop) {
      if (typeof prop === "symbol") {
        return target[prop];
      }
      const key = String(prop);
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        return target[key];
      }
      const url = getSkulptAssetUrl(key);
      if (url) {
        target[key] = url;
        return url;
      }
      return undefined;
    },
    has(target, prop) {
      if (typeof prop === "symbol") {
        return prop in target;
      }
      const key = String(prop);
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        return true;
      }
      const url = getSkulptAssetUrl(key);
      return !!url;
    },
    ownKeys(target) {
      const keys = new Set(Object.keys(target));
      if (state.skulptAssetUrls) {
        state.skulptAssetUrls.forEach((_, key) => keys.add(key));
      }
      return Array.from(keys);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        return Object.getOwnPropertyDescriptor(target, prop);
      }
      const url = getSkulptAssetUrl(String(prop));
      if (url) {
        return {
          value: url,
          writable: true,
          enumerable: true,
          configurable: true
        };
      }
      return undefined;
    }
  });
}

const TEXT_ASSET_EXTENSIONS = new Set([
  ".py",
  ".txt",
  ".json",
  ".csv",
  ".md",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".svg"
]);

function decodeAssetBytes(bytes, name) {
  if (!bytes || !bytes.length) {
    return "";
  }
  const lowerName = String(name || "").toLowerCase();
  const dotIndex = lowerName.lastIndexOf(".");
  const ext = dotIndex >= 0 ? lowerName.slice(dotIndex) : "";
  if (!TEXT_ASSET_EXTENSIONS.has(ext)) {
    return bytesToBinaryString(bytes);
  }
  if (typeof TextDecoder !== "undefined") {
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch (error) {
      return bytesToBinaryString(bytes);
    }
  }
  return bytesToBinaryString(bytes);
}

function bytesToBinaryString(bytes) {
  let result = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return result;
}

const MODULE_CLEANUP_CODE = `
import sys, os
project_dir = os.getcwd()
project_modules = set()
try:
    for fname in os.listdir(project_dir):
        if fname.endswith(".py"):
            project_modules.add(os.path.splitext(fname)[0])
except Exception:
    project_modules = set()
for name, module in list(sys.modules.items()):
    if name == "__main__":
        continue
    try:
        mod_file = getattr(module, "__file__", "")
    except Exception:
        mod_file = ""
    if mod_file and str(mod_file).startswith(project_dir):
        sys.modules.pop(name, None)
        continue
    if name in project_modules:
        sys.modules.pop(name, None)
`;


function getTurtleSetupCode(assets) {
  const assetNames = (assets || [])
    .map((a) => String(a.name || ""))
    .filter((name) => name && !name.startsWith("/") && isImageAsset(name));

  return `
import turtle
import sys

def _universal_reg(*args, **kwargs):
    try:
        name = None
        shape = None
        # Support both (name) and (self, name) or (name, shape) etc.
        for a in args:
            if isinstance(a, str):
                if name is None: name = a
            elif name is not None and shape is None:
                shape = a
        
        if 'name' in kwargs: name = kwargs['name']
        if 'shape' in kwargs: shape = kwargs['shape']
        
        if not isinstance(name, str) or not name or len(name) > 1000: return

        s = turtle.Screen()
        if not hasattr(s, '_shapes'): s._shapes = {}
        
        # Check if it's likely an image based on extension
        lower_name = name.lower()
        is_image = any(lower_name.endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"])
        
        # Find the Shape class robustly
        ShapeClass = getattr(turtle, "Shape", None)
        if not ShapeClass and hasattr(s, '_shapes') and s._shapes:
            for val in s._shapes.values():
                if hasattr(val, '_type'):
                    ShapeClass = type(val)
                    break

        if ShapeClass:
            if shape is not None:
                s._shapes[name] = ShapeClass("polygon", shape)
            elif is_image or name not in (s.getshapes() if hasattr(s, 'getshapes') else []):
                s._shapes[name] = ShapeClass("image", name)
        else:
            s._shapes[name] = name
    except:
        pass

# --- Class Method Patches ---

# Patch Turtle.shape
_orig_t_shape = turtle.Turtle.shape
def _patched_t_shape(self, *args, **kwargs):
    try:
        name = None
        for a in args:
            if isinstance(a, str): name = a; break
        if name: _universal_reg(name)
    except: pass
    return _orig_t_shape(self, *args, **kwargs)
turtle.Turtle.shape = _patched_t_shape

# Patch Screen.addshape
turtle.Screen.addshape = _universal_reg
turtle.Screen.register_shape = _universal_reg

# Patch Screen.bgpic
_orig_s_bgpic = turtle.Screen.bgpic
def _patched_s_bgpic(self, *args, **kwargs):
    try:
        name = None
        for a in args:
            if isinstance(a, str): name = a; break
        if name and name != "nopic": _universal_reg(name)
    except: pass
    return _orig_s_bgpic(self, *args, **kwargs)
turtle.Screen.bgpic = _patched_s_bgpic

# --- Module Function Patches ---

# Patch turtle.addshape
turtle.addshape = _universal_reg
turtle.register_shape = _universal_reg

# Patch turtle.shape
_orig_mod_shape = turtle.shape
def _patched_mod_shape(*args, **kwargs):
    try:
        name = None
        for a in args:
            if isinstance(a, str): name = a; break
        if name: _universal_reg(name)
    except: pass
    return _orig_mod_shape(*args, **kwargs)
turtle.shape = _patched_mod_shape

# Patch turtle.bgpic
_orig_mod_bgpic = turtle.bgpic
def _patched_mod_bgpic(*args, **kwargs):
    try:
        name = None
        for a in args:
            if isinstance(a, str): name = a; break
        if name and name != "nopic": _universal_reg(name)
    except: pass
    return _orig_mod_bgpic(*args, **kwargs)
turtle.bgpic = _patched_mod_bgpic

# Pre-register assets
for n in ${JSON.stringify(assetNames)}:
    _universal_reg(n)
`;
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

const TURTLE_IMPORT_RE = /(^|\n)\s*(from\s+turtle\s+import\b|import\s+[^\n#]*\bturtle\b)/i;

function detectTurtleUsage(files) {
  if (!files || !files.length) {
    return false;
  }
  // Recursive import scanner: only show turtle pane if graphics are reachable from main.py
  const entryFile = files.find((f) => f.name === MAIN_FILE);
  if (!entryFile) {
    return false;
  }

  const visited = new Set();
  const queue = [entryFile.name];
  visited.add(entryFile.name);

  while (queue.length > 0) {
    const currentName = queue.shift();
    const file = files.find((f) => f.name === currentName);
    if (!file) {
      continue;
    }

    const content = String(file.content ?? "");
    if (TURTLE_IMPORT_RE.test(content)) {
      return true;
    }

    // Find other project imports
    const importRegex = /(?:^|\n)\s*(?:from|import)\s+([A-Za-z0-9._-]+)/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importedModule = match[1].split(".")[0];
      const fileName = `${importedModule}.py`;
      if (!visited.has(fileName) && files.some((f) => f.name === fileName)) {
        visited.add(fileName);
        queue.push(fileName);
      }
    }
  }
  return false;
}

function setTurtlePaneVisible(visible) {
  const nextVisible = Boolean(visible);
  state.turtleVisible = nextVisible;
  if (els.turtlePane) {
    els.turtlePane.classList.toggle("hidden", !nextVisible);
  }
  if (els.workspace) {
    els.workspace.classList.toggle("no-turtle", !nextVisible);
  }
}

function updateTurtleVisibilityForRun(files) {
  // Use entry point or all project files to check for turtle
  const usesTurtle = detectTurtleUsage(files);
  state.turtleUsedLastRun = usesTurtle;
  setTurtlePaneVisible(usesTurtle);
  // Ensure the workspace layout updates
  if (els.workspace) {
    els.workspace.classList.toggle("no-turtle", !usesTurtle);
  }
  return usesTurtle;
}

async function runActiveFile() {
  if (state.runtimeBlocked) {
    showGuard(true);
    return;
  }
  if (!state.runtimeReady) {
    showGuard(true);
    return;
  }

  // cancelStepSession(); // Removed
  clearEditorLineHighlight();
  const entryName = MAIN_FILE;

  const file = getFileByName(entryName);
  if (!file) {
    showToast("Нет main.py.");
    return;
  }
  if (state.activeFile !== MAIN_FILE) {
    setActiveFile(MAIN_FILE);
  }
  clearEditorLineHighlight();
  const files = getCurrentFiles();
  const usesTurtle = updateTurtleVisibilityForRun(files);
  clearConsole();
  if (els.turtleCanvas) {
    els.turtleCanvas.innerHTML = "";
  }
  updateRunStatus("running");

  state.stdinQueue = [];
  setConsoleInputWaiting(false);
  state.stdinResolver = null;

  const assets = state.mode === "project" ? await loadAssets() : [];

  try {
    configureSkulptRuntime(files, assets);
  } catch (error) {
    appendConsole(`\n${formatSkulptError(error)}\n`, true);
    hardStop("error");
    return;
  }
  const runToken = state.runToken + 1;
  state.runToken = runToken;
  els.stopBtn.disabled = false;
  enableConsoleInput(true);

  if (state.runTimeout) {
    clearTimeout(state.runTimeout);
  }
  state.runTimeout = setTimeout(() => {
    softInterrupt("Time limit exceeded.");
    state.runToken += 1;
    hardStop("error");
  }, CONFIG.RUN_TIMEOUT_MS + 200);

  try {
    try {
      await Sk.misceval.asyncToPromise(() =>
        Sk.importMainWithBody("__cleanup__", false, MODULE_CLEANUP_CODE, true)
      );
    } catch (error) {
      // Ignore cleanup failures and proceed with execution.
    }
    if (usesTurtle) {
      const setupCode = getTurtleSetupCode(assets);
      try {
        await Sk.misceval.asyncToPromise(() =>
          Sk.importMainWithBody("__init_turtle__", false, setupCode, true)
        );
      } catch (err) {
        console.warn("Turtle patch failed", err);
      }
    }
    await Sk.misceval.asyncToPromise(() =>
      Sk.importMainWithBody("__main__", false, String(file.content || ""), true)
    );
    if (state.runToken !== runToken) {
      return;
    }
    updateRunStatus("done");
  } catch (error) {
    if (state.runToken !== runToken) {
      return;
    }
    appendConsole(`\n${formatSkulptError(error)}\n`, true);
    hardStop("error");
  } finally {
    if (state.runToken === runToken) {
      enableConsoleInput(false);
      els.stopBtn.disabled = true;
      state.stdinResolver = null;
      setConsoleInputWaiting(false);
      state.stdinQueue = [];
    }
    if (state.runTimeout) {
      clearTimeout(state.runTimeout);
      state.runTimeout = null;
    }
  }
}

// function createStepDebugger etc. removed and archived to archive/step-execution.js

function stopRun() {
  state.runToken += 1;
  // cancelStepSession(); // Removed
  softInterrupt("Stopped by user.");
  hardStop("stopped");
}

function softInterrupt(message) {
  appendConsole(`\n${message}\n`, true);
}

function stopTurtleAnimation() {
  const target = getTurtleTarget();
  if (!target) {
    return;
  }
  const instance = target.turtleInstance;
  if (!instance) {
    return;
  }
  if (typeof instance.stop === "function") {
    try {
      instance.stop();
      return;
    } catch (error) {
      // fall through to other options
    }
  }
  if (typeof instance.pause === "function") {
    try {
      instance.pause();
    } catch (error) {
      // ignore pause failures
    }
  }
}

function hardStop(status = "stopped") {
  stopTurtleAnimation();
  if (state.runTimeout) {
    clearTimeout(state.runTimeout);
    state.runTimeout = null;
  }
  if (typeof Sk !== "undefined") {
    Sk.execLimit = 1;
    Sk.execStart = Date.now() - CONFIG.RUN_TIMEOUT_MS - 1;
  }
  state.stdinQueue = [];
  setConsoleInputWaiting(false);
  state.stdinResolver = null;
  updateRunStatus(status);
  enableConsoleInput(false);
  els.stopBtn.disabled = true;
  revokeSkulptAssetUrls();
}

async function loadAssets() {
  const assets = [];
  if (!state.project || !state.project.assets) {
    return assets;
  }
  for (const asset of state.project.assets) {
    const record = await dbGet("blobs", asset.blobId);
    if (!record) {
      continue;
    }
    const buffer = await readBlobData(record.data);
    assets.push({
      name: asset.name,
      mime: asset.mime,
      blobId: asset.blobId,
      data: buffer
    });
  }
  return assets;
}


function revokeSkulptAssetUrls() {
  state.skulptAssetUrls.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch (error) {
      // Ignore
    }
  });
  state.skulptAssetUrls.clear();
}

function getTurtleTarget() {
  if (!els.turtleCanvas) {
    return null;
  }
  return els.turtleCanvas;
}

function resetNativeTurtle() {
  const target = getTurtleTarget();
  if (!target) {
    return;
  }
  const instance = target.turtleInstance;
  if (instance && typeof instance.reset === "function") {
    try {
      instance.reset();
      return;
    } catch (error) {
      // fall through to container cleanup
    }
  }
  while (target.firstChild) {
    target.removeChild(target.firstChild);
  }
}

function clearTurtleCanvas() {
  resetNativeTurtle();
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

function showHotkeysModal() {
  const title = "\u0413\u043e\u0440\u044f\u0447\u0438\u0435 \u043a\u043b\u0430\u0432\u0438\u0448\u0438";
  const runLabel = "\u0437\u0430\u043f\u0443\u0441\u043a";
  const html = `
    <div class="modal-card">
      <h3>${title}</h3>
      <ul class="hotkeys-list">
        <li><strong>F8</strong> или <strong>Alt+R</strong> — ${runLabel}</li>
        <li><strong>Alt+X</strong> — Остановить выполнение</li>
        <li><strong>Alt+C</strong> — Очистить консоль</li>
        <li><strong>Alt+1</strong> — Фокус на редактор кода</li>
        <li><strong>Alt+2</strong> — Фокус на консоль (для input)</li>
        <li><strong>Alt+3</strong> — Фокус на черепаху</li>
        <li style="margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px;"><strong>Редактор кода:</strong></li>
        <li><strong>Tab</strong> — Отступ</li>
        <li><strong>Alt+/</strong> — Комментировать строку</li>
        <li><strong>Alt+↑</strong> — Переместить строку вверх</li>
        <li><strong>Alt+↓</strong> — Переместить строку вниз</li>
        <li><strong>Ctrl+D</strong> — Дублировать строку</li>
        <li><strong>Ctrl+Shift+K</strong> — Удалить строку</li>
        <li><strong>Ctrl+L</strong> — Выделить строку</li>
      </ul>
      <div class="modal-actions">
        <button class="btn primary" data-action="close">\u041e\u043a</button>
      </div>
    </div>
  `;
  openModal(html, () => {
    closeModal();
  });
  const button = els.modal.querySelector("[data-action=\"close\"]");
  if (button) {
    button.focus();
  }
}

async function promptModal({ title, placeholder, value, confirmText, fallbackValue }) {
  return new Promise((resolve) => {
    const safeTitle = escapeHtml(String(title || ""));
    const safePlaceholder = escapeHtml(String(placeholder || ""));
    const safeValue = escapeHtml(String(value || ""));
    const safeConfirm = escapeHtml(String(confirmText || "OK"));
    let resolved = false;
    const finish = (action) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (action === "confirm") {
        const input = els.modal.querySelector(".modal-input");
        let valueText = input ? input.value : "";
        if (!valueText.trim() && fallbackValue !== undefined && fallbackValue !== null) {
          valueText = String(fallbackValue);
        }
        closeModal();
        resolve(valueText);
      } else {
        closeModal();
        resolve(null);
      }
    };
    const html = `
      <div class="modal-card">
        <h3>${safeTitle}</h3>
        <input class="modal-input" value="${safeValue}" placeholder="${safePlaceholder}" />
        <div class="modal-actions">
          <button class="btn ghost" data-action="cancel">Cancel</button>
          <button class="btn primary" data-action="confirm">${safeConfirm}</button>
        </div>
      </div>
    `;
    openModal(html, (action) => finish(action));
    const input = els.modal.querySelector(".modal-input");
    if (input) {
      input.focus();
      if (value) {
        input.select();
      }
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish("confirm");
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish("cancel");
        }
      });
    }
  });
}

async function confirmModal({ title, message, confirmText }) {
  return new Promise((resolve) => {
    const safeTitle = escapeHtml(String(title || ""));
    const safeMessage = escapeHtml(String(message || ""));
    const safeConfirm = escapeHtml(String(confirmText || "Confirm"));
    let resolved = false;
    const finish = (action) => {
      if (resolved) {
        return;
      }
      resolved = true;
      els.modal.removeEventListener("keydown", onKeyDown);
      closeModal();
      resolve(action === "confirm");
    };
    const onKeyDown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish("confirm");
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish("cancel");
      }
    };
    const html = `
      <div class="modal-card">
        <h3>${safeTitle}</h3>
        <p>${safeMessage}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-action="cancel">Cancel</button>
          <button class="btn danger" data-action="confirm">${safeConfirm}</button>
        </div>
      </div>
    `;
    openModal(html, (action) => finish(action));
    const confirmButton = els.modal.querySelector('[data-action="confirm"]');
    if (confirmButton) {
      confirmButton.focus();
    }
    els.modal.addEventListener("keydown", onKeyDown);
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
      request = indexedDB.open("mshp-ide-skulpt", 1);
    } catch (error) {
      console.warn("IndexedDB open failed", error);
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("projects", { keyPath: "projectId" });
      db.createObjectStore("blobs", { keyPath: "blobId" });
      db.createObjectStore("drafts", { keyPath: "key" });
      db.createObjectStore("recent", { keyPath: "key" });
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
