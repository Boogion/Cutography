# Lithography modes

Cutography can design for electron-beam lithography as well as for paper. Pick the mode on the home
page before choosing a photo or a map; the whole design then follows from it.

| Mode | What each palette entry is | Main files |
|---|---|---|
| **Grayscale relief** | A height (dose level): 8 or 16 of them | `.gds` (+ `.lyp`), grayscale `.bmp`, dose table `.csv`, `recipe.json` |
| **Structural color** | A nanostructure: grating, pillars, nanodisks, or a film thickness | filled `.gds`, region-mask `.gds`, structures `.csv`, `recipe.json` |
| **Layers only** | A plain layer | `.gds`, masks, label maps |

## 1. Fabrication setup

The first step of both tools asks for:

- **Process:** resist only, lift-off (metal), etch into the substrate, or TiO₂ structures. The process
  decides what is possible: lift-off and TiO₂ are on/off processes, so grayscale is switched off for
  them, and each process only offers the structures it can make.
- **Resist** (PMMA, ZEP520A positive; HSQ, ma-N 2400 negative), **substrate** (Si, SiO₂ on Si, fused
  silica) and **metal** for lift-off.
- **Limits:** smallest feature and smallest gap (default 100 nm), the height/depth range (10–500 nm),
  the smallest step between levels (10 nm), resist thickness, etch selectivity, the largest pillar
  aspect ratio, and the writing grid.
- **Field size:** 100 µm up to a 4 in (100 mm) wafer.

The panel says in plain words what the written shapes become (for example *"Positive resist: more
dose removes more resist. Tall levels get little dose; areas outside the pattern stay at full resist
thickness."*) and lists problems as you go, with the fix. Examples:

- 16 levels over 10–100 nm would be 6 nm apart: it offers 8 levels, or a deeper range (16 levels need ≥ 150 nm).
- Gratings need a period of at least 200 nm (100 nm line + 100 nm gap); pillars need pitch ≥ diameter + 100 nm.
- With etching, the resist must hold depth ÷ selectivity of relief.

## 2. Grayscale relief

Each level is written as its own **non-overlapping** region (level *i* = everything at that height and
not higher), so every spot is exposed exactly once at its level's dose.

**GDS** (`ebl/<name>.gds`)
- Dose encoding: **layer 1, datatype = dose class** (default), or **one layer per dose class**.
- Dose class 0 is the smallest dose. With a positive resist the tallest level is dose class 0; with a
  negative resist it is the highest class.
- Holes: **keyhole** (one polygon per piece, zero-width cuts to its holes), **split** (hole-free
  pieces), or **both** as two files to compare.
- Coordinates in µm, 1 nm database unit, snapped to the writing grid.
- The `.lyp` file names each dose class (*dose 3 · 220 nm*) for KLayout.

**BMP** (`ebl/<name>-<pixel>nm.bmp`), for doing it yourself in BEAMER
- 8-bit grayscale at your pixel size (10 nm–1 µm); the pixel size is stored in the file.
- Values: **0 = outside the pattern**, then dose class + 1 (raw), or spread over 0–255. The JSON
  next to it has the full value table.
- A full wafer at fine pixels is far too large for a bitmap; the export card shows the pixel count
  first, and the GDS is the route for big fields.

**Dose table** (`ebl/<name>-dose-table.csv`): datatype, level, height, resist height, resist removed,
relative dose. Without a contrast curve the dose is a straight-line placeholder (marked as such).
Paste your curve (relative dose, remaining thickness fraction) in the setup to get real values.
Proximity correction is left to BEAMER.

**Rule check**: thin parts, narrow gaps and corner-only touches are found by rasterising the layout
at a quarter of the smallest feature (coarser for very large fields; the resolution is reported).

## 3. Structural color

Choose a structure family; the palette is then made of structures, each with a preview color:

| Family | Processes | Color comes from | Preview |
|---|---|---|---|
| Diffraction gratings | all | line period at the viewing angle (λ = d · sin θ) | calculated (white light from above, viewer at the set angle) |
| Blazed gratings | resist, etch | stepped sawtooth in each period (grayscale) | calculated |
| Thin-film color | resist, etch (SiO₂ on Si) | film thickness, as on an oxide color chart | calculated |
| TiO₂ / Si pillars | TiO₂, etch | pillar diameter | estimate |
| Al / Ag / Au nanodisks | lift-off | disk diameter | estimate |

Estimated colors are labelled as such. Load your own **measured library** (a CSV of structures and
their measured colors; the setup offers an example file) and it replaces the estimates.

**Files**
- `structures/<name>-filled.gds`: region masks on layers 100, 101, … (one per palette entry) and the
  structures on layer 1, datatype = palette entry. Gratings are line rectangles; pillars and disks are
  one cell per size placed with array references, so large fills stay small.
- `structures/<name>-regions.gds`: just the region masks, to fill in BEAMER or KLayout.
- `structures/<name>-structures.csv`: every entry's parameters, area and shape count.
- Neighbouring regions keep your minimum gap; structures closer than that to a region edge are left out.

Thin-film color and blazed gratings are grayscale designs, so they export through the grayscale path
(levels, dose table, BMP).

## Maps in the lithography modes

The map tool turns terrain into 8 or 16 contour bands (grayscale) or into bands of structures (low
ground takes the first palette entry, high ground the last). Ring lettering, alignment marks, streets
and buildings are paper features and are off. The disc is scaled to the field diameter you set.
