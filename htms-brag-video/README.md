# HTMS brag video — how to render

The composition is complete and passes `hyperframes lint`. It was not rendered
here because the build sandbox is Linux ARM64, where Hyperframes has no prebuilt
headless Chrome. On your machine (macOS / x86 Linux with Chrome available):

```bash
cd brag-output/composition
npx hyperframes browser ensure     # one-time: fetch headless Chrome
npx hyperframes validate           # WCAG contrast + console checks
npx hyperframes preview            # optional: live preview at localhost
npx hyperframes beats              # optional: detect beats for tighter sync
npx hyperframes render --quality high --output ../brag.mp4
```

Output: brag-output/brag.mp4 (landscape 1920x1080, ~20s).
Share caption: share-copy.txt
