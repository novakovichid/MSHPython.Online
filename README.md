# MSHP-Turtle (Frontend-only Python IDE)

This is a static, frontend-only Python IDE designed for GitHub Pages. It uses Pyodide in a Web Worker, supports multi-file projects, stdin in the console, turtle drawing on canvas, and immutable share links.

## Quick start

1. Serve the folder locally (any static server).
2. Open the page in a modern browser.
3. Create or open a project and click Run.

## Notes

- All assets are self-hosted in `pyodide-0.29.1/pyodide`.
- No external network requests are made at runtime.
- Service worker adds COOP/COEP headers (optional cross-origin isolation).

## Structure

- `index.html` - SPA shell
- `assets/` - CSS/JS and fonts
- `pyodide-0.29.1/pyodide/` - Pyodide runtime
- `sw.js` - COI service worker
