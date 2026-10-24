# Samples

These files are self-generated for the mock-mode demo. No recordings, no photographs of people, no logos, and no trademarks.

They are dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

| File | What it is |
| --- | --- |
| `song.wav` | 16 seconds, 22050 Hz mono 16-bit PCM. A 120 BPM kick on every half-second, with a louder hit every 2 seconds. Synthesized in `scripts/make-samples.ts`. Under 1 MB. |
| `photo-a.png` | 1080×1920 geometric plate. Black field, acid bar. |
| `photo-b.png` | 1080×1920 geometric plate. Paper field, ink circle. |
| `photo-c.png` | 1080×1920 geometric plate. Dark field, magenta and acid blocks. |

Regenerate them with:

```
npx tsx scripts/make-samples.ts
```

In the Cut Sheet, **Load sample** fetches these files from `/samples` so a judge can run the whole flow in mock mode with no uploads and no GPU.
