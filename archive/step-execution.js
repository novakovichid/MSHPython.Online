
// Archived Step-by-Step Execution Logic
// Removed from skulpt-app.js to fix Sk.configure issues and clean up UI.

function createStepDebugger(sourceLines, runToken) {
  const debugSession = new Sk.Debugger("__main__", {
    print: (text) => appendConsole(String(text), false),
    get_source_line: (lineno) => sourceLines[lineno] || ""
  });
  const originalSetSuspension = debugSession.set_suspension.bind(debugSession);
  debugSession.set_suspension = (suspension) => {
    originalSetSuspension(suspension);
    const active = debugSession.get_active_suspension();
    if (active && Number.isFinite(active.lineno)) {
      setEditorLineHighlight(active.lineno);
    }
  };
  const originalSuccess = debugSession.success.bind(debugSession);
  debugSession.success = (result) => {
    if (state.runToken !== runToken) {
      return;
    }
    originalSuccess(result);
    if (debugSession.suspension_stack.length === 0) {
      finishStepSession(runToken, "done");
    }
  };
  debugSession.error = (error) => {
    if (state.runToken !== runToken) {
      return;
    }
    appendConsole(`\n${formatSkulptError(error)}\n`, true);
    finishStepSession(runToken, "error");
  };
  return debugSession;
}

async function stepRun() {
  if (state.runtimeBlocked) {
    showGuard(true);
    return;
  }
  if (!state.runtimeReady) {
    showGuard(true);
    return;
  }
  if (state.stepSession && state.stepSession.debugger) {
    resumeStepSession();
    return;
  }
  const entryName = MAIN_FILE;
  const file = getFileByName(entryName);
  if (!file) {
    showToast("Нет main.py.");
    return;
  }
  if (!els.stopBtn.disabled) {
    hardStop("stopped");
  }
  const files = getCurrentFiles();
  const usesTurtle = updateTurtleVisibilityForRun(files);
  clearConsole();
  clearTurtleCanvas();
  updateRunStatus("running");

  state.stdinQueue = [];
  state.stdinWaiting = false;
  state.stdinResolver = null;

  const assets = state.mode === "project" ? await loadAssets() : [];
  const runToken = state.runToken + 1;
  state.runToken = runToken;

  const sourceLines = String(file.content || "").split(/\r?\n/);
  const debugSession = createStepDebugger(sourceLines, runToken);
  state.stepSession = { debugger: debugSession, runToken };

  try {
    configureSkulptRuntime(files, assets, { debugger: debugSession });
  } catch (error) {
    appendConsole(`\n${formatSkulptError(error)}\n`, true);
    finishStepSession(runToken, "error");
    return;
  }
  els.stopBtn.disabled = false;
  enableConsoleInput(true);

  if (state.runTimeout) {
    clearTimeout(state.runTimeout);
  }
  state.runTimeout = setTimeout(() => {
    softInterrupt("Time limit exceeded.");
    state.runToken += 1;
    finishStepSession(runToken, "error");
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
      try {
        await Sk.misceval.asyncToPromise(() =>
          Sk.importMainWithBody("__turtle_patch__", false, TURTLE_PATCH_CODE, true)
        );
      } catch (error) {
        // Ignore patch failures and proceed with execution.
      }
    }
    debugSession.enable_step_mode();
    debugSession
      .asyncToPromise(
        () => Sk.importMainWithBody("__main__", false, String(file.content || ""), true),
        null,
        debugSession
      )
      .then(() => finishStepSession(runToken, "done"))
      .catch((error) => {
        if (state.runToken !== runToken) {
          return;
        }
        appendConsole(`\n${formatSkulptError(error)}\n`, true);
        finishStepSession(runToken, "error");
      });
  } catch (error) {
    if (state.runToken !== runToken) {
      return;
    }
    appendConsole(`\n${formatSkulptError(error)}\n`, true);
    finishStepSession(runToken, "error");
  }
}

function resumeStepSession() {
  const session = state.stepSession;
  if (!session || !session.debugger) {
    return;
  }
  if (state.runToken !== session.runToken) {
    cancelStepSession();
    return;
  }
  try {
    session.debugger.resume();
  } catch (error) {
    appendConsole(`\n${formatSkulptError(error)}\n`, true);
    finishStepSession(session.runToken, "error");
  }
}

function finishStepSession(runToken, status) {
  const session = state.stepSession;
  if (!session || session.runToken !== runToken) {
    return;
  }
  state.stepSession = null;
  clearEditorLineHighlight();
  if (state.runTimeout) {
    clearTimeout(state.runTimeout);
    state.runTimeout = null;
  }
  state.stdinResolver = null;
  state.stdinWaiting = false;
  state.stdinQueue = [];
  enableConsoleInput(false);
  els.stopBtn.disabled = true;
  if (status === "done") {
    updateRunStatus("done");
  } else {
    hardStop(status);
  }
}

function cancelStepSession() {
  if (!state.stepSession) {
    return;
  }
  state.stepSession = null;
  clearEditorLineHighlight();
  if (state.runTimeout) {
    clearTimeout(state.runTimeout);
    state.runTimeout = null;
  }
  state.stdinResolver = null;
  state.stdinWaiting = false;
  state.stdinQueue = [];
  enableConsoleInput(false);
  els.stopBtn.disabled = true;
}
