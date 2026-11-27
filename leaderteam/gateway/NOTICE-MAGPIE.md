# Third-Party Notice: Magpie Gateway Integration

Leader Team V2.2.x integrates with **Magpie** (`https://github.com/yetone/magpie`) as an optional ecosystem model gateway via its public HTTP management and OpenAI-compatible inference APIs.

## Upstream License (MIT)

```text
MIT License

Copyright (c) 2026 yetone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Build Variant & Transitive Dependency Notes

- **Headless CLI Variant (`magpie-cli-*`)**: Leader Team targets `magpie-cli-<os>-<arch>[.exe]` (`CGO_ENABLED=0 -tags "nogui packedassets conptypair"`), which embeds both the gateway and `--web` management server without linking desktop `libgtk-3` or `libwebkit2gtk` LGPL libraries.
- **Permissive Transitive Obligations**: Magpie's Go module graph and embedded notices (`magpie licenses` / `GET /api/notices`) consist of MIT, Apache-2.0 (`MoeForge/moejs`, `sigstore-go`, `jsonschema`), BSD-3-Clause (`modernc.org/sqlite`, V8 ports), ISC, and Unicode-3.0 (CLDR/ICU). On Windows, `conptypair` embeds Microsoft's MIT-licensed `Microsoft.Windows.Console.ConPTY`.
- **Zero Upstream Source Patches**: Leader Team V2.2.x adapts exclusively through Magpie's official `/api/*` and `/v1/*` interfaces (`patches: []` in `magpie-manifest.json`).
