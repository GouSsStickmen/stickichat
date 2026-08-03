# StickiChat design kit

Nine preview pages that render the app's own components once **per theme, side by side**.

Every value here is generated, never hand-written: the palettes are parsed out of
`src/renderer/src/lib/themes.ts` and the shape/type scales out of `src/renderer/src/styles/global.css`.
A preview therefore cannot drift from what ships — if it looks wrong here, it is wrong in the app.

Seeing seven themes at once is the point. Every theming bug this project has hit — the paint
that vanished on light backgrounds, the scrim that fogged the mid-tone palettes, the
checkerboard whose two squares landed a few percent apart — was invisible while looking at one
theme and obvious the moment they sat next to each other.

## Regenerating

    python tools/buildkit.py

Then push to the Claude Design project (`StickiChat`) with the DesignSync flow: list → finalize
plan → write files.

## Checking contrast

    python tools/contrast.py

Prints WCAG ratios for the pairs that matter (text/bg, faint text/bg, link/bg …) for every
theme. Run it whenever a theme is added or a palette is touched: Nord and Gruvbox once shipped
a third less contrasty than the rest, and the table is what caught it.
