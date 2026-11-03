# Drop your real photographs here

The page looks for these five files first and falls back to the current
illustrative images when a file is missing. Add a file, reload, done.

| Filename | Where it appears | Crop |
|---|---|---|
| `01-community.jpg` | Large tile, "Community programs" | portrait 4:5, at least 1200x1500 |
| `02-tutoring.jpg` | "After-school tutoring" | 4:3, at least 1200x900 |
| `03-food.jpg` | "Food access" | 4:3 |
| `04-arts.jpg` | "Arts and culture" | 4:3 |
| `05-seniors.jpg` | "Senior services" | 4:3 |

Rules
- JPG, sRGB, quality 80, long edge 1600px. Smaller is better than slow.
- Real people need written permission on file before a photo goes up. If in doubt, crop faces out.
- Do not rename the files. The page matches on these names.
- Keep the originals; only compressed copies belong in this folder.

Optional: run `python3 tools/optimize_photos.py` from `原型/` to resize and
compress whatever you drop here into `web/`, then point the filenames at those.
