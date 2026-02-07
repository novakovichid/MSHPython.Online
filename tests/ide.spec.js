const { test, expect } = require("@playwright/test");
const { validCases: validCodeCases, invalidCases: invalidCodeCases } = require("./fixtures/editor-code-cases.cjs");

async function openProject(page, id) {
  await page.goto(`/#/p/${id}`);
  await page.waitForSelector("#editor", { state: "visible" });
  await page.waitForFunction(() => document.querySelector("#guard")?.classList.contains("hidden"), { timeout: 90000 });
}

function base64UrlEncodeUtf8(text) {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function openSnapshot(page, snapshot, shareId = `share-${Date.now()}`) {
  const payloadJson = JSON.stringify(snapshot);
  const payload = `u.${base64UrlEncodeUtf8(payloadJson)}`;
  await page.goto(`/#/s/${shareId}?p=${payload}`);
  await page.waitForSelector("#editor", { state: "visible" });
  await page.waitForFunction(() => document.querySelector("#guard")?.classList.contains("hidden"), { timeout: 90000 });
}

async function runCode(page, code) {
  await page.fill("#editor", code);
  await page.click("#run-btn");
  await page.waitForTimeout(500);
}

async function runCodeExpectError(page, code, pattern) {
  await page.fill("#editor", code);
  await page.click("#run-btn");
  await expect(page.locator("#run-status")).toHaveText("Ошибка", { timeout: 15000 });
  if (pattern) {
    await expect(page.locator("#console-output")).toContainText(pattern);
  }
  await expect(page.locator("#console-output .console-error")).toHaveCount(1);
}

async function runCodeExpectDone(page, code, outputPattern) {
  await page.fill("#editor", code);
  await page.click("#run-btn");
  await expect(page.locator("#run-status")).toHaveText("Готово", { timeout: 15000 });
  if (outputPattern) {
    await expect(page.locator("#console-output")).toContainText(outputPattern);
  }
}

function extractLastLineNumber(text) {
  const matches = [...String(text || "").matchAll(/\bline\s+(\d+)\b/gi)];
  if (!matches.length) {
    return null;
  }
  return Number(matches[matches.length - 1][1]);
}

async function getEditorSyncMetrics(page, { scrollToBottom = true } = {}) {
  return page.evaluate(async ({ scrollToBottom: shouldScroll }) => {
    const editor = document.querySelector("#editor");
    const highlight = document.querySelector("#editor-highlight");
    const numbers = document.querySelector("#line-numbers");
    const numbersContent = document.querySelector("#line-numbers .line-numbers-content");
    if (!editor || !highlight || !numbers) {
      return null;
    }
    const readTranslate = (element) => {
      if (!element) {
        return { x: 0, y: 0 };
      }
      const transform = getComputedStyle(element).transform;
      if (!transform || transform === "none") {
        return { x: 0, y: 0 };
      }
      const matrix = new DOMMatrixReadOnly(transform);
      return { x: matrix.m41, y: matrix.m42 };
    };
    if (shouldScroll) {
      editor.scrollTop = editor.scrollHeight;
      editor.scrollLeft = Math.max(0, editor.scrollWidth - editor.clientWidth);
      editor.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    await new Promise((resolve) => {
      const raf = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
      raf(() => raf(resolve));
    });
    const editorStyle = getComputedStyle(editor);
    const highlightStyle = getComputedStyle(highlight);
    const highlightShift = readTranslate(highlight);
    const numbersShift = readTranslate(numbersContent || numbers);
    const editorRect = editor.getBoundingClientRect();
    const highlightRect = highlight.getBoundingClientRect();
    return {
      editorScrollTop: editor.scrollTop,
      highlightScrollTop: -highlightShift.y,
      numbersScrollTop: -numbersShift.y,
      editorScrollLeft: editor.scrollLeft,
      highlightScrollLeft: -highlightShift.x,
      editorLineHeight: editorStyle.lineHeight,
      highlightLineHeight: highlightStyle.lineHeight,
      editorWhiteSpace: editorStyle.whiteSpace,
      highlightWhiteSpace: highlightStyle.whiteSpace,
      scrollHeightDelta: Math.abs(editor.scrollHeight - highlight.scrollHeight),
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd,
      editorHeight: editorRect.height,
      highlightHeight: highlightRect.height,
      editorToHighlightTopDelta: Math.abs(editorRect.top - highlightRect.top),
      editorToHighlightLeftDelta: Math.abs(editorRect.left - highlightRect.left)
    };
  }, { scrollToBottom });
}

function expectEditorLayersInSync(metrics, tolerance = 1) {
  expect(metrics).not.toBeNull();
  expect(Math.abs(metrics.highlightScrollTop - metrics.editorScrollTop)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(metrics.numbersScrollTop - metrics.editorScrollTop)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(metrics.highlightScrollLeft - metrics.editorScrollLeft)).toBeLessThanOrEqual(tolerance);
  expect(metrics.editorLineHeight).toBe(metrics.highlightLineHeight);
  expect(metrics.editorWhiteSpace).toBe(metrics.highlightWhiteSpace);
}

function makeLongCode({ lines = 120, token = "long_token", extraWidth = 14 } = {}) {
  const chunk = `${token}_`.repeat(extraWidth);
  return Array.from(
    { length: lines },
    (_, i) => `for idx_${i} in range(2): print("line_${i}", "${chunk}")`
  ).join("\n");
}

async function openFreshProjectWithLongCode(page, label, options = {}) {
  await openProject(page, `${label}-${Date.now()}`);
  await page.fill("#editor", makeLongCode(options));
}

async function getEditorFontMetrics(page) {
  return page.evaluate(() => {
    const editor = document.querySelector("#editor");
    const highlight = document.querySelector("#editor-highlight");
    const numbers = document.querySelector("#line-numbers");
    if (!editor || !highlight || !numbers) {
      return null;
    }
    const editorStyle = getComputedStyle(editor);
    const highlightStyle = getComputedStyle(highlight);
    const numbersStyle = getComputedStyle(numbers);
    return {
      editorFontSize: Number.parseFloat(editorStyle.fontSize),
      highlightFontSize: Number.parseFloat(highlightStyle.fontSize),
      numbersFontSize: Number.parseFloat(numbersStyle.fontSize),
      editorLineHeight: editorStyle.lineHeight,
      highlightLineHeight: highlightStyle.lineHeight,
      numbersLineHeight: numbersStyle.lineHeight
    };
  });
}

async function getVisibleIdeCards(page) {
  return page.evaluate(() => {
    const cards = [
      { key: "modules", el: document.querySelector("#sidebar") },
      { key: "editor", el: document.querySelector("#editor-pane") },
      { key: "console", el: document.querySelector("#console-pane") },
      { key: "turtle", el: document.querySelector("#turtle-pane") }
    ];
    return cards
      .filter(({ el }) => {
        if (!el || el.classList.contains("hidden")) {
          return false;
        }
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map(({ key }) => key);
  });
}

test.describe.configure({ mode: "serial" });

test("stdin works via console input", async ({ page }) => {
  await openProject(page, `stdin-${Date.now()}`);
  const code = [
    'name = input("Name? ")',
    'print("Hello,", name)'
  ].join("\n");
  await page.fill("#editor", code);
  await page.click("#run-btn");
  await page.waitForFunction(() => document.querySelector("#console-input").disabled === false);
  await page.fill("#console-input", "Vasya");
  await page.click("#console-send");
  await page.waitForFunction(() => document.querySelector("#console-output")?.textContent?.includes("Hello, Vasya"));
  const output = await page.textContent("#console-output");
  expect(output).toContain("Hello, Vasya");
  expect(output).not.toContain("WebAssembly stack switching not supported");
});

test("line numbers match editor metrics", async ({ page }) => {
  await openProject(page, `lines-${Date.now()}`);
  const lines = Array.from({ length: 35 }, (_, i) => `print(${i + 1})`).join("\n");
  await page.fill("#editor", lines);
  const metrics = await page.evaluate(() => {
    const editor = document.querySelector("#editor");
    const numbers = document.querySelector("#line-numbers");
    const editorStyle = window.getComputedStyle(editor);
    const numberStyle = window.getComputedStyle(numbers);
    const lineCount = (editor.value || "").split("\n").length;
    const numberLines = (numbers.textContent || "").split("\n").length;
    return {
      lineCount,
      numberLines,
      editorFontSize: editorStyle.fontSize,
      numbersFontSize: numberStyle.fontSize,
      editorLineHeight: editorStyle.lineHeight,
      numbersLineHeight: numberStyle.lineHeight
    };
  });
  expect(metrics.numberLines).toBe(metrics.lineCount);
  expect(metrics.numbersFontSize).toBe(metrics.editorFontSize);
  expect(metrics.numbersLineHeight).toBe(metrics.editorLineHeight);
});

test("editor font controls change font size and keep layers aligned", async ({ page }) => {
  await openProject(page, `font-controls-${Date.now()}`);
  await expect(page.locator("#font-dec-btn")).toBeVisible();
  await expect(page.locator("#font-inc-btn")).toBeVisible();
  const base = await getEditorFontMetrics(page);
  expect(base).not.toBeNull();

  await page.click("#font-inc-btn");
  const afterInc = await getEditorFontMetrics(page);
  expect(afterInc.editorFontSize).toBe(base.editorFontSize + 1);
  expect(afterInc.highlightFontSize).toBe(afterInc.editorFontSize);
  expect(afterInc.numbersFontSize).toBe(afterInc.editorFontSize);
  expect(afterInc.highlightLineHeight).toBe(afterInc.editorLineHeight);
  expect(afterInc.numbersLineHeight).toBe(afterInc.editorLineHeight);

  await page.click("#font-dec-btn");
  const afterDec = await getEditorFontMetrics(page);
  expect(afterDec.editorFontSize).toBe(base.editorFontSize);
  expect(afterDec.highlightFontSize).toBe(afterDec.editorFontSize);
  expect(afterDec.numbersFontSize).toBe(afterDec.editorFontSize);

  const sync = await getEditorSyncMetrics(page);
  expectEditorLayersInSync(sync);
});

test("editor font size persists after reload", async ({ page }) => {
  await openProject(page, `font-persist-${Date.now()}`);
  const base = await getEditorFontMetrics(page);
  await page.click("#font-inc-btn");
  await page.reload();
  await page.waitForSelector("#editor", { state: "visible" });
  const afterReload = await getEditorFontMetrics(page);
  expect(afterReload.editorFontSize).toBe(base.editorFontSize + 1);
  expect(afterReload.highlightFontSize).toBe(afterReload.editorFontSize);
  expect(afterReload.numbersFontSize).toBe(afterReload.editorFontSize);
});

test("editor font controls respect bounds", async ({ page }) => {
  await openProject(page, `font-bounds-${Date.now()}`);
  for (let i = 0; i < 40; i += 1) {
    const isDisabled = await page.locator("#font-dec-btn").isDisabled();
    if (isDisabled) {
      break;
    }
    await page.click("#font-dec-btn");
  }
  let metrics = await getEditorFontMetrics(page);
  expect(metrics.editorFontSize).toBe(12);
  await expect(page.locator("#font-dec-btn")).toBeDisabled();

  for (let i = 0; i < 40; i += 1) {
    const isDisabled = await page.locator("#font-inc-btn").isDisabled();
    if (isDisabled) {
      break;
    }
    await page.click("#font-inc-btn");
  }
  metrics = await getEditorFontMetrics(page);
  expect(metrics.editorFontSize).toBe(20);
  await expect(page.locator("#font-inc-btn")).toBeDisabled();
});

test("cursor stays aligned on long content", async ({ page }) => {
  await openProject(page, `cursor-long-${Date.now()}`);
  const longChunk = "x".repeat(90);
  const code = Array.from(
    { length: 80 },
    (_, i) => `for item_${i} in range(3): print(item_${i}, "${longChunk}")`
  ).join("\n");
  await page.fill("#editor", code);
  const metrics = await getEditorSyncMetrics(page);
  expectEditorLayersInSync(metrics);
});

test("cursor stays aligned after viewport shrink", async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 820 });
  await openProject(page, `cursor-shrink-${Date.now()}`);
  const longChunk = "very_long_token_".repeat(18);
  const code = Array.from(
    { length: 50 },
    (_, i) => `print("line_${i}", "${longChunk}")`
  ).join("\n");
  await page.fill("#editor", code);
  await page.setViewportSize({ width: 700, height: 820 });
  await page.waitForTimeout(150);
  const metrics = await getEditorSyncMetrics(page);
  expectEditorLayersInSync(metrics);
});

test.describe("editor interaction regressions", () => {
  test("[editor-regression] slow wheel scroll keeps layer sync", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-wheel-slow");
    await page.locator("#editor").click();
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.wheel(0, 80);
      await page.waitForTimeout(20);
    }
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.editorScrollTop).toBeGreaterThan(0);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] fast wheel down keeps layer sync", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-wheel-fast");
    await page.locator("#editor").click();
    for (let i = 0; i < 5; i += 1) {
      await page.mouse.wheel(0, 420);
    }
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.editorScrollTop).toBeGreaterThan(300);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] fast wheel up after deep scroll keeps sync", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-wheel-up");
    await page.evaluate(() => {
      const editor = document.querySelector("#editor");
      editor.scrollTop = editor.scrollHeight;
      editor.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.locator("#editor").click();
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -340);
    }
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.editorScrollTop).toBeGreaterThanOrEqual(0);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] drag-select down with autoscroll keeps sync", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-drag-down");
    const editor = page.locator("#editor");
    const box = await editor.boundingBox();
    await page.mouse.move(box.x + 24, box.y + 24);
    await page.mouse.down();
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.move(box.x + 36, box.y + box.height - 6, { steps: 3 });
      await page.mouse.wheel(0, 210);
    }
    await page.mouse.up();
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.selectionEnd).toBeGreaterThan(metrics.selectionStart);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] drag-select up with autoscroll keeps sync", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-drag-up");
    await page.evaluate(() => {
      const editor = document.querySelector("#editor");
      editor.scrollTop = editor.scrollHeight;
      editor.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const editor = page.locator("#editor");
    const box = await editor.boundingBox();
    await page.mouse.move(box.x + 32, box.y + box.height - 12);
    await page.mouse.down();
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.move(box.x + 24, box.y + 12, { steps: 3 });
      await page.mouse.wheel(0, -210);
    }
    await page.mouse.up();
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.selectionEnd).toBeGreaterThan(metrics.selectionStart);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] shift+arrow selection after scroll keeps sync", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-shift-arrows");
    await page.evaluate(() => {
      const editor = document.querySelector("#editor");
      editor.scrollTop = 800;
      editor.dispatchEvent(new Event("scroll", { bubbles: true }));
      editor.selectionStart = editor.selectionEnd = Math.min(editor.value.length, 4000);
      editor.focus();
    });
    await page.keyboard.down("Shift");
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.up("Shift");
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.selectionEnd).toBeGreaterThan(metrics.selectionStart);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] Ctrl+L line selection after scroll keeps sync", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-ctrl-l");
    await page.locator("#editor").click();
    await page.mouse.wheel(0, 900);
    await page.keyboard.press("Control+l");
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.selectionEnd).toBeGreaterThan(metrics.selectionStart);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] horizontal scroll and selection keep sync", async ({ page }) => {
    await openProject(page, `editor-horizontal-${Date.now()}`);
    const longLine = `print("${"horizontal_scroll_".repeat(120)}")`;
    const code = Array.from({ length: 35 }, () => longLine).join("\n");
    await page.fill("#editor", code);
    await page.evaluate(() => {
      const editor = document.querySelector("#editor");
      editor.scrollLeft = 900;
      editor.selectionStart = 10;
      editor.selectionEnd = 180;
      editor.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.editorScrollLeft).toBeGreaterThan(0);
    expect(metrics.selectionEnd).toBeGreaterThan(metrics.selectionStart);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] resize during deep scroll keeps sync", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 860 });
    await openFreshProjectWithLongCode(page, "editor-resize-during-scroll");
    await page.evaluate(() => {
      const editor = document.querySelector("#editor");
      editor.scrollTop = editor.scrollHeight;
      editor.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.setViewportSize({ width: 980, height: 760 });
    await page.waitForTimeout(140);
    await page.setViewportSize({ width: 1160, height: 860 });
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] font change + scroll + selection stays aligned", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-font-scroll");
    await page.click("#font-inc-btn");
    await page.click("#font-inc-btn");
    await page.locator("#editor").click();
    await page.mouse.wheel(0, 700);
    await page.keyboard.press("ControlOrMeta+a");
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.selectionEnd).toBeGreaterThan(metrics.selectionStart);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] switch file and return keeps editor layers in sync", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-file-switch");
    await page.click("#file-duplicate");
    await expect(page.locator("#file-list .file-item")).toHaveCount(2);
    await page.locator("#file-list .file-item").nth(1).click();
    await page.locator("#file-list .file-item").nth(0).click();
    await page.locator("#editor").click();
    await page.mouse.wheel(0, 500);
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] mobile editor card roundtrip keeps sync", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFreshProjectWithLongCode(page, "editor-mobile-roundtrip");
    await page.mouse.wheel(0, 500);
    await page.click('#mobile-nav [data-card="console"]');
    await page.click('#mobile-nav [data-card="editor"]');
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] tablet layout with selection keeps line alignment", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openFreshProjectWithLongCode(page, "editor-tablet");
    await page.locator("#editor").click();
    await page.mouse.wheel(0, 620);
    await page.keyboard.press("Control+l");
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.selectionEnd).toBeGreaterThan(metrics.selectionStart);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] large paste and immediate selection do not desync layers", async ({ page }) => {
    await openProject(page, `editor-large-paste-${Date.now()}`);
    const hugeCode = makeLongCode({ lines: 260, token: "paste_block", extraWidth: 22 });
    await page.fill("#editor", hugeCode);
    await page.locator("#editor").click();
    await page.keyboard.press("ControlOrMeta+a");
    const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
    expect(metrics.selectionStart).toBe(0);
    expect(metrics.selectionEnd).toBe(hugeCode.length);
    expectEditorLayersInSync(metrics);
  });

  test("[editor-regression] repeated scroll/select cycles avoid drift accumulation", async ({ page }) => {
    await openFreshProjectWithLongCode(page, "editor-stress-cycles");
    for (let i = 0; i < 8; i += 1) {
      await page.locator("#editor").click();
      await page.mouse.wheel(0, i % 2 === 0 ? 300 : -240);
      await page.keyboard.press("Control+l");
      await page.keyboard.down("Shift");
      await page.keyboard.press(i % 2 === 0 ? "ArrowDown" : "ArrowUp");
      await page.keyboard.up("Shift");
      const metrics = await getEditorSyncMetrics(page, { scrollToBottom: false });
      expectEditorLayersInSync(metrics);
    }
  });
});

test("tablet layout prioritizes editor/console/turtle", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openProject(page, `tablet-layout-${Date.now()}`);
  await runCode(page, 'import turtle\n\nturtle.shape("turtle")\n');
  await page.waitForTimeout(300);
  const metrics = await page.evaluate(() => {
    const sidebar = document.querySelector("#sidebar");
    const editor = document.querySelector("#editor-pane");
    const turtle = document.querySelector("#turtle-pane");
    const consolePane = document.querySelector("#console-pane");
    const actionBtn = document.querySelector(".top-actions .btn");
    const panelActionBtn = document.querySelector(".panel-actions .btn");
    if (!sidebar || !editor || !turtle || !consolePane || !actionBtn || !panelActionBtn) {
      return null;
    }
    const sb = sidebar.getBoundingClientRect();
    const ed = editor.getBoundingClientRect();
    const tt = turtle.getBoundingClientRect();
    const cp = consolePane.getBoundingClientRect();
    return {
      editorWidth: ed.width,
      sidebarWidth: sb.width,
      turtleHeight: tt.height,
      consoleHeight: cp.height,
      topActionFontSize: Number.parseFloat(getComputedStyle(actionBtn).fontSize),
      panelActionFontSize: Number.parseFloat(getComputedStyle(panelActionBtn).fontSize)
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics.editorWidth).toBeGreaterThan(metrics.sidebarWidth);
  expect(metrics.turtleHeight).toBeGreaterThan(140);
  expect(metrics.consoleHeight).toBeGreaterThan(120);
  expect(metrics.topActionFontSize).toBeLessThanOrEqual(11.5);
  expect(metrics.panelActionFontSize).toBeLessThanOrEqual(11.5);
});

test("tablet module action buttons keep readable text", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openProject(page, `tablet-actions-${Date.now()}`);
  const readability = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".panel-actions-files .btn.small"));
    if (!buttons.length) {
      return null;
    }
    return buttons.map((button) => ({
      text: button.textContent.trim(),
      whiteSpace: getComputedStyle(button).whiteSpace,
      textOverflow: getComputedStyle(button).textOverflow,
      overflowX: getComputedStyle(button).overflowX
    }));
  });
  expect(readability).not.toBeNull();
  expect(readability.every((entry) => entry.text.length > 0)).toBe(true);
  expect(readability.every((entry) => entry.whiteSpace !== "nowrap")).toBe(true);
  expect(readability.every((entry) => entry.textOverflow !== "ellipsis")).toBe(true);
  expect(readability.every((entry) => entry.overflowX !== "hidden")).toBe(true);
});

test("tablet hides hotkeys and uses compact console input hint", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openProject(page, `tablet-hint-hotkeys-${Date.now()}`);
  await expect(page.locator("#hotkeys-btn")).toBeHidden();
  await expect(page.locator("#console-input")).toHaveAttribute(
    "placeholder",
    "Введите input и нажмите «Отправить»"
  );
});

test("mobile default card is editor", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-default-${Date.now()}`);
  await expect(page.locator("#mobile-nav")).toBeVisible();
  const visibleCards = await getVisibleIdeCards(page);
  expect(visibleCards).toEqual(["editor"]);
  await expect(page.locator('#mobile-nav [data-card="editor"]')).toHaveAttribute("aria-pressed", "true");
});

test("mobile header is compact and uses icon actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-header-${Date.now()}`);
  await expect(page.locator("#share-btn")).toHaveText("🔗");
  await expect(page.locator("#export-btn")).toHaveText("⬆️");
  await expect(page.locator("#import-btn")).toHaveText("⬇️");
  await expect(page.locator("#restart-ide-inline")).toBeVisible();
  await expect(page.locator(".restart-ide-floating-left")).toBeHidden();
  const hiddenMeta = await page.evaluate(() => {
    const mode = document.querySelector("#project-mode");
    const save = document.querySelector("#save-indicator");
    const rename = document.querySelector("#rename-btn");
    if (!mode || !save || !rename) {
      return false;
    }
    const hidden = (el) => getComputedStyle(el).display === "none";
    return hidden(mode) && hidden(save) && hidden(rename);
  });
  expect(hiddenMeta).toBe(true);
});

test("mobile shows one card at a time with bottom nav", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-cards-${Date.now()}`);
  await expect(page.locator("#mobile-nav")).toBeVisible();
  await page.click('#mobile-nav [data-card="modules"]');
  let visibleCards = await getVisibleIdeCards(page);
  expect(visibleCards).toEqual(["modules"]);

  await page.click('#mobile-nav [data-card="console"]');
  visibleCards = await getVisibleIdeCards(page);
  expect(visibleCards).toEqual(["console"]);

  await page.click('#mobile-nav [data-card="editor"]');
  visibleCards = await getVisibleIdeCards(page);
  expect(visibleCards).toEqual(["editor"]);
});

test("mobile turtle card preserves canvas usability", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-turtle-${Date.now()}`);
  await runCode(page, 'import turtle\n\nturtle.shape("classic")\n');
  await expect(page.locator('#mobile-nav [data-card="turtle"]')).toBeEnabled();
  await page.click('#mobile-nav [data-card="turtle"]');
  await expect(page.locator("#turtle-pane")).toBeVisible();
  await page.waitForFunction(() => {
    const host = document.querySelector("#turtle-canvas");
    const canvas = document.querySelector("#turtle-canvas canvas");
    if (!host || !canvas) {
      return false;
    }
    const rect = host.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
});

test("mobile run opens turtle card when turtle is used", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-run-turtle-${Date.now()}`);
  await runCode(page, 'import turtle\n\nturtle.shape("classic")\n');
  const visibleCards = await getVisibleIdeCards(page);
  expect(visibleCards).toEqual(["turtle"]);
});

test("mobile run opens console card and input request keeps console priority", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-run-console-${Date.now()}`);
  await runCode(page, 'print("ok")\n');
  let visibleCards = await getVisibleIdeCards(page);
  expect(visibleCards).toEqual(["console"]);

  await page.click('#mobile-nav [data-card="editor"]');
  await page.fill("#editor", 'import turtle\nname = input("name? ")\nprint(name)\n');
  await page.click("#run-btn");
  await expect(page.locator("#console-input")).toBeEnabled();
  visibleCards = await getVisibleIdeCards(page);
  expect(visibleCards).toEqual(["console"]);
});

test("mobile console hides desktop layout toggle and uses mobile input hint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-console-ui-${Date.now()}`);
  await page.click('#mobile-nav [data-card="console"]');
  await expect(page.locator("#console-layout-toggle")).toBeHidden();
  await expect(page.locator("#console-input")).toHaveAttribute(
    "placeholder",
    "Введите input и нажмите «Отправить»"
  );
});

test("mobile modules card is full-height and uses touch-friendly buttons", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-modules-touch-${Date.now()}`);
  await page.click('#mobile-nav [data-card="modules"]');
  const metrics = await page.evaluate(() => {
    const sidebar = document.querySelector("#sidebar");
    const panel = document.querySelector("#sidebar .panel");
    const moduleButtons = Array.from(document.querySelectorAll(".panel-actions-files .btn.small"));
    const navButton = document.querySelector('#mobile-nav [data-card="modules"]');
    if (!sidebar || !panel || !moduleButtons.length || !navButton) {
      return null;
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const moduleButtonHeights = moduleButtons.map((btn) => btn.getBoundingClientRect().height);
    return {
      fillRatio: panelRect.height / Math.max(1, sidebarRect.height),
      moduleButtonHeights,
      navButtonHeight: navButton.getBoundingClientRect().height
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics.fillRatio).toBeGreaterThan(0.9);
  expect(metrics.moduleButtonHeights.every((h) => h >= 44)).toBe(true);
  expect(metrics.navButtonHeight).toBeGreaterThanOrEqual(44);
});

test("mobile landing hero code block keeps stable height while typing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/");
  const firstHeight = await page.locator(".hero-card").evaluate((el) => el.getBoundingClientRect().height);
  await page.waitForTimeout(1500);
  const secondHeight = await page.locator(".hero-card").evaluate((el) => el.getBoundingClientRect().height);
  expect(Math.abs(secondHeight - firstHeight)).toBeLessThanOrEqual(2);
});

test("mobile editor card keeps caret alignment", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, `mobile-caret-${Date.now()}`);
  const code = Array.from({ length: 60 }, (_, i) => `print(${i})`).join("\n");
  await page.fill("#editor", code);
  await page.click('#mobile-nav [data-card="console"]');
  await page.click('#mobile-nav [data-card="editor"]');
  const sync = await getEditorSyncMetrics(page);
  expectEditorLayersInSync(sync);
});

test("turtle shape changes canvas output", async ({ page }) => {
  await openProject(page, `turtle-${Date.now()}`);
  await runCode(page, 'import turtle\n\nturtle.shape("classic")\n');
  const classicHash = await page.evaluate(() => {
    const canvas = document.querySelector("#turtle-canvas canvas");
    if (!canvas) {
      return null;
    }
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      hash = (hash + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7 + data[i + 3]) % 1000000007;
    }
    return hash;
  });
  await runCode(page, 'import turtle\n\nturtle.shape("circle")\n');
  await page.waitForFunction((prev) => {
    const canvas = document.querySelector("#turtle-canvas canvas");
    if (!canvas) {
      return false;
    }
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      hash = (hash + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7 + data[i + 3]) % 1000000007;
    }
    return hash !== prev;
  }, classicHash);
  const circleHash = await page.evaluate(() => {
    const canvas = document.querySelector("#turtle-canvas canvas");
    if (!canvas) {
      return null;
    }
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      hash = (hash + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7 + data[i + 3]) % 1000000007;
    }
    return hash;
  });
  expect(circleHash).not.toBe(classicHash);
});

test("remix from shared snapshot creates regular project via modal", async ({ page }) => {
  const baseline = 'print("base")\n';
  const draft = 'print("draft change")\n';
  await openSnapshot(page, {
    title: "Shared lesson",
    files: [{ name: "main.py", content: baseline }],
    lastActiveFile: "main.py"
  });

  await expect(page.locator("#project-mode")).toHaveText("Снимок");
  await expect(page.locator("#remix-btn")).toBeVisible();
  await expect(page.locator("#reset-btn")).toBeVisible();

  await page.fill("#editor", draft);
  await page.click("#remix-btn");
  await expect(page.locator("#modal .modal-input")).toBeVisible();
  await expect(page.locator("#modal .modal-input")).toHaveValue("Shared lesson");
  await page.fill("#modal .modal-input", "Remixed lesson");
  await page.click('#modal [data-action="confirm"]');

  await page.waitForFunction(() => window.location.hash.startsWith("#/p/"));
  await expect(page.locator("#project-mode")).toHaveText("Проект");
  await expect(page.locator("#editor")).toHaveValue(draft);
  await expect(page.locator("#project-title")).toHaveText("Remixed lesson");
});

test("reset snapshot restores baseline with confirmation", async ({ page }) => {
  const baseline = 'print("original")\n';
  const changed = 'print("edited")\n';
  await openSnapshot(page, {
    title: "Reset source",
    files: [{ name: "main.py", content: baseline }],
    lastActiveFile: "main.py"
  });

  await page.fill("#editor", changed);
  await expect(page.locator("#editor")).toHaveValue(changed);

  await page.click("#reset-btn");
  await expect(page.locator("#modal")).toBeVisible();
  await page.click('#modal [data-action="confirm"]');

  await expect(page.locator("#project-mode")).toHaveText("Снимок");
  await expect(page.locator("#editor")).toHaveValue(baseline);
});

test("remix cancel keeps snapshot and does not navigate", async ({ page }) => {
  const changed = 'print("keep draft")\n';
  await openSnapshot(page, {
    title: "Cancel source",
    files: [{ name: "main.py", content: 'print("start")\n' }],
    lastActiveFile: "main.py"
  });

  await page.fill("#editor", changed);
  await page.click("#remix-btn");
  await expect(page.locator("#modal")).toBeVisible();
  await page.click('#modal [data-action="cancel"]');

  await expect(page).toHaveURL(/#\/s\//);
  await expect(page.locator("#project-mode")).toHaveText("Снимок");
  await expect(page.locator("#editor")).toHaveValue(changed);
});

test.describe("code input matrix", () => {
  for (const caseDef of validCodeCases) {
    test(`code matrix valid: ${caseDef.id}`, async ({ page }) => {
      await openProject(page, `matrix-valid-${caseDef.id}-${Date.now()}`);
      if (caseDef.inputLines && caseDef.inputLines.length) {
        await page.fill("#editor", caseDef.code);
        await page.click("#run-btn");
        await expect(page.locator("#console-input")).toBeEnabled({ timeout: 15000 });
        await page.fill("#console-input", caseDef.inputLines.join("\n"));
        await page.click("#console-send");
        await expect(page.locator("#run-status")).toHaveText("Готово", { timeout: 15000 });
        if (caseDef.outputPattern) {
          await expect(page.locator("#console-output")).toContainText(caseDef.outputPattern);
        }
      } else {
        await runCodeExpectDone(page, caseDef.code, caseDef.outputPattern);
      }
      if (caseDef.expectTurtle) {
        await page.waitForFunction(() => !document.querySelector("#turtle-pane")?.classList.contains("hidden"));
      }
    });
  }

  for (const caseDef of invalidCodeCases) {
    test(`code matrix invalid: ${caseDef.id}`, async ({ page }) => {
      await openProject(page, `matrix-invalid-${caseDef.id}-${Date.now()}`);
      await runCodeExpectError(page, caseDef.code, new RegExp(caseDef.errorPattern, "i"));
    });
  }
});

test.describe("negative scenarios", () => {
  test("python syntax error is reported in console", async ({ page }) => {
    await openProject(page, `neg-syntax-${Date.now()}`);
    await runCodeExpectError(page, "def broken(:\n  pass\n", "SyntaxError");
  });

  test("python NameError is reported in console", async ({ page }) => {
    await openProject(page, `neg-name-${Date.now()}`);
    await runCodeExpectError(page, "print(undefined_name)\n", "NameError");
  });

  test("python ZeroDivisionError is reported in console", async ({ page }) => {
    await openProject(page, `neg-zero-${Date.now()}`);
    await runCodeExpectError(page, "print(1/0)\n", "ZeroDivisionError");
  });

  test("python import error for missing module is reported", async ({ page }) => {
    await openProject(page, `neg-import-${Date.now()}`);
    await runCodeExpectError(page, "import definitely_missing_module_xyz\n", /ImportError|ModuleNotFoundError|No module named/i);
  });

  test("python explicit raise ValueError is reported", async ({ page }) => {
    await openProject(page, `neg-raise-${Date.now()}`);
    await runCodeExpectError(page, 'raise ValueError("boom")\n', "ValueError");
  });

  test("python assertion failure is reported", async ({ page }) => {
    await openProject(page, `neg-assert-${Date.now()}`);
    await runCodeExpectError(page, 'assert False, "assertion broke"\n', "AssertionError");
  });

  test("EOF in multi-line statement reports correct payload line", async ({ page }) => {
    await openProject(page, `neg-eof-${Date.now()}`);
    const code = "print(1)\nvalue = (\n  1 + 2\n";
    await runCodeExpectError(page, code, /EOF|unexpected EOF|multi-line statement/i);
    const output = await page.textContent("#console-output");
    const line = extractLastLineNumber(output);
    expect(line).toBe(2);
  });

  test("EOF for unclosed print call points to unclosed delimiter line", async ({ page }) => {
    await openProject(page, `neg-eof-print-${Date.now()}`);
    const code = "a = int(input())\nb = int(input())\nprint(a+b";
    await runCodeExpectError(page, code, /EOF|unexpected EOF|multi-line statement/i);
    const output = await page.textContent("#console-output");
    const line = extractLastLineNumber(output);
    const expectedLine = code.replace(/\r\n?/g, "\n").split("\n").length;
    expect(line).toBe(expectedLine);
  });

  test("runtime sanitizes invisible and control chars before execution", async ({ page }) => {
    await openProject(page, `neg-invisible-${Date.now()}`);
    const code = "a = 1\u200B\r\nb = 2\u0007\r\nprint(a + b)\n";
    await runCode(page, code);
    await expect(page.locator("#run-status")).toHaveText("Готово", { timeout: 15000 });
    await expect(page.locator("#console-output")).toContainText("3");
  });

  test("snapshot route without payload redirects to landing", async ({ page }) => {
    await page.goto("/#/s/no-payload");
    await page.waitForSelector("#view-landing:not(.hidden)", { timeout: 15000 });
    await expect(page).toHaveURL(/#\/$/);
  });

  test("snapshot route with invalid payload redirects to landing", async ({ page }) => {
    await page.goto("/#/s/bad-payload?p=u.not-valid-base64-***");
    await page.waitForSelector("#view-landing:not(.hidden)", { timeout: 15000 });
    await expect(page).toHaveURL(/#\/$/);
  });
});
