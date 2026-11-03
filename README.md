# PCB Scope

A free, open-source macOS app (and browser app) for inspecting PCBs under a USB microscope, with
classic computer vision that finds **ICs, resistors, capacitors, crystals, holes and exposed
copper** in the live image, measures them in millimetres, reads chip markings, and compares a
board against a known-good "golden" board.

Everything runs locally: OpenCV.js in a Web Worker, no cloud, no account.

## Install (macOS 12 or newer, Apple silicon or Intel)

1. Download `PCB-Scope-<version>.dmg` from [Releases](https://github.com/dhritiman-dasgupta/pcb-scope/releases).
2. Open it and drag **PCB Scope** into **Applications**.
3. The app is not notarised by Apple, so the first launch is blocked. Either
   - open **System Settings → Privacy & Security** and click **Open Anyway** next to PCB Scope, or
   - run `xattr -dr com.apple.quarantine "/Applications/PCB Scope.app"` in Terminal.
4. Allow camera access when asked. The app picks the USB microscope automatically
   (it skips FaceTime / iPhone cameras); you can switch cameras in **Source**.

Snapshots and exports are saved to `~/Downloads/PCB Scope/`.

## What it does

| Feature | How |
|---|---|
| Live view | Any UVC camera / USB microscope up to 4K, zoom & pan, mirror / flip, brightness / contrast / saturation, sharpen, freeze |
| Focus assist | Focus score (Laplacian variance of the centre) with a "how close to best" meter, plus magenta **focus peaking** |
| Part detection | **IC** (with visible lead count and pitch), **RES** (black body), **CAP** (white / beige / brown ceramic), **L/C** (coloured-body chips), **XTAL / can**, holes, tented vias, exposed copper / gold, irregular dark regions (burns, residue) |
| Measure | Calibrate once against a known length (2.54 mm header, an 0805 part, a ruler), then drag to measure; grid and scale bar; per-magnification presets. Calibrated chips get a package guess (0402 / 0603 / 0805 …) and IC pitch in mm |
| Golden-board compare | Capture a good board as reference; the board under test is aligned with ORB features + RANSAC homography and differences (missing, extra, shifted or bridged parts) are boxed. Blink and overlay views |
| Read markings | Drag a box over a chip marking; Tesseract.js OCR tries both polarities and four rotations, with LCSC / datasheet search links (downloads ~15 MB from jsDelivr on first use) |
| Export | Annotated or raw PNG, detections + measurements as JSON |
| Tuning | Every threshold is a slider; **Pixel classes** shows how each pixel was classified and the status bar shows the HSV value under the cursor |

### How detection works

1. The solder-mask colour is found automatically (peak of the hue histogram), so green, blue, red,
   purple and yellow boards work. Black / white masks need the mask colour set to *None*.
2. Every pixel is classed as mask, dark body, bright (metal or white ceramic), warm (beige / brown
   ceramic), copper / gold, coloured body or grey. The dark threshold follows the board's
   brightness, so changing exposure doesn't break it.
3. Anything that is not solder mask is a part candidate. Thin silkscreen strokes are opened away,
   and each remaining blob is classified by its middle colour and whether its two ends contrast
   with the middle (the metal terminations of a chip part).
4. Large dark bodies are ICs; metal runs along their edges are counted as leads.
5. All of it runs at a reduced processing size (960 px by default) in a worker, ~0.2–0.4 s per frame.

It is heuristic, not a trained neural network: it works best top-down, in focus, with even
lighting. Blue-bodied chips are labelled L/C because colour alone cannot tell an inductor from a
capacitor.

Keyboard: `Space` freeze · `S` save PNG · `D` detection on/off · `R` set reference · `B` blink ·
`V` select · `M` measure · `C` calibrate · `O` OCR · `G` grid · `X` crosshair · `H` mirror · `0` fit.

## Run in a browser instead

```sh
./serve.sh        # serves web/ on http://localhost:8790 and opens Chrome
```

Needs Python 3. The page must be served over http(s) (camera and Web Worker don't work from `file://`).

## Build the Mac app

```sh
macos/build.sh    # → dist/PCB Scope.app and dist/PCB-Scope-<version>.dmg
```

Needs Xcode command-line tools. The app is a small Swift shell (`macos/main.swift`): a WKWebView
plus a loopback-only HTTP server for the bundled `web/` folder. It is ad-hoc signed; universal
(arm64 + x86_64). `macos/make_icon.py` regenerates the icon (needs Pillow).

Self-test without a camera:

```sh
"dist/PCB Scope.app/Contents/MacOS/PCBScope" --selftest /path/to/board.jpg /tmp/shot.png
```

prints the detection summary as JSON and saves a screenshot.

## Layout

```
web/            the app (index.html, app.js UI, cv-worker.js OpenCV analysis, vendor/opencv.js)
macos/          Swift shell, Info.plist, icon, build script
serve.sh/.py    browser mode
```

## Licence

MIT — see [LICENSE](LICENSE). Bundles OpenCV.js 4.9.0 (Apache 2.0) and loads Tesseract.js
(Apache 2.0) on demand; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
