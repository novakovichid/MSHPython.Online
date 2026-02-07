import { runEditorCommand } from "../editor-core/editor-command-runner.js";
import { resolveEditorShortcut } from "../editor-core/editor-shortcuts.js";

export function handleLegacyEditorKeydown({
  event,
  adapter,
  tabSize = 4,
  onAfterCommand
} = {}) {
  const command = resolveEditorShortcut(event);
  if (!command) {
    return false;
  }

  const result = runEditorCommand({
    adapter,
    command,
    tabSize
  });

  if (!result.handled) {
    return false;
  }

  if (event && typeof event.preventDefault === "function") {
    event.preventDefault();
  }

  if (typeof onAfterCommand === "function") {
    onAfterCommand(result);
  }

  return true;
}
