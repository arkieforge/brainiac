# Assets

The Brainiac brand: the mark, favicons and app icons. Names follow T3 Code's `assets/` folder.

- `logo.svg`: the app icon (white mark on black). Keep this name and place: T3 Code finds a project's
  icon by looking for `assets/logo.svg`, so moving it drops our icon from the T3 sidebar.
- `brainiac-mark*.svg`: the mark alone. Unsuffixed files fill with `currentColor`; `-black` and `-white`
  are fixed for places that can't set a colour, such as an `<img>`.
- `brainiac-web-*`: favicons, the 180 px Apple touch icon and the 512 px web app icon.
- `brainiac-universal-1024.png`: the 1024 px app icon for stores and native apps.

Diagrams for the docs live next to the docs, in [`docs/assets/`](../docs/assets/).
