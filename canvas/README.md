# Agent Canvas engine

This directory contains I's locally maintained editor, renderer, geometry, commands, context references, and persistence modules.

The Renderer resolves the engine modules through aliases in `electron.vite.config.ts`:

- `@i/canvas-editor` → `engine/editor`
- `@i/canvas-utils` → `engine/utils`
- `@i/canvas-math` → `engine/math`

Development compiles these local modules directly through Vite. Edit `engine/editor` to change rendering, styles, tools, or interaction behavior, then use `npm run dev` to inspect the result in Electron.

## Product scope

The desktop editor provides selection, hand panning, rectangle, ellipse, diamond, line, arrow, free drawing, text, image, eraser, undo, and redo. Selection references and JSON/image exports use the same scene model. User interaction and `canvas_edit` update the live editor; project persistence uses `CanvasSaveCoordinator` and `CanvasDocumentStore`.

The UI uses the English dictionary and I's system text stack. Existing documents retain their supported text fonts, CJK fallback glyphs, and emoji. Historical iframe, embeddable, and magic-frame records use static geometry and labels.

Project regressions live in `tests/`; `npm run typecheck` checks Main, the workbench, and the real engine. The desktop runtime uses Electron's native Canvas and DOM APIs.

## Source provenance

The initial drawing core derives from an MIT-licensed editor snapshot. The original copyright and permission notice remain in `LICENSE`, while local product changes are maintained in this repository. Source provenance records authorship and reuse; Git commit hashes identify versions of the local files. Runtime dependencies are declared in the project root.
