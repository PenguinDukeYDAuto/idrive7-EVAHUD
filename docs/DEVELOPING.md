# Developing

## Repo layout

```
apps/<id>/        one folder per app: app.json, main.js (entry), NOTICE, README
                  subfolders (hud/: fonts, layouts) are packed into <folder>.pack by the build
shared/           the cluster-render drawing engine; an app lists the files it needs
                  in app.json "shared" and the build copies them in
kit/              cauliflowermossgrape's MGU App Kit (MIT, kit/LICENSE): runtime/ ships inside each app,
                  tools/ builds it. Two changes from upstream: the optional app.json "credits" row, and kit/tools/build.py copies the app.json
                  "shared" files (marked "bimmer-lab addition")
bench/            Mac test bench (fake cluster-render + the kit's stub head unit), see bench/README.md
tools/            eva_layout.py writes the EVA layouts and bakes its fonts from fonts you supply (README.md, "字体")
scripts/          deploy.sh pushes layout files to the car over SSH
```

## Build

`python3 kit/tools/build.py <id>` builds one app into `dist/`. It needs an `oap-sdk/` folder. On the car the Store makes the real one from a BMW app. On the Mac the bench writes a stub, which is gitignored and must never ship.

## Test on the Mac

```sh
node bench/server.js eva_hud    # then open http://localhost:8078
```

The page has buttons for the drive mode (COMFORT, SPORT, SPORT+, ECO PRO), fed in as the car's FES signal. It builds the app with the kit and runs the build in the kit's stub head unit on Node 8.16.2 (the car's version), against a fake cluster-render. The page shows the HUD or the cluster with the app's real pixels and shaders, the center-screen status and settings, and signal sliders. Details in `bench/README.md`.

## Layouts

Each app's layouts are `apps/<id>/hud/layouts/<name>.json` (`schemaVersion: 2`). Widget types, tokens and options are documented in the header of `shared/hud.js`. `shared/layouts.js` checks every layout and refuses a bad one with the reason, which also shows on the app's status row.

- **HUD (800x480):** `text`, `scale`, `stripe`, `shiftbar`, `arc`, `revbar`, `lights`, `badge`. Colours are theme roles (`fg`, `dim`, `arc`), so a layout works in every theme.
- **Cluster (1920x720):** the same types, plus `fill` (a solid colour with a see-through `hole` cut while a setting is on) and `box` (a framed readout with a header strip). A cluster layout names its own `"theme"`.
- **Calibration:** `grid` (lines every `step` px, brighter every `major` steps) and `gridlabels` (x/y labels every `step` px). Each app ships a `grid.json` layout.
- **Off:** the layout name `off` draws nothing and releases the screen. With `byMode` on, the `inComfort` / `inSport` / `inEco` settings pick the layout from the car's drive mode (FES `statusFESVehicleDynamicSwitchHMI`).
- **Effect shaders:** cluster-render's `v_uv` has (0,0) at the top-left. The bench draws the same way.
- **Any widget:** `toggle: "setting"` shows it only while that setting is on, and `"!setting"` only while it's off. `themes: [...]` limits it to certain themes.

To try an edited layout on the car without reinstalling:

```sh
./scripts/deploy.sh root@<car-ip-or-hostname> my-layout.json
```

The file lands in the app's `data/layouts/` on the car, overrides the built-in layout of the same name, and the running app reloads it by itself.

## Fonts

No fonts are in this repository: see "字体" in README.md. The car never rasterizes fonts; `tools/eva_layout.py` bakes them into alpha atlases under `apps/eva_hud/hud/fonts/`, which git ignores.

## Adding an app

1. Make `apps/<id>/` with an `app.json` (id, title, version, signals, screens, settings) and a `main.js` that calls `mgu.run`. An app that draws through cluster-render lists the engine files in `"shared"` and sets `config.target` (`hud` or `panel`).
2. Build it once by hand to check it.

## Crash safety

The kit turns an uncaught exception into an app exit, and on the car a second unexpected exit uninstalls the app. Every timer, event and widget in the engine runs inside a guard that logs the error and carries on.
