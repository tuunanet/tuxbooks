# Brand logos

TuxBooks logo variants:

- `tuxbooks-dark.png` — for dark backgrounds (site, dark UI surfaces)
- `tuxbooks-light.png` — for light backgrounds (print, light UI surfaces)

Both are original artwork created for this project and are licensed under the
same license as the rest of TuxBooks: **GNU GPL v3** (see `LICENSE.md` at the
repository root).

Copyright © 2026 Tuomo Tuunanen.

The website uses a size-optimized copy of the dark logo at `site/img/logo-dark.png`;
regenerate it after editing the source art:

```sh
python3 -c "from PIL import Image; im = Image.open('brand/tuxbooks-dark.png'); im.thumbnail((320, 320)); im.save('site/img/logo-dark.png', optimize=True)"
```

The desktop app icons under `src-tauri/icons/` are generated separately by
`scripts/make-icon.py` from `scripts/icon-source.png`.
