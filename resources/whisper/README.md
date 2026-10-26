# Local voice transcription resources

Place the distributable whisper.cpp command-line engine at
`resources/whisper/whisper-cli` and the multilingual
`ggml-large-v3-turbo-q5_0.bin` model at
`resources/whisper/ggml-large-v3-turbo-q5_0.bin`.

The macOS packaging script copies these files into
`I.app/Contents/Resources/resources/whisper/` and signs the native executable.
Before packaging, it checks the executable permission, target architecture,
and model checksum. Development runs resolve the files directly from this
repository directory; the cached development launcher contains the Electron
runtime. Model weights stay out of Git because the quantized file is
approximately 547 MiB.

Development and preview use Electron's default app loader, identified by
`process.defaultApp`. Their resources resolve from `app.getAppPath()`, including
when the renamed `I.app` launcher reports `app.isPackaged === true`. Standalone
packages resolve resources relative to `process.resourcesPath`.

Download the model from the whisper.cpp model repository:
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin

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
ship alongside the engine and model in the app's resource directory.

Expected model SHA-256:

```text
394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
```

The engine is arm64 on Apple Silicon, uses Metal when available, and has no
third-party dynamic library dependencies beyond macOS frameworks. Keep the
engine executable permission set to `0755`.

The app bundle declares `NSMicrophoneUsageDescription` for recording permission.
Recording and recognition run locally with these resources installed.
