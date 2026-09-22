# Agent Canvas engine

This directory contains the local canvas editor, renderer, utilities, and math code used by Agent Studio. It is maintained as first-party source inside this repository.

The Renderer resolves these packages through aliases in `electron.vite.config.ts`:

- `@agent-studio/canvas-editor` → `engine/editor`
- `@agent-studio/canvas-utils` → `engine/utils`
- `@agent-studio/canvas-math` → `engine/math`

The project does not depend on a published canvas package. Edit the source under `engine/editor` when changing the Canvas renderer, UI, styles, tools, or internal interaction behavior. Run `npm run dev` in the repository to compile the source through Vite and inspect it in Electron; no npm publication is needed during development.

The initial implementation was derived from an upstream MIT-licensed editor snapshot. Keep the license in this directory and treat future changes as local Agent Canvas work. Third-party dependencies remain declared in the project root because the local source imports them at runtime.
