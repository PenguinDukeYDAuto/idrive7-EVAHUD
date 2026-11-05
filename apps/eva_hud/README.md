# EVA HUD

NERV 风格的挡风玻璃 HUD，只装在自己的车上。设计见 [docs/superpowers/specs/2026-11-05-eva-hud-design.md](../../docs/superpowers/specs/2026-11-05-eva-hud-design.md)。

**不要提交或公开这个应用的 `hud/fonts/` 和构建产物（`.mgu`）。** 里面有 MatissePro 字形。字体怎么准备，见仓库根目录的 `README.md`。

## 在 Mac 上预览

```sh
BENCH_PORT=8080 node bench/server.js eva_hud    # 然后打开 http://localhost:8080
```

- 页面默认跑模拟驾驶，模拟数据不会触发警报。
- 设置里的 **Preview an alert** 可以逐个看警报。
- 切到 **Manual** 后，滑块多了 `knock`、`fuel`、`afr`、`pedal`、`burn`（L/h，Eco Pro 的燃料消費），前几个能触发真实的警报逻辑。`gear` 的 -1 是倒挡，0 是 P 挡。

```sh
node bench/test/eva_alerts_test.js     # 警报规则
node bench/test/eva_diag_test.js       # 发动机控制单元读数
node bench/test/eva_layout_test.js     # 生成的布局：层数、内存、可见范围、避开 BMW 车速
node bench/test/eva_popups_test.js     # 从 cluster-render 日志判断 BMW 弹窗
node bench/test/eva_dash_test.js       # 两块屏和三种模式（整个 app 在桩上运行）
```

默认页面看 HUD，左下角白色的车速和限速牌是 BMW 内容的替身。看仪表用 `BENCH_VIEW=panel`，一次只开一个 bench。

## 三种模式

设置里的 **Mode**：HUD only、Dash only、HUD + Dash。每种模式有自己的布局和内存方案。驾驶模式不会切换模式，只决定用这个模式的哪一版布局（`shared/eva_hud.js` 的 `HUD_ONLY`）。

| 模式 | Sport | Comfort | Eco Pro |
| --- | --- | --- | --- |
| HUD only | `hud_only_sport` | `hud_only_comfort` | `hud_only_eco` |
| Dash only | `dash_eva` | 同左 | 同左 |
| HUD + Dash | `eva` + `dash_eva` | 同左 | 同左 |

BMW 的车速去不掉，所以 HUD 不画自己的车速，布局给它留了位置（`tools/eva_layout.py` 的 `BMW_ZONE`）。

- **Sport：** 战斗风格，橙色，巨大挡位，超转时闪烁，右栏是 NERV 标志和油门条。
- **Comfort（最常用）：** 黄昏色，3 层。四个角框，第3新東京市，巨大的时间，续航；右下是四轮胎压和胎温。没有挡位、转速和发动机温度。胎压偏低变琥珀色：比车上给的目标低 0.3 bar 或更多，没有目标时低于 2.0 bar。
- **Eco Pro：** 夜色蓝，3 层。四个角框，節電、活動限界，最大的是续航，下面是时间；右下是燃料消費（L/100km，低于 5 km/h 或挂 P、R、N 时显示 `--`，来自发动机控制单元的 `5656` 或 `OBD 5E`）。
- **Comfort 和 Eco Pro 的大字：** 只在挂进 P、R、N 时出现在右侧空白处，开起来就淡出，D 挡等红灯时也不显示。P 是 `出撃待命`，R 是 `緊急撤退`（琥珀色），N 是 `同期解除`。

三版的警报都一样，是全屏红色。

## 量可见范围

当前按 `124 100 552 280` 生成：`100/100` 标签显示成 `0/100`，所以左边缘约在 x=122；顶边在 y=380 的歌名被切掉，所以下边缘取 380。右边缘是按左右对称假设的。换范围时运行下面的命令。文字放不下或部件重叠时它会报错，并且不改动现有文件：

```sh
uv run --no-project --with pillow python tools/eva_layout.py <x> <y> <宽> <高>
```

## 装上车

车机地址和密钥在 `idrive7-8-ssh-root/data/enrollments/<VIN>/`。这台车每次重启都会换 SSH 主机密钥，要重新 `ssh-keyscan`，并核对 MAC 或 VIN。

1. **cluster-render（已装）：** 用 `mgu-store/deploy/hu install --artifact mgu-deploy@<版本>.tgz --artifact cluster-render@<版本>.tgz`，包来自两个仓库的 GitHub Release。不需要装完整的 Store。它要重启车机才生效，还会自动打开 provisioning fallback。
2. **构建：** `bench` 的包用的是假 SDK，不能装车。要临时换成真实 SDK：

```sh
mv oap-sdk oap-sdk.bench-stub
ln -s ../idrive7-apps/oap-sdk oap-sdk
python3 kit/tools/build.py eva_hud     # 产物是 dist/eva_hud@<版本>.mgu
rm oap-sdk && mv oap-sdk.bench-stub oap-sdk
```

3. **安装：** 把 `.mgu` 传到车上的 `/var/opt/mgu-custom-apps/apps/`，在 `/var/opt/mgu-custom-apps` 下运行：

```sh
sh mgu-app-install.sh verify apps/eva_hud@<版本>.mgu
sh mgu-app-install.sh install apps/eva_hud@<版本>.mgu
```

**应用在运行时更新，会重启应用平台，这台车上实测会带动整个车机重启。** 重启后要在中控屏点开 EVA HUD，它才会运行。

**卸载：** `sh mgu-app-install.sh uninstall eva_hud`；cluster-render 用 `sh /var/opt/mgu-deploy/mgu-deploy.sh uninstall cluster-render --yes`。

## 上车后要确认

1. 可见范围的右边缘和下边缘（见上）。
2. 每个诊断 ID 能否读到、数值是否合理。读不到的会显示在中控屏状态行，对应警报自动不触发。
3. 阈值。默认值是在不知道发动机型号时取的保守值，增压、水温和油压都要按实车调。
4. 用 **Preview an alert** 看白天和夜间玻璃上的效果：字清不清楚，挡不挡前车。
5. Comfort 和 Eco Pro：续航、胎压、胎温、目标胎压和燃料消費能否读到，数值是否合理；时间的时区对不对；四角框左下角是否正好在 BMW 车速上方。
6. EVA HUD 显示时，BMW 自己的导航箭头和限速是否还在。不在的话，可以开 **Change with SPORT / COMFORT / ECO PRO**，让部分驾驶模式交还给 BMW。
