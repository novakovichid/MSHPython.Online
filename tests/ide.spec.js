const { test, expect } = require("@playwright/test");

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

function extractLastLineNumber(text) {
  const matches = [...String(text || "").matchAll(/\bline\s+(\d+)\b/gi)];
  if (!matches.length) {
    return null;
  }
  return Number(matches[matches.length - 1][1]);
}

async function getEditorSyncMetrics(page, { scrollToBottom = true } = {}) {
  return page.evaluate(({ scrollToBottom: shouldScroll }) => {
    const editor = document.querySelector("#editor");
    const highlight = document.querySelector("#editor-highlight");
    const numbers = document.querySelector("#line-numbers");
    if (!editor || !highlight || !numbers) {
      return null;
    }
    if (shouldScroll) {
      editor.scrollTop = editor.scrollHeight;
      editor.scrollLeft = Math.max(0, editor.scrollWidth - editor.clientWidth);
      editor.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    const editorStyle = getComputedStyle(editor);
    const highlightStyle = getComputedStyle(highlight);
    return {
      editorScrollTop: editor.scrollTop,
      highlightScrollTop: highlight.scrollTop,
      numbersScrollTop: numbers.scrollTop,
      editorScrollLeft: editor.scrollLeft,
      highlightScrollLeft: highlight.scrollLeft,
      editorLineHeight: editorStyle.lineHeight,
      highlightLineHeight: highlightStyle.lineHeight,
      editorWhiteSpace: editorStyle.whiteSpace,
      highlightWhiteSpace: highlightStyle.whiteSpace,
      scrollHeightDelta: Math.abs(editor.scrollHeight - highlight.scrollHeight)
    };
  }, { scrollToBottom });
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
  expect(sync.highlightScrollTop).toBe(sync.editorScrollTop);
  expect(sync.numbersScrollTop).toBe(sync.editorScrollTop);
  expect(sync.highlightScrollLeft).toBe(sync.editorScrollLeft);
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
  expect(metrics).not.toBeNull();
  expect(metrics.highlightScrollTop).toBe(metrics.editorScrollTop);
  expect(metrics.numbersScrollTop).toBe(metrics.editorScrollTop);
  expect(metrics.highlightScrollLeft).toBe(metrics.editorScrollLeft);
  expect(metrics.editorLineHeight).toBe(metrics.highlightLineHeight);
  expect(metrics.editorWhiteSpace).toBe(metrics.highlightWhiteSpace);
  expect(metrics.scrollHeightDelta).toBeLessThanOrEqual(2);
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
  expect(metrics).not.toBeNull();
  expect(metrics.editorWhiteSpace).toBe(metrics.highlightWhiteSpace);
  expect(metrics.highlightScrollTop).toBe(metrics.editorScrollTop);
  expect(metrics.numbersScrollTop).toBe(metrics.editorScrollTop);
  expect(metrics.scrollHeightDelta).toBeLessThanOrEqual(2);
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
