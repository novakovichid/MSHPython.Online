import { gzipSync, gunzipSync } from "./skulpt-fflate.esm.js";

const CONFIG = {
  RUN_TIMEOUT_MS: 10000,
  MAX_OUTPUT_BYTES: 2000000,
  MAX_FILES: 30,
  MAX_TOTAL_TEXT_BYTES: 250000,
  MAX_SINGLE_FILE_BYTES: 50000,
  TAB_SIZE: 4,
  WORD_WRAP: true
};

const VALID_FILENAME = /^[A-Za-z0-9._-]+$/;
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
const TURTLE_CANVAS_WIDTH = 400;
const TURTLE_CANVAS_HEIGHT = 300;
const TURTLE_SPEED_PRESETS = [
  { key: "slow", label: "Черепаха: Спокойно", multiplier: 1.3 },
  { key: "fast", label: "Черепаха: Быстро", multiplier: 2.2 },
  { key: "ultra", label: "Черепаха: Супер", multiplier: 3.6 }
];
const TURTLE_BASE_SPEED_PX_PER_MS = 1.1;
const TURTLE_MIN_STEP_MS = 16;

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
  runtimeBlocked: false,
  stdinQueue: [],
  stdinWaiting: false,
  runTimeout: null,
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
  runBtn: document.getElementById("run-btn"),
  stopBtn: document.getElementById("stop-btn"),
  clearBtn: document.getElementById("clear-btn"),
  shareBtn: document.getElementById("share-btn"),
  exportBtn: document.getElementById("export-btn"),
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
  consoleOutput: document.getElementById("console-output"),
  consoleInput: document.getElementById("console-input"),
  consoleSend: document.getElementById("console-send"),
  runStatus: document.getElementById("run-status"),
  turtleCanvas: document.getElementById("turtle-canvas"),
  turtleClear: document.getElementById("turtle-clear")
};

const turtleRenderer = {
  ready: false,
  canvas: null,
  ctx: null,
  drawCanvas: null,
  drawCtx: null,
  strokeCanvas: null,
  strokeCtx: null,
  bg: "#f5f9ff",
  centerX: 0,
  centerY: 0,
  world: null,
  mode: "standard",
  fillActive: false,
  turtle: {
    x: 0,
    y: 0,
    heading: 0,
    visible: true,
    penSize: 2,
    shape: "classic",
    stretchWid: 1,
    stretchLen: 1
  },
  queue: [],
  animating: false,
  current: null
};

const turtleInput = {
  listen: false,
  active: false,
  dragging: false,
  dragButton: 1,
  dragTarget: "screen"
};

const skulptTurtleRuntime = createSkulptTurtleRuntime();
if (typeof window !== "undefined") {
  window.__mshpSkulptTurtle = skulptTurtleRuntime;
}

function createSkulptTurtleRuntime() {
  const screen = {
    bg: "#f5f9ff",
    colorMode: 1.0,
    mode: "standard",
    world: null,
    tracer: 1,
    delay: 10,
    listen: false,
    pending: []
  };
  const turtle = {
    x: 0,
    y: 0,
    heading: 0,
    penDown: true,
    penColor: "black",
    fillColor: "black",
    penSize: 1,
    fillActive: false,
    fillPath: [],
    speed: 3,
    visible: true,
    shape: "classic",
    stretchWid: 1,
    stretchLen: 1
  };
  const handlers = {
    keyPress: new Map(),
    keyRelease: new Map(),
    keyAnyPress: [],
    keyAnyRelease: [],
    mouseClick: new Map(),
    mouseRelease: new Map(),
    mouseDrag: new Map(),
    turtleClick: new Map(),
    turtleRelease: new Map(),
    turtleDrag: new Map()
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function toPlain(value) {
    try {
      if (typeof Sk !== 'undefined' && Sk.ffi) {
        return Sk.ffi.remapToJs(value);
      }
    } catch (error) {
      // ignore
    }
    return value;
  }

  function emit(event) {
    if (screen.tracer === 0 && event.type !== "init" && event.type !== "listen") {
      screen.pending.push(event);
      return;
    }
    renderTurtleEvent(event);
  }

  function emitInit() {
    emit({
      type: "init",
      w: TURTLE_CANVAS_WIDTH,
      h: TURTLE_CANVAS_HEIGHT,
      bg: screen.bg,
      mode: screen.mode,
      world: screen.world
    });
  }

  function emitTurtle() {
    emit({
      type: "turtle",
      x: turtle.x,
      y: turtle.y,
      heading: turtle.heading,
      visible: turtle.visible,
      speed: turtle.speed,
      mode: screen.mode,
      shape: turtle.shape,
      stretch: [turtle.stretchWid, turtle.stretchLen]
    });
  }

  function headingToRadians() {
    let angle = turtle.heading;
    if (screen.mode === "logo") {
      angle = 90 - angle;
    }
    return (angle * Math.PI) / 180;
  }

  function angleToHeading(angle) {
    if (screen.mode === "logo") {
      return (90 - angle) % 360;
    }
    return ((angle % 360) + 360) % 360;
  }

  function move(dist) {
    const radians = headingToRadians();
    const x1 = turtle.x;
    const y1 = turtle.y;
    const nx = x1 + Math.cos(radians) * dist;
    const ny = y1 + Math.sin(radians) * dist;
    if (turtle.fillActive) {
      turtle.fillPath.push([nx, ny]);
    }
    turtle.x = nx;
    turtle.y = ny;
    emit({
      type: "move",
      x1,
      y1,
      x2: nx,
      y2: ny,
      pen: turtle.penDown,
      color: turtle.penColor,
      width: turtle.penSize,
      heading: turtle.heading,
      visible: turtle.visible,
      speed: turtle.speed,
      mode: screen.mode
    });
  }

  function turnLeft(angle) {
    if (screen.mode === "logo") {
      turtle.heading = (turtle.heading - angle) % 360;
    } else {
      turtle.heading = (turtle.heading + angle) % 360;
    }
    emit({
      type: "turn",
      x: turtle.x,
      y: turtle.y,
      heading: turtle.heading,
      visible: turtle.visible,
      speed: turtle.speed,
      mode: screen.mode
    });
  }

  function turnRight(angle) {
    if (screen.mode === "logo") {
      turtle.heading = (turtle.heading + angle) % 360;
    } else {
      turtle.heading = (turtle.heading - angle) % 360;
    }
    emit({
      type: "turn",
      x: turtle.x,
      y: turtle.y,
      heading: turtle.heading,
      visible: turtle.visible,
      speed: turtle.speed,
      mode: screen.mode
    });
  }

  function parsePosition(x, y) {
    if (Array.isArray(x) && x.length >= 2) {
      return [Number(x[0]), Number(x[1])];
    }
    return [Number(x), Number(y)];
  }

  function colorToCss(value) {
    if (Array.isArray(value) && value.length >= 3) {
      let r = value[0];
      let g = value[1];
      let b = value[2];
      if (screen.colorMode === 1.0) {
        r = Math.round(clamp(r, 0, 1) * 255);
        g = Math.round(clamp(g, 0, 1) * 255);
        b = Math.round(clamp(b, 0, 1) * 255);
      }
      return `rgb(${r}, ${g}, ${b})`;
    }
    return String(value);
  }

  function setColor(argList) {
    if (argList.length === 1) {
      const css = colorToCss(argList[0]);
      turtle.penColor = css;
      turtle.fillColor = css;
      return;
    }
    if (argList.length >= 3) {
      const css = colorToCss(argList);
      turtle.penColor = css;
      turtle.fillColor = css;
      return;
    }
    if (argList.length >= 2) {
      turtle.penColor = colorToCss(argList[0]);
      turtle.fillColor = colorToCss(argList[1]);
    }
  }

  function beginFill() {
    turtle.fillActive = true;
    turtle.fillPath = [[turtle.x, turtle.y]];
    emit({ type: "fill_start" });
  }

  function endFill() {
    if (!turtle.fillActive) {
      return;
    }
    turtle.fillActive = false;
    emit({ type: "fill_end" });
    if (turtle.fillPath.length > 1) {
      emit({
        type: "fill",
        points: turtle.fillPath,
        color: turtle.fillColor
      });
    }
    turtle.fillPath = [];
  }

  function resetState() {
    turtle.x = 0;
    turtle.y = 0;
    turtle.heading = 0;
    turtle.penDown = true;
    turtle.penColor = "black";
    turtle.fillColor = "black";
    turtle.penSize = 1;
    turtle.fillActive = false;
    turtle.fillPath = [];
    turtle.speed = 3;
    turtle.visible = true;
    turtle.shape = "classic";
    turtle.stretchWid = 1;
    turtle.stretchLen = 1;
  }

  function resetAll() {
    screen.world = null;
    emitInit();
    resetState();
    emitTurtle();
  }

  function callHandlers(list, args) {
    list.forEach((handler) => {
      try {
        const pyArgs = args.map((arg) => Sk.ffi.remapToPy(arg));
        Sk.misceval.callsim(handler, ...pyArgs);
      } catch (error) {
        // ignore handler errors
      }
    });
  }

  function callHandlerMap(map, key, args) {
    const handlersForKey = map.get(key);
    if (!handlersForKey) {
      return;
    }
    callHandlers(handlersForKey, args);
  }

  function setHandler(map, key, fn, add) {
    if (!fn) {
      map.delete(key);
      return;
    }
    const list = map.get(key) || [];
    if (!add) {
      list.length = 0;
    }
    list.push(fn);
    map.set(key, list);
  }

  function setAnyHandler(list, fn, add) {
    if (!fn) {
      list.length = 0;
      return;
    }
    if (!add) {
      list.length = 0;
    }
    list.push(fn);
  }

  function handleInputEvent(event) {
    if (!screen.listen) {
      return;
    }
    if (event.type === "key") {
      if (event.kind === "press") {
        callHandlers(handlers.keyAnyPress, []);
        callHandlerMap(handlers.keyPress, event.key, []);
      } else if (event.kind === "release") {
        callHandlers(handlers.keyAnyRelease, []);
        callHandlerMap(handlers.keyRelease, event.key, []);
      }
      return;
    }
    if (event.type === "pointer") {
      const args = [event.x, event.y];
      if (event.kind === "press") {
        if (event.target === "turtle") {
          callHandlerMap(handlers.turtleClick, event.btn, args);
        } else {
          callHandlerMap(handlers.mouseClick, event.btn, args);
        }
      }
      if (event.kind === "drag") {
        if (event.target === "turtle") {
          callHandlerMap(handlers.turtleDrag, event.btn, args);
        } else {
          callHandlerMap(handlers.mouseDrag, event.btn, args);
        }
      }
      if (event.kind === "release") {
        if (event.target === "turtle") {
          callHandlerMap(handlers.turtleRelease, event.btn, args);
        } else {
          callHandlerMap(handlers.mouseRelease, event.btn, args);
        }
      }
    }
  }

  resetAll();

  return {
    reset: resetAll,
    clear() {
      emit({ type: "clear", bg: screen.bg });
    },
    forward(dist) {
      move(Number(dist) || 0);
    },
    fd(dist) {
      move(Number(dist) || 0);
    },
    back(dist) {
      move(-(Number(dist) || 0));
    },
    backward(dist) {
      move(-(Number(dist) || 0));
    },
    bk(dist) {
      move(-(Number(dist) || 0));
    },
    left(angle) {
      turnLeft(Number(angle) || 0);
    },
    lt(angle) {
      turnLeft(Number(angle) || 0);
    },
    right(angle) {
      turnRight(Number(angle) || 0);
    },
    rt(angle) {
      turnRight(Number(angle) || 0);
    },
    goto(x, y) {
      const [nx, ny] = parsePosition(x, y);
      const x1 = turtle.x;
      const y1 = turtle.y;
      if (turtle.fillActive) {
        turtle.fillPath.push([nx, ny]);
      }
      turtle.x = nx;
      turtle.y = ny;
      emit({
        type: "move",
        x1,
        y1,
        x2: nx,
        y2: ny,
        pen: turtle.penDown,
        color: turtle.penColor,
        width: turtle.penSize,
        heading: turtle.heading,
        visible: turtle.visible,
        speed: turtle.speed,
        mode: screen.mode
      });
    },
    setpos(x, y) {
      this.goto(x, y);
    },
    setposition(x, y) {
      this.goto(x, y);
    },
    setx(x) {
      this.goto(x, turtle.y);
    },
    sety(y) {
      this.goto(turtle.x, y);
    },
    position() {
      return [turtle.x, turtle.y];
    },
    pos() {
      return [turtle.x, turtle.y];
    },
    xcor() {
      return turtle.x;
    },
    ycor() {
      return turtle.y;
    },
    towards(x, y) {
      const [tx, ty] = parsePosition(x, y);
      const dx = tx - turtle.x;
      const dy = ty - turtle.y;
      if (dx === 0 && dy === 0) {
        return turtle.heading;
      }
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      return angleToHeading(angle);
    },
    distance(x, y) {
      const [tx, ty] = parsePosition(x, y);
      return Math.hypot(tx - turtle.x, ty - turtle.y);
    },
    penup() {
      turtle.penDown = false;
    },
    pu() {
      turtle.penDown = false;
    },
    pendown() {
      turtle.penDown = true;
    },
    pd() {
      turtle.penDown = true;
    },
    isdown() {
      return turtle.penDown;
    },
    pen(penState) {
      if (typeof penState === "boolean") {
        turtle.penDown = penState;
      }
      return turtle.penDown;
    },
    color(...args) {
      setColor(args);
    },
    pencolor(...args) {
      if (args.length === 0) {
        return turtle.penColor;
      }
      turtle.penColor = colorToCss(args.length === 1 ? args[0] : args);
    },
    fillcolor(...args) {
      if (args.length === 0) {
        return turtle.fillColor;
      }
      turtle.fillColor = colorToCss(args.length === 1 ? args[0] : args);
    },
    pensize(value) {
      if (value === undefined) {
        return turtle.penSize;
      }
      turtle.penSize = Math.max(1, Number(value) || 1);
    },
    width(value) {
      return this.pensize(value);
    },
    dot(size = 4, color = null) {
      emit({
        type: "dot",
        x: turtle.x,
        y: turtle.y,
        size: Number(size) || 4,
        color: color ? colorToCss(color) : turtle.penColor
      });
    },
    write(text, moveArg = false, align = "center", font = "16px Rubik") {
      emit({
        type: "text",
        x: turtle.x,
        y: turtle.y,
        text: String(text ?? ""),
        align: align,
        font: font,
        color: turtle.penColor
      });
      if (moveArg) {
        move(10);
      }
    },
    begin_fill() {
      beginFill();
    },
    end_fill() {
      endFill();
    },
    filling() {
      return turtle.fillActive;
    },
    home() {
      this.goto(0, 0);
      turtle.heading = 0;
      emitTurtle();
    },
    heading() {
      return turtle.heading;
    },
    setheading(angle) {
      turtle.heading = angleToHeading(Number(angle) || 0);
      emitTurtle();
    },
    seth(angle) {
      this.setheading(angle);
    },
    circle(radius, extent = 360, steps = null) {
      const r = Number(radius) || 0;
      if (!r) {
        return;
      }
      const total = Number(extent) || 0;
      const count = steps ? Math.max(1, Number(steps)) : Math.max(1, Math.round(Math.abs(total) / 10));
      const stepAngle = total / count;
      const stepLen = (2 * Math.PI * Math.abs(r) * Math.abs(stepAngle)) / 360;
      for (let i = 0; i < count; i += 1) {
        if (r >= 0) {
          turnLeft(stepAngle);
        } else {
          turnRight(stepAngle);
        }
        move(stepLen * (r >= 0 ? 1 : -1));
      }
    },
    speed(value) {
      if (value === undefined) {
        return turtle.speed;
      }
      turtle.speed = Math.max(0, Math.min(10, Number(value) || 3));
      emitTurtle();
    },
    hideturtle() {
      turtle.visible = false;
      emitTurtle();
    },
    ht() {
      turtle.visible = false;
      emitTurtle();
    },
    showturtle() {
      turtle.visible = true;
      emitTurtle();
    },
    st() {
      turtle.visible = true;
      emitTurtle();
    },
    isvisible() {
      return turtle.visible;
    },
    shape(name) {
      if (name === undefined) {
        return turtle.shape;
      }
      turtle.shape = String(name);
      emitTurtle();
    },
    shapesize(stretchWid = 1, stretchLen = 1) {
      turtle.stretchWid = Number(stretchWid) || 1;
      turtle.stretchLen = Number(stretchLen) || 1;
      emitTurtle();
    },
    turtlesize(stretchWid = 1, stretchLen = 1) {
      turtle.stretchWid = Number(stretchWid) || 1;
      turtle.stretchLen = Number(stretchLen) || 1;
      emitTurtle();
    },
    bgcolor(color) {
      if (color === undefined) {
        return screen.bg;
      }
      screen.bg = colorToCss(color);
      emit({ type: "clear", bg: screen.bg });
    },
    bgpic(picname) {
      return picname || null;
    },
    tracer(n = null, delay = null) {
      if (n !== null && n !== undefined) {
        screen.tracer = Number(n) || 0;
      }
      if (delay !== null && delay !== undefined) {
        screen.delay = Number(delay) || 0;
      }
      if (screen.tracer !== 0) {
        this.update();
      }
    },
    update() {
      if (!screen.pending.length) {
        return;
      }
      const pending = screen.pending.slice();
      screen.pending = [];
      pending.forEach((evt) => renderTurtleEvent(evt));
    },
    colormode(value) {
      if (value === undefined) {
        return screen.colorMode;
      }
      screen.colorMode = value;
      return screen.colorMode;
    },
    mode(value) {
      if (value === undefined) {
        return screen.mode;
      }
      const next = String(value).toLowerCase();
      if (!["standard", "logo", "world"].includes(next)) {
        return screen.mode;
      }
      screen.mode = next;
      if (next !== "world") {
        screen.world = null;
      }
      emitInit();
      return screen.mode;
    },
    screensize() {
      return [TURTLE_CANVAS_WIDTH, TURTLE_CANVAS_HEIGHT];
    },
    window_width() {
      return TURTLE_CANVAS_WIDTH;
    },
    window_height() {
      return TURTLE_CANVAS_HEIGHT;
    },
    setup() {
      emitInit();
    },
    listen() {
      screen.listen = true;
      turtleInput.listen = true;
      emit({ type: "listen", enabled: true });
    },
    onkey(fun, key) {
      const normalized = key === null || key === undefined ? null : String(toPlain(key));
      setHandler(handlers.keyRelease, normalized, fun, false);
    },
    onkeypress(fun, key = null) {
      if (key === null || key === undefined) {
        setAnyHandler(handlers.keyAnyPress, fun, false);
      } else {
        const normalized = String(toPlain(key));
        setHandler(handlers.keyPress, normalized, fun, false);
      }
    },
    onkeyrelease(fun, key = null) {
      if (key === null || key === undefined) {
        setAnyHandler(handlers.keyAnyRelease, fun, false);
      } else {
        const normalized = String(toPlain(key));
        setHandler(handlers.keyRelease, normalized, fun, false);
      }
    },
    onclick(fun, btn = 1, add = null) {
      const normalized = Number(toPlain(btn)) || 1;
      setHandler(handlers.mouseClick, normalized, fun, add);
    },
    onscreenclick(fun, btn = 1, add = null) {
      const normalized = Number(toPlain(btn)) || 1;
      setHandler(handlers.mouseClick, normalized, fun, add);
    },
    ondrag(fun, btn = 1, add = null) {
      const normalized = Number(toPlain(btn)) || 1;
      setHandler(handlers.turtleDrag, normalized, fun, add);
    },
    onrelease(fun, btn = 1, add = null) {
      const normalized = Number(toPlain(btn)) || 1;
      setHandler(handlers.turtleRelease, normalized, fun, add);
    },
    handleInputEvent,
    _screen: screen,
    _turtle: turtle
  };
}

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

async function init() {
  showGuard(true);
  bindUi();
  state.db = await openDb();
  if (!state.db) {
    showToast("Storage fallback: changes will not persist in this browser.");
  }
  loadSettings();
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

  els.runBtn.addEventListener("click", runActiveFile);
  els.stopBtn.addEventListener("click", stopRun);
  els.clearBtn.addEventListener("click", clearConsole);
  els.shareBtn.addEventListener("click", shareProject);
  els.exportBtn.addEventListener("click", exportProject);
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
        name: "main.py",
        content: "print(\"Привет из MSHP-IDE!\")\n\nname = input(\"Как вас зовут? \")\nprint(\"Привет,\", name)\n"
      }
    ],
    assets: [],
    lastActiveFile: "main.py",
    updatedAt: Date.now()
  };
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
  renderFiles(state.project.files);
  renderAssets(state.project.assets || []);
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
  renderFiles(getCurrentFiles());
  updateTabs();
  updateEditorContent();
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
  if (event.key !== "Tab") {
    return;
  }
  event.preventDefault();
  const tabSize = state.settings.tabSize;
  const spaces = " ".repeat(tabSize);
  const start = els.editor.selectionStart;
  const end = els.editor.selectionEnd;
  const value = els.editor.value;
  els.editor.value = value.slice(0, start) + spaces + value.slice(end);
  els.editor.selectionStart = els.editor.selectionEnd = start + spaces.length;
  onEditorInput();
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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    title: "Создать файл",
    placeholder: "main.py",
    confirmText: "Создать"
  });
  if (!name) {
    return;
  }
  const trimmed = name.trim();
  if (!validateFileName(trimmed)) {
    showToast("Некорректное имя файла.");
    return;
  }
  if (getFileByName(trimmed)) {
    showToast("Файл уже существует.");
    return;
  }
  if (getCurrentFiles().length >= CONFIG.MAX_FILES) {
    showToast("Достигнут лимит файлов.");
    return;
  }

  if (state.mode === "project") {
    state.project.files.push({ name: trimmed, content: "" });
    state.project.lastActiveFile = trimmed;
    scheduleSave();
  } else if (state.mode === "snapshot") {
    const { draft } = state.snapshot;
    draft.overlayFiles[trimmed] = "";
    draft.deletedFiles = draft.deletedFiles.filter((item) => item !== trimmed);
    draft.draftLastActiveFile = trimmed;
    scheduleDraftSave();
  }

  setActiveFile(trimmed);
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
  const nextName = await promptModal({
    title: "Переименовать файл",
    value: state.activeFile,
    confirmText: "Переименовать"
  });
  if (!nextName) {
    return;
  }
  const trimmed = nextName.trim();
  if (trimmed === state.activeFile) {
    return;
  }
  if (!validateFileName(trimmed)) {
    showToast("Некорректное имя файла.");
    return;
  }
  if (getFileByName(trimmed)) {
    showToast("Файл уже существует.");
    return;
  }

  if (state.mode === "project") {
    const file = getFileByName(state.activeFile);
    file.name = trimmed;
    state.project.lastActiveFile = trimmed;
    scheduleSave();
  } else if (state.mode === "snapshot") {
    renameSnapshotFile(state.activeFile, trimmed);
  }

  setActiveFile(trimmed);
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
  const ok = await confirmModal({
    title: "Удалить файл",
    message: `Удалить ${name}?`,
    confirmText: "Удалить"
  });
  if (!ok) {
    return;
  }

  if (state.mode === "project") {
    state.project.files = state.project.files.filter((file) => file.name !== name);
    if (!state.project.files.length) {
      state.project.files.push({ name: "main.py", content: "" });
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
  return Array.from(map.values());
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
    showToast("Шеринг недоступен: слишком много файлов.");
    return false;
  }
  let totalBytes = 0;
  for (const file of files) {
    const bytes = encoder.encode(file.content || "").length;
    if (bytes > CONFIG.MAX_SINGLE_FILE_BYTES) {
      showToast(`Шеринг недоступен: файл ${file.name} слишком большой.`);
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

function submitConsoleInput() {
  const value = els.consoleInput.value;
  els.consoleInput.value = "";
  if (!value && !state.stdinWaiting && !state.stdinResolver) {
    return;
  }
  appendConsole(`${value}\n`, false);
  if (state.stdinResolver) {
    const resolver = state.stdinResolver;
    state.stdinResolver = null;
    state.stdinWaiting = false;
    resolver(value);
    return;
  }
  state.stdinQueue.push(value);
}

function deliverInput() {
  if (!state.stdinQueue.length || !state.stdinResolver) {
    return;
  }
  const value = state.stdinQueue.shift();
  const resolver = state.stdinResolver;
  state.stdinResolver = null;
  state.stdinWaiting = false;
  resolver(value);
}

function skulptInput(prompt) {
  if (prompt) {
    appendConsole(String(prompt), false);
  }
  if (state.stdinQueue.length) {
    return state.stdinQueue.shift();
  }
  state.stdinWaiting = true;
  enableConsoleInput(true);
  return Sk.misceval.promiseToSuspension(
    new Promise((resolve) => {
      state.stdinResolver = resolve;
    })
  );
}

function formatSkulptError(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof Sk !== "undefined" && error instanceof Sk.builtin.BaseException) {
    return error.toString();
  }
  if (error.stack) {
    return error.stack;
  }
  return String(error);
}

function initSkulpt() {
  if (typeof window === "undefined" || typeof window.Sk === "undefined") {
    state.runtimeBlocked = true;
    setGuardMessage("Skulpt не загружен", "Проверьте подключение библиотек Skulpt.");
    return;
  }
  state.runtimeReady = true;
  updateRunStatus("idle");
  showGuard(false);
}

function configureSkulptRuntime(files, assets) {
  state.skulptFiles = buildSkulptFileMap(files);
  state.skulptAssets = buildSkulptAssetMap(assets);
  ensureSkulptTurtleModule();
  if (skulptTurtleRuntime && typeof skulptTurtleRuntime.reset === "function") {
    skulptTurtleRuntime.reset();
  }
  Sk.inBrowser = false;
  Sk.configure({
    output: (text) => appendConsole(text, false),
    read: skulptRead,
    inputfun: skulptInput,
    inputfunTakesPrompt: true,
    execLimit: CONFIG.RUN_TIMEOUT_MS,
    yieldLimit: CONFIG.RUN_TIMEOUT_MS,
    syspath: ["/project"]
  });
  Sk.execLimit = CONFIG.RUN_TIMEOUT_MS;
  Sk.execStart = Date.now();
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
    map.set(`/project/${name}`, decodeAssetBytes(data));
    map.set(name, decodeAssetBytes(data));
  });
  return map;
}

function decodeAssetBytes(bytes) {
  if (!bytes || !bytes.length) {
    return "";
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

function ensureSkulptTurtleModule() {
  if (typeof Sk === "undefined") {
    return;
  }
  if (!Sk.builtinFiles) {
    Sk.builtinFiles = { files: {} };
  }
  if (!Sk.builtinFiles["files"]) {
    Sk.builtinFiles["files"] = {};
  }
  if (Sk.builtinFiles["files"]["src/lib/turtle.js"]) {
    return;
  }
  Sk.builtinFiles["files"]["src/lib/turtle.js"] = `
var $builtinmodule = function(name) {
  var mod = {};
  mod.__name__ = new Sk.builtin.str('turtle');
  var runtime = (typeof window !== 'undefined' && window.__mshpSkulptTurtle) ? window.__mshpSkulptTurtle : null;

  function toJs(value) {
    return Sk.ffi.remapToJs(value);
  }

  function wrapVoid(method) {
    return new Sk.builtin.func(function() {
      var args = Array.prototype.slice.call(arguments).map(toJs);
      if (runtime && runtime[method]) {
        runtime[method].apply(runtime, args);
      }
      return Sk.builtin.none.none$;
    });
  }

  function wrapValue(method) {
    return new Sk.builtin.func(function() {
      var args = Array.prototype.slice.call(arguments).map(toJs);
      if (runtime && runtime[method]) {
        return Sk.ffi.remapToPy(runtime[method].apply(runtime, args));
      }
      return Sk.builtin.none.none$;
    });
  }

  function wrapCallback(method) {
    return new Sk.builtin.func(function() {
      if (!runtime || !runtime[method]) {
        return Sk.builtin.none.none$;
      }
      var args = Array.prototype.slice.call(arguments);
      runtime[method].apply(runtime, args);
      return Sk.builtin.none.none$;
    });
  }

  mod.forward = wrapVoid('forward');
  mod.fd = wrapVoid('fd');
  mod.back = wrapVoid('back');
  mod.backward = wrapVoid('backward');
  mod.bk = wrapVoid('bk');
  mod.left = wrapVoid('left');
  mod.lt = wrapVoid('lt');
  mod.right = wrapVoid('right');
  mod.rt = wrapVoid('rt');
  mod.goto = wrapVoid('goto');
  mod.setpos = wrapVoid('setpos');
  mod.setposition = wrapVoid('setposition');
  mod.setx = wrapVoid('setx');
  mod.sety = wrapVoid('sety');
  mod.position = wrapValue('position');
  mod.pos = wrapValue('pos');
  mod.xcor = wrapValue('xcor');
  mod.ycor = wrapValue('ycor');
  mod.towards = wrapValue('towards');
  mod.distance = wrapValue('distance');
  mod.penup = wrapVoid('penup');
  mod.pu = wrapVoid('pu');
  mod.pendown = wrapVoid('pendown');
  mod.pd = wrapVoid('pd');
  mod.isdown = wrapValue('isdown');
  mod.pen = wrapValue('pen');
  mod.color = wrapVoid('color');
  mod.pencolor = wrapValue('pencolor');
  mod.fillcolor = wrapValue('fillcolor');
  mod.pensize = wrapValue('pensize');
  mod.width = wrapValue('width');
  mod.dot = wrapVoid('dot');
  mod.write = wrapVoid('write');
  mod.clear = wrapVoid('clear');
  mod.reset = wrapVoid('reset');
  mod.home = wrapVoid('home');
  mod.heading = wrapValue('heading');
  mod.setheading = wrapVoid('setheading');
  mod.seth = wrapVoid('seth');
  mod.circle = wrapVoid('circle');
  mod.begin_fill = wrapVoid('begin_fill');
  mod.end_fill = wrapVoid('end_fill');
  mod.filling = wrapValue('filling');
  mod.speed = wrapValue('speed');
  mod.hideturtle = wrapVoid('hideturtle');
  mod.ht = wrapVoid('ht');
  mod.showturtle = wrapVoid('showturtle');
  mod.st = wrapVoid('st');
  mod.isvisible = wrapValue('isvisible');
  mod.shape = wrapValue('shape');
  mod.shapesize = wrapVoid('shapesize');
  mod.turtlesize = wrapVoid('turtlesize');
  mod.bgcolor = wrapValue('bgcolor');
  mod.bgpic = wrapValue('bgpic');
  mod.tracer = wrapVoid('tracer');
  mod.update = wrapVoid('update');
  mod.colormode = wrapValue('colormode');
  mod.mode = wrapValue('mode');
  mod.screensize = wrapValue('screensize');
  mod.window_width = wrapValue('window_width');
  mod.window_height = wrapValue('window_height');
  mod.setup = wrapVoid('setup');
  mod.listen = wrapVoid('listen');
  mod.onkey = wrapCallback('onkey');
  mod.onkeypress = wrapCallback('onkeypress');
  mod.onkeyrelease = wrapCallback('onkeyrelease');
  mod.onclick = wrapCallback('onclick');
  mod.onscreenclick = wrapCallback('onscreenclick');
  mod.ondrag = wrapCallback('ondrag');
  mod.onrelease = wrapCallback('onrelease');

  mod.Screen = new Sk.builtin.func(function() { return mod; });
  mod.Turtle = new Sk.builtin.func(function() { return mod; });

  return mod;
};
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

async function runActiveFile() {
  if (state.runtimeBlocked) {
    showGuard(true);
    return;
  }
  if (!state.runtimeReady) {
    showGuard(true);
    return;
  }
  const entryName = getActiveTabName() || state.activeFile;
  const file = getFileByName(entryName);
  if (!file) {
    showToast("No active file.");
    return;
  }
  clearConsole();
  clearTurtleCanvas();
  updateRunStatus("running");

  state.stdinQueue = [];
  state.stdinWaiting = false;
  state.stdinResolver = null;

  const files = getCurrentFiles();
  const assets = state.mode === "project" ? await loadAssets() : [];

  configureSkulptRuntime(files, assets);
  const runToken = state.runToken + 1;
  state.runToken = runToken;
  els.stopBtn.disabled = false;
  enableConsoleInput(true);

  if (state.runTimeout) {
    clearTimeout(state.runTimeout);
  }
  state.runTimeout = setTimeout(() => {
    softInterrupt("Time limit exceeded.");
    stopRun();
  }, CONFIG.RUN_TIMEOUT_MS + 200);

  try {
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
    updateRunStatus("error");
  } finally {
    if (state.runToken === runToken) {
      enableConsoleInput(false);
      els.stopBtn.disabled = true;
      state.stdinResolver = null;
      state.stdinWaiting = false;
      state.stdinQueue = [];
    }
    if (state.runTimeout) {
      clearTimeout(state.runTimeout);
      state.runTimeout = null;
    }
  }
}

function stopRun() {
  state.runToken += 1;
  softInterrupt("Stopped by user.");
  hardStop();
}

function softInterrupt(message) {
  appendConsole(`\n${message}\n`, true);
}

function hardStop() {
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
  state.stdinWaiting = false;
  state.stdinResolver = null;
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
      data: buffer
    });
  }
  return assets;
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
  renderer.drawCtx.fillStyle = renderer.bg;
  renderer.drawCtx.fillRect(0, 0, fixedWidth, fixedHeight);
  if (renderer.strokeCtx) {
    renderer.strokeCtx.clearRect(0, 0, fixedWidth, fixedHeight);
  }
  renderer.queue = [];
  renderer.current = null;
  renderer.animating = false;
  renderer.fillActive = false;
  renderer.turtle = {
    x: 0,
    y: 0,
    heading: 0,
    visible: true,
    penSize: 2,
    shape: "classic",
    stretchWid: 1,
    stretchLen: 1
  };
  drawTurtleFrame(renderer);
}

function clearTurtleLayer(bg) {
  const renderer = getTurtleRenderer();
  renderer.bg = bg || renderer.bg;
  renderer.drawCtx.fillStyle = renderer.bg;
  renderer.drawCtx.fillRect(0, 0, renderer.drawCanvas.width, renderer.drawCanvas.height);
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
  if (!event._started) {
    event._started = true;
    event._startTime = timestamp;
    event._lastX = event.x1;
    event._lastY = event.y1;
    event._heading = Number.isFinite(event.heading)
      ? event.heading
      : headingFromMove(event, renderer.turtle.heading, renderer.mode);
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
    const ctx = renderer.fillActive && renderer.strokeCtx ? renderer.strokeCtx : renderer.drawCtx;
    ctx.strokeStyle = event.color || "#1c6bff";
    ctx.lineWidth = event.width || 2;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  renderer.turtle.x = x;
  renderer.turtle.y = y;
  renderer.turtle.heading = event._heading;
  renderer.turtle.visible = event.visible !== false;
  if (event.width) {
    renderer.turtle.penSize = event.width;
  }

  event._lastX = x;
  event._lastY = y;
  drawTurtleFrame(renderer);

  return t >= 1;
}

function animateTurn(renderer, event, timestamp) {
  if (!event._started) {
    event._started = true;
    event._startTime = timestamp;
    event._from = renderer.turtle.heading;
    event._to = Number.isFinite(event.heading) ? event.heading : renderer.turtle.heading;
    event._duration = TURTLE_MIN_STEP_MS * 2;
  }

  const t = Math.min(1, (timestamp - event._startTime) / event._duration);
  const delta = ((event._to - event._from + 540) % 360) - 180;
  renderer.turtle.heading = event._from + delta * t;
  if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
    renderer.turtle.x = event.x;
    renderer.turtle.y = event.y;
  }
  if (event.visible !== undefined) {
    renderer.turtle.visible = event.visible;
  }
  drawTurtleFrame(renderer);
  return t >= 1;
}

function applyTurtleEvent(renderer, event) {
  if (event.type === "fill_start") {
    renderer.fillActive = true;
    if (renderer.strokeCtx) {
      renderer.strokeCtx.clearRect(0, 0, renderer.strokeCanvas.width, renderer.strokeCanvas.height);
    }
    return;
  }

  if (event.type === "fill_end") {
    renderer.fillActive = false;
    if (renderer.strokeCtx) {
      renderer.strokeCtx.clearRect(0, 0, renderer.strokeCanvas.width, renderer.strokeCanvas.height);
    }
    drawTurtleFrame(renderer);
    return;
  }

  if (event.type === "turtle") {
    if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
      renderer.turtle.x = event.x;
      renderer.turtle.y = event.y;
    }
    if (Number.isFinite(event.heading)) {
      renderer.turtle.heading = event.heading;
    }
    if (event.visible !== undefined) {
      renderer.turtle.visible = event.visible;
    }
    if (event.shape) {
      renderer.turtle.shape = String(event.shape);
    }
    if (Array.isArray(event.stretch)) {
      const wid = Number(event.stretch[0]);
      const len = Number(event.stretch[1]);
      if (Number.isFinite(wid)) {
        renderer.turtle.stretchWid = wid;
      }
      if (Number.isFinite(len)) {
        renderer.turtle.stretchLen = len;
      }
    }
    drawTurtleFrame(renderer);
    return;
  }

  if (event.type === "dot") {
    if (Number.isFinite(event.x) && Number.isFinite(event.y)) {
      renderer.turtle.x = event.x;
      renderer.turtle.y = event.y;
    }
    const size = event.size || 4;
    const pos = toCanvasCoords(renderer, event.x || 0, event.y || 0);
    const ctx = renderer.fillActive && renderer.strokeCtx ? renderer.strokeCtx : renderer.drawCtx;
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
    renderer.fillActive = false;
    drawTurtleFrame(renderer);
    return;
  }

  if (event.type === "text") {
    const pos = toCanvasCoords(renderer, event.x || 0, event.y || 0);
    const ctx = renderer.fillActive && renderer.strokeCtx ? renderer.strokeCtx : renderer.drawCtx;
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
  drawTurtleIcon(renderer);
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

function drawTurtleIcon(renderer) {
  if (!renderer.turtle.visible) {
    return;
  }
  const pos = toCanvasCoords(renderer, renderer.turtle.x, renderer.turtle.y);
  const baseSize = 10 + Math.min(6, renderer.turtle.penSize || 2);
  const stretchLen = Number.isFinite(renderer.turtle.stretchLen) ? renderer.turtle.stretchLen : 1;
  const stretchWid = Number.isFinite(renderer.turtle.stretchWid) ? renderer.turtle.stretchWid : 1;
  const sizeX = baseSize * Math.max(0.2, stretchLen);
  const sizeY = baseSize * Math.max(0.2, stretchWid);
  const heading = displayHeading(renderer, renderer.turtle.heading);
  const ctx = renderer.ctx;
  const shape = String(renderer.turtle.shape || "classic").toLowerCase();
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate((-heading * Math.PI) / 180);
  ctx.fillStyle = "#20b46a";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
  ctx.lineWidth = 1;
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
  if (!renderer.turtle.visible) {
    return false;
  }
  const pos = toCanvasCoords(renderer, renderer.turtle.x, renderer.turtle.y);
  const size = 12 + Math.min(8, renderer.turtle.penSize || 2);
  const dx = x - pos.x;
  const dy = y - pos.y;
  return Math.hypot(dx, dy) <= size;
}

function sendTurtleInputEvent(event) {
  if (!window.__mshpSkulptTurtle) {
    return;
  }
  window.__mshpSkulptTurtle.handleInputEvent(event);
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
    const safeTitle = escapeHtml(String(title || ""));
    const safePlaceholder = escapeHtml(String(placeholder || ""));
    const safeValue = escapeHtml(String(value || ""));
    const safeConfirm = escapeHtml(String(confirmText || "OK"));
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
    const safeTitle = escapeHtml(String(title || ""));
    const safeMessage = escapeHtml(String(message || ""));
    const safeConfirm = escapeHtml(String(confirmText || "Confirm"));
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
