# Generation

A DSH plugin that generates images or video using model routes configured in DSH and saves the results locally.

## Settings

Choose separate default image and video models on the plugin details page, along with the aspect ratio, image quality, video resolution, duration, and output directory. Choose any model listed in the DSH catalog; the provider and actual invocation determine whether generation succeeds. Save after making changes.

Common parameter choices are always available, along with additional values from the selected routes' catalogs. A listed choice does not guarantee provider support; the provider determines the actual result. Automatic or blank parameters are omitted from the adapter request.

Optionally choose one fallback route each for images and video. A confirmed upstream failure or invalid media triggers at most one fallback attempt. Cancellation, local permissions, invalid input, and save failures do not trigger another generation. A generation that may still be running does not trigger a fallback, avoiding duplicate generation. If both attempts fail, their failure stages are reported.

Parameters explicitly given in a conversation take precedence over these defaults. A provider and model together identify the route; generation only switches to an explicitly configured fallback after an eligible failure. A missing selection prompts the user to choose a model. An empty output directory uses the session working directory, or the downloads directory if there is none.

Settings from the previous version are retained in `legacySettings`, and common image, video, and directory defaults remain in use. Old Grok/GPT model settings are not automatically mapped to different DSH routes; select image and video models again.

Hosts sharing the same `DSH_HOME` read the same settings. If another window saves first, a stale save is rejected with a refresh prompt. Incomplete or damaged old settings are reported and left untouched.

## Requirements

The DSH Host must provide `generateMedia`, the chosen provider must have an account or credentials configured, and FFmpeg must be available. Supported models and parameters depend on the selected Host adapter and remote service. A chat model or image input capability does not establish generation capability. Generation may incur provider charges.

The plugin checks output permissions before dispatch, accepts only safe HTTPS download URLs, and validates media with FFmpeg before saving. Failure or cancellation does not overwrite existing files. Reference images are also checked for size and format.

Each image or video attempt has a 600-second deadline covering generation, download, and validation. With a fallback, up to two attempts can take 1200 seconds in total. Media decoding also has a 60-second limit.

## Validation

Tests use the Node test runner. Tests involving DSH filesystem permissions require `DSH_OFFICIAL_ROOT` to point to the official SDK. Local mock tests do not establish availability of a particular remote account or model.

For the cross-module integration test, export `DSH_HOST_SOURCE_ROOT` pointing to a DSH source checkout with dependencies installed, then run `"$DSH_HOST_SOURCE_ROOT/node_modules/.bin/vitest" run --config test/host-vitest.config.mjs`. The test reports an error if that variable is missing.

Version: 0.1.10
