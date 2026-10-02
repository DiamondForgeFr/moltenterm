# MoltenTerm vector brand kit

This kit redraws the selected frameless orange Open Forge symbol as clean editable Bézier paths. It is an optical reconstruction of the selected raster concept, not a pixel-exact automatic trace.

## Assets

- `svg/logo-light.svg` / `logo-dark.svg`: transparent horizontal lockups for light / dark surfaces.
- `svg/logo-*-background.svg`: lockups with explicit backgrounds.
- `svg/logo-stacked-light.svg` / `logo-stacked-dark.svg`: stacked lockups.
- `svg/logo-mono-black.svg` / `logo-mono-white.svg`: single-color lockups.
- `svg/mark.svg`: orange symbol; black, white, mask and currentColor variants are also included.
- `svg/app-icon-dark.svg` / `app-icon-light.svg`: 1024px vector icon canvases with transparent exterior margins.
- `svg/app-icon-mask.svg`: monochrome symbol on a square transparent canvas for template / tray use.
- `svg/favicon.svg`: compact symbol with a slightly shorter tail for small-size rendering.
- `png/`: raster exports at application and favicon sizes.
- `native/icon.icns`: macOS application icon, dark variant.
- `native/icon.ico`: multi-resolution Windows icon, dark variant.
- `preview.html` / `preview.png`: asset contact sheet.

All production SVGs contain paths and geometry only: no raster images, external references, scripts or font dependencies. The wordmark uses outlined Arial Bold letterforms. Shape and text remain separate groups.

## Colors

Orange: #FF7C0D. Zinc text: #27272A. Light text: #E4E4E7. Dark tile: #18181B. Light tile: #FAFAFA.

`mark-currentcolor.svg` inherits color when inserted inline in HTML. For CSS masks, use `mark-mask.svg`; the mask color comes from the consuming element.

## Application integration map

The current application references these existing files:

- `build/moltenterm/icon.png`: Linux and Windows packaging icon. Use `png/app-icon-dark-1024.png`.
- `build/moltenterm/icon.icns`: macOS packaging icon. Use `native/icon.icns`.
- `build/moltenterm/icon.svg`: editable icon source. Use `svg/app-icon-dark.svg`.
- `frontend/app/asset/logo.svg`: UI symbol. Use `svg/mark.svg`.
- `public/moltenterm-mark.svg` and `docs/static/moltenterm-mark.svg`: CSS mask symbol. Use `svg/mark-mask.svg`.
- `public/logos/moltenterm-logo.png`: preview and onboarding image. Use a dark app-icon PNG or the appropriate logo PNG for the consuming layout.

This kit does not replace repository assets or modify application code. Integration should follow the project ticket and branch workflow. Native tray/menu rendering and packaged app appearance still require a visual check in the application.
