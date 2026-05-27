# Marketing assets

Public-safe marketing and store assets for ComputerCaller. No secrets live here.

## Structure

```
marketing/
  images/      Mockups, graphics, high-res visual media (source for crops/resizes)
  store/       Play Store listing assets (app icon, feature graphic, feature screenshots)
  seo/         Keywords, meta descriptions, page copy (placeholder for now)
  articles/    Blog posts / long-form content (placeholder for now)
```

## What's in here now

### store/ — Google Play listing
| File | Purpose | Spec |
|---|---|---|
| `app-icon-512.png` | App icon | 512x512 PNG |
| `feature-graphic-1024x500.png` | Play Store feature graphic | 1024x500 PNG |
| `feature-graphic-1024x500.jpg` | Same, JPG (Play accepts either) | 1024x500 JPG |
| `connect-A-pairing-feature-1024x500.png` | Feature screenshot — pairing screen | 1024x500 PNG |
| `connect-B-in-use-feature-1024x500.png` | Feature screenshot — in-use screen | 1024x500 PNG |

### images/ — high-res mockups
| File | Purpose |
|---|---|
| `connect-A-pairing-1920x1080.png` / `.webp` | Full-res "pairing" mockup (PNG = source, WebP = web-optimized) |
| `connect-B-in-use-1920x1080.png` / `.webp` | Full-res "in use" mockup (PNG = source, WebP = web-optimized) |

## Notes
- Assets were produced in the Pixel design workspace; originals are retained in agent memory.
- Adding new assets: drop them in the matching folder and commit. Keep individual files reasonably small (these are all under ~3 MB).
- `seo/` and `articles/` are empty placeholders — populate as content is written.
