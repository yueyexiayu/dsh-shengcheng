# Generation

A DSH plugin that generates images or video using model routes configured in DSH and saves the results locally.

## Install

This is a local DSH desktop plugin loaded as a bundle; it is not published to npm:

1. Put the repository at `$DSH_HOME/plugins/shengcheng` (default `~/.dsh/plugins/shengcheng`).
2. Add `"shengcheng": "link:/absolute/path/shengcheng"` (or a `file:` reference) to `dependencies` in `$DSH_HOME/profiles/desktop/package.json`.
3. Add `"shengcheng"` to the same file's `dsh.profile.bundles` array; the package's `cordis.patch.yml` already declares the `insert`.
4. Restart the DSH desktop app so it loads (the user restarts it manually); a 「生成」 plugin page means it loaded.
5. Runtime prerequisites are listed under Requirements below: a Host with `generateMedia`, configured provider credentials, and FFmpeg.

Dependencies: the client runtime `react` is an optional peer dependency injected by the DSH frontend; `vitest` is a devDependency used only by `npm run test:host`. `@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` come only from the DSH host and the source checkout pointed to by `DSH_HOST_SOURCE_ROOT`, are not on the npm registry, and are therefore not declared; see [docs/TESTING.md](docs/TESTING.md).

## Settings

Choose separate default image and video models on the plugin details page, along with the aspect ratio, image size policy, image quality, video resolution, duration, and output directory. Choose any model listed in the DSH catalog; the provider and actual invocation determine whether generation succeeds. Save after making changes.

The image size policy can use the configured aspect ratio or match the reference image size. Match mode applies only to image edits when the conversation does not explicitly set `size` or `aspect_ratio`; a mismatched output is normalized through FFmpeg to PNG at the exact reference dimensions.

Common parameter choices are always available, along with additional values from the selected routes' catalogs. A listed choice does not guarantee provider support; the provider determines the actual result. Automatic or blank parameters are omitted from the adapter request.

Optionally choose one fallback route each for images and video. An eligible upstream failure or invalid image can trigger one fallback attempt with the same reference image and conversation parameters. A video submission whose state is unknown — including HTTP 503 — never starts the fallback: the submission may already be accepted, so retrying would generate and bill twice. Invalid returned video, cancellation, local permissions, invalid input, and save failures do not trigger a fallback either. If both attempts fail, their failure stages are reported.

Parameters explicitly given in a conversation take precedence over these defaults. A provider and model together identify the route; generation only switches to an explicitly configured fallback after an eligible failure. A missing selection prompts the user to choose a model. An empty output directory uses the session working directory, or the downloads directory if there is none.

When the conversation does not explicitly specify a resolution, the saved default is sent. Choosing automatic omits the resolution; provider support is determined by the actual request.

Video duration is capped at 30 seconds; the settings page, call parameters, and media validation all reject longer requests.

After an HTTP 503 video submission, the plugin reports any discrepancy between the request and the current route's declared duration or resolution as a diagnostic clue. The catalog does not establish the cause or change the requested parameters.

When a submission's state is unknown the job may still be running. The `shengcheng_video_jobs` tool queries, resumes, or lists the media jobs recorded on this machine: `status` reads one job, `resume` continues downloading and saving a completed job, and `list` enumerates recorded jobs. Records live in `DSH_HOME/storages/shengcheng/video-jobs` and are capped at 200.

The settings panel and its actions follow the active DSH interface language (Chinese or English), falling back to Chinese rather than showing a raw key.

Settings from the previous version are retained in `legacySettings`, and common image, video, and directory defaults remain in use. Old Grok/GPT model settings are not automatically mapped to different DSH routes; select image and video models again.

Hosts sharing the same `DSH_HOME` read the same settings. If another window saves first, a stale save is rejected with a refresh prompt. Incomplete or damaged old settings are reported and left untouched.

## Requirements

The DSH Host must provide `generateMedia`, the chosen provider must have an account or credentials configured, and FFmpeg must be available. Supported models and parameters depend on the selected Host adapter and remote service. A chat model or image input capability does not establish generation capability. Generation may incur provider charges.

The plugin checks output permissions before dispatch, accepts only safe HTTPS download URLs, and validates media with FFmpeg before saving. Failure or cancellation does not overwrite existing files. Reference images are also checked for size and format.

Each image or video attempt has a 600-second deadline covering generation, download, and validation. With a fallback, up to two attempts can take 1200 seconds in total. Media decoding also has a 60-second limit.

## Validation

Test entry points and coverage boundaries: [docs/TESTING.md](docs/TESTING.md). Product boundaries: [docs/PRODUCT.md](docs/PRODUCT.md). Interface contract: [docs/API.md](docs/API.md).

Tests use the Node test runner. Tests involving DSH filesystem permissions require `DSH_OFFICIAL_ROOT` to point to the official SDK. Local mock tests do not establish availability of a particular remote account or model.

For the cross-module integration test, export `DSH_HOST_SOURCE_ROOT` pointing to a DSH source checkout with dependencies installed, then run `"$DSH_HOST_SOURCE_ROOT/node_modules/.bin/vitest" run --config test/host-vitest.config.mjs`. The test reports an error if that variable is missing.

Version: 0.1.22
