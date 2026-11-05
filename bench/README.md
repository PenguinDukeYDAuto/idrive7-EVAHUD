# Bench

Run an app that draws through cluster-render on the Mac and watch its display in a browser: the 800x480 HUD (HUD Widgets) or the 1920x720 instrument cluster (Cluster Themes). No car needed.

```sh
node bench/server.js eva_hud    # then open http://localhost:8078
```

The page draws whichever target the app's `app.json` `config.target` names. One app at a time; set `BENCH_PORT` to run a second bench next to the first.

- `server.js` builds the app with the kit (`kit/tools/build.py`, the same build the Store runs on the car) into `dist/`, then runs it.
- It also stands in for `cluster-render`. It listens on a Unix socket, speaks protocol v1 (the same framing and ops as `cluster_render_client.js`), and streams every layer to the page. Protocol mistakes such as bad sizes, unknown refs, layers running off the target or `exclusive` layers show up in the log as warnings or errors.
- `run-app.js` runs the built app inside the kit's stub head unit (`kit/tools/hu-stub.js`, live mode): a fake RHMI and SOME/IP with no BMW SDK. `HUD_CLUSTER_SOCKET` points the app at the bench socket. Its data folder is `bench/.data/<app id>/`, which stands in for the app's `data/` on the car.
- `page.html` draws the layers. Image layers are the app's raw RGBA pushes, and effect layers run the app's real GLSL shader in WebGL. Layers are stacked by class, then z.

**oap-sdk stub:** the kit's build copies an `oap-sdk/` folder into the package. On the car the Store makes the real one from a BMW app. On the Mac, `server.js` writes a stub marked `BENCH_STUB` that throws if anything loads it. It's gitignored. Never ship a build made with it.

**Node version:** the car runs Node 8.16.2. If `my-agent/.cache/node8/` holds it, the app runs on it automatically, and the log line `app started on node-v8.16.2-darwin-x64` confirms it. Set `BENCH_NODE=/path/to/node` to use a different Node. The build itself needs `python3` and `node` on PATH.

**Live reload:** saving any file under the app's folder, `shared/` or `kit/` rebuilds and restarts the app. A layout saved into `bench/.data/<app id>/layouts/<name>.json` overrides the built-in one of that name without a restart: the app's own watcher reloads it, so that path gets tested too.

**Center screen:** the panel shows the status row the car shows, and the settings. A change is pressed on the stub's components (`SET_<KEY>`, a drop-down row or a checkbox press), the same way the car's HMI sends it, so the kit's own settings code handles it. Values are saved in `bench/.data/<app id>/settings.json`; delete the folder to go back to the defaults.

**An app on two screens:** the EVA app draws on the HUD and the cluster at once, on two connections. `BENCH_VIEW=panel` (or `hud`) picks which one the page shows. Run one bench at a time for an app: they build into the same `dist/` folder, and two builds at once fail with `FileExistsError`. The bench tries a failed build twice more, 2 s apart, so a test running at the same moment won't leave it stopped.

**Layer limit:** like the real service, the bench refuses a client's 9th layer with `too many layers`. It also refuses the 33rd layer across all clients, as `CompositorLimits.layers` does. `BENCH_LAYER_LIMIT=0` turns that off, for a layout written before the limit was known (Redline and GT3 have more).

**Tests:** `bench/test/eva_*_test.js` check the EVA HUD's rules and generated layouts without a page or a car.

**Signals:** An app can add sliders with `config.benchSignals` in its `app.json`. The gear slider's -1 is reverse. "Demo drive" is the kit's `sim.js`. It has no boost, so boost reads `--`. "Manual" feeds raw SOME/IP values (the fields and scaling the car sends, including FES `displayBoostPressure`), and the kit's `car.js` decodes them. Slider units are rpm, km/h, °C and bar. A manual gear above 0 reads as D.

**What the bench can't tell you:** whether SOME/IP signals arrive on the car, real HUD brightness, color and blur, GPU timing, how our layers sit next to the CarPlay or Android Auto HUD map, or how the HMI draws the center-screen page. Only the car shows those. The bench also doesn't draw mesh or video layers.

**Backdrop:** for the HUD, a road. For the cluster, a rough stand-in for BMW's own gauges, warning lights and the map window, to show what the app's layers cover. Where the map window really sits is unverified.

**URL options:** `?clean=1` hides the layer outlines. `?only=1` shows just the display at 1:1, for screenshots. `?backdrop=1` starts with the backdrop on.
