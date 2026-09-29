# sublight brand

**The mark:** the word **sub** with a small glint of light in the subscript position, as in x₁. The subscript _is_ the light, so it reads "sub" + "light", and it sits under the text the way a caption sits under a picture.

| File            | Use                                                                         |
| --------------- | --------------------------------------------------------------------------- |
| `logo.svg`      | the wordmark; the text takes `currentColor`, so it works on light and dark  |
| `logo-mono.svg` | one colour (the glint in `currentColor` too), for print and single-ink uses |
| `icon.svg`      | the app icon: "s" and the glint on a deep indigo tile                       |
| `icon-off.svg`  | the same, greyed: the extension's toolbar icon while the engine is off      |

`node brand/render.mjs` renders the extension's PNG icons (16, 32, 48, 128, on and off) and copies the Player's favicon. Colours: indigo `#4338ca` → `#1e1b4b` (tile), amber `#fff7d6` → `#f59e0b` (glint).
