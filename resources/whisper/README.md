# Local voice transcription engine

`resources/whisper/whisper-cli` is the whisper.cpp command-line engine shipped
with the macOS application. Model weights are not distributed with the app.

The packaging script stages this directory, removes every `.bin` model file,
verifies the engine architecture, and fails if a model weight would remain in
the packaged resources. Users download models from Settings → Voice or keep an
existing GGML model anywhere on disk for automatic discovery.

Development and preview use Electron's default app loader, identified by
`process.defaultApp`. Their engine resolves from `app.getAppPath()`, including
when the renamed `I.app` launcher reports `app.isPackaged === true`. Standalone
packages resolve the engine relative to `process.resourcesPath`.

A local model file may be kept at
`resources/whisper/ggml-large-v3-turbo-q5_0.bin` for development, but Git and
the macOS package exclude it. Downloaded models live under the app data
directory or at the path where the user downloaded them.

Use a whisper.cpp `whisper-cli` build for the application's target architecture.
The supplied engine identifies whisper.cpp 1.8.3 in its compiled version and
source-path strings, is arm64, and matches the previously installed local
engine. Its upstream source is https://github.com/ggml-org/whisper.cpp/tree/v1.8.3.
The original signing metadata identifies Team ID `LY7MVTUDZG`; its exact build
recipe and source commit remain unrecorded. A reproducible distribution can
replace it with an engine compiled from the tagged upstream source. Packaging
verifies its architecture against the host and applies the app's local signature.

Current engine SHA-256 before packaging:

```text
cc8a6e15f0125e82344e0f2af3fdc4c882b20316c250edb34b5cd20c3a5b3581
```

`LICENSE.whisper.cpp` carries the engine's upstream MIT notice from tag v1.8.3.
`LICENSE.whisper` carries OpenAI Whisper's upstream MIT notice. Both notices
ship alongside the engine.

The engine is arm64 on Apple Silicon, uses Metal when available, and has no
third-party dynamic library dependencies beyond macOS frameworks. Keep the
engine executable permission set to `0755`.

The app bundle declares `NSMicrophoneUsageDescription` for recording permission.
Recording and recognition run locally with a selected GGML model.
