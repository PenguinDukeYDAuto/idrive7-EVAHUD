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
node bench/test/eva_dash_test.js       # 两块屏、三种模式和仪表的设计（整个 app 在桩上运行）
node bench/test/eva_magi_test.js       # 方案 A 的 MAGI 判定
node bench/test/eva_demo_test.js       # demo 数据的一轮
```

默认页面看 HUD，左下角白色的车速和限速牌是 BMW 内容的替身。app 只画在一块屏上时，页面会自动跟过去；HUD + Dash 时用 `BENCH_VIEW=panel` 看仪表，一次只开一个 bench。

## 三种模式

设置里的 **Mode** 是总开关：HUD only、Dash only、HUD + Dash。每种模式有自己的布局和内存方案，也有自己的选项：Comfort、Sport、Eco Pro 各选各的画面。菜单只显示当前模式用得到的那几行。

| Mode | 菜单里的选项 | 可选的画面 | 默认 |
| --- | --- | --- | --- |
| HUD only | **Comfort / Sport / Eco Pro HUD (HUD only)** | Comfort、Sport、Eco Pro、关闭 | 各用各的 |
| Dash only | **Comfort / Sport / Eco Pro dash (Dash only)** | 十种仪表设计、关闭 | Original |
| HUD + Dash | **Comfort / Sport / Eco Pro HUD (HUD + Dash)** | Battle display（`eva`）、Comfort、Sport、Eco Pro、关闭 | Battle display |
| HUD + Dash | **Comfort / Sport / Eco Pro dash (HUD + Dash)** | 十种仪表设计、关闭 | Original |

HUD 的 Sport、Comfort、Eco Pro 分别是 `hud_only_sport`、`hud_only_comfort`、`hud_only_eco`。**Design B: middle shows** 只在某个驾驶模式选了方案 B 时才出现。车还没报告驾驶模式时，按 Comfort 的选择。切换驾驶模式时，如果画面不同，会释放和重新申请显示位置，所以换过去要等一下。

0.5.0 的设置会自动迁移一次：原来的 Dash design 等选择填到三个驾驶模式，By drive mode 变成 HUD + Dash，每个驾驶模式的结果不变。

BMW 的车速去不掉，所以 HUD 不画自己的车速，布局给它留了位置（`tools/eva_layout.py` 的 `BMW_ZONE`）。

- **Sport：** 战斗风格，橙色，巨大挡位，超转时闪烁，右栏是 NERV 标志和油门条。
- **Comfort（最常用）：** 黄昏色，4 层。四个角框，第3新東京市（28 px），巨大的时间（冒号每 4 秒呼吸一次，单独一层，只改透明度），续航；右下是一句中二文字，在菜单 `Comfort message` 里六选一，默认是 NERV 格言 `神ハ天ニ在リ` / `世ハ全テ事モ無シ`。没有挡位、转速、发动机温度和胎压。
- **Eco Pro：** 夜色蓝，3 层。四个角框，節電、活動限界，最大的是续航，下面是时间；右下是燃料消費（L/100km，低于 5 km/h 或挂 P、R、N 时显示 `--`，来自发动机控制单元的 `5656` 或 `OBD 5E`）。
- **Comfort 和 Eco Pro 的大字：** 只在挂进 P、R、N 时出现在右侧空白处，开起来就淡出，D 挡等红灯时也不显示。P 是 `出撃待命`，R 是 `緊急撤退`（琥珀色），N 是 `同期解除`。

三版的警报都一样，是全屏红色。

## 仪表的设计

菜单随时可以切换，不用重启 app：

| 选项 | 画在哪里 | 颜色 | 内容 | 布局 |
|---|---|---|---|---|
| Original | 整块仪表 | 橙 | 原来的设计，默认值 | `dash_eva` |
| A: Command room | 工字形 | 橙 | 状态行和转速条、巨大挡位和四行读数、MAGI 出撃判定 | `dash_a` |
| B: Active limit | 工字形 | 橙 | 七段数字显示续航或时间（**Design B: middle shows**）、电源灯和模式灯、读数 | `dash_b` |
| D: Battle stations | 整块仪表 | 橙 | 车速、实时转速、巨大挡位、一列读数 | `dash_d` |
| C1: Big clock | 工字形 | 橙加白 | 巨大时间、标语、续航 | `dash_c1` |
| C2: Title card | 工字形 | 橙加白 | 标语铺满，每行放到最大 | `dash_c2` |
| C3: Tokyo-3 | 整块仪表 | 橙加白 | 时间、续航、巨大车速、竖排标语 | `dash_c3` |
| E1: Fuel use | 工字形 | 蓝 | 大字油耗和段条、续航、时间、标语 | `dash_e1` |
| E2: Hex rings | 工字形 | 蓝 | 七圈六边形随油耗点亮、续航、时间、标语 | `dash_e2` |
| E3: Active limit | 整块仪表 | 蓝 | 车速、油耗、七段续航、时间、电源灯和模式灯 | `dash_e3` |

菜单 **EVA message** 选的标语，所有带标语的设计共用。P、R、N 时标语让位，显示 出撃待命、緊急撤退、同期解除。

**工字形设计投 `map`，整块仪表的设计投 `panel`。** `map` 在 BMW 表盘下面，BMW 的表、数字车速、G 力表和 BC 区都在 EVA 上面，照常工作，表盘两侧的黑化也压在 EVA 上。设计只用它们留下的明亮区域，在 `tools/eva_layout.py` 的 `CLEAR_SHAPE` 和 `BMW_LINE`，从两张实拍量出来，车主确认其他驾驶模式的表盘只有颜色不同。**中控屏的 Central display area 要设成 Map view 或 Off。** 选 Route preview、Assisted Driving View 时中间归 BMW。开车门或手机重连会锁住这个位置，解锁后最长隔 30 秒重试。

0.5.0 曾把工字形设计投到 `panel`。`panel` 在表盘上面，结果盖住了 BMW 的数字车速，右侧 BC 区也不能用，所以 0.5.1 改了回来。Original、D、C3、E3 还在 `panel` 上，它们本来就盖住整块仪表，同样用不了 BC 区。

工字形设计共用报警布局 `dash_centre_alert`，只占中间 584×444，不会被 BMW 挡住，六种报警和 HUD 相同，平时的图不用丢。整块仪表的设计和 Original 共用 `dash_alert`，报警时要丢图，结束时要重传。

MAGI 看全屏报警不会出现的情况（`shared/eva_magi.js`）：

| | 看什么 | 審議中 | 承認 | 否決 |
|---|---|---|---|---|
| MELCHIOR·1 | 油温 | 低于 80°C 或没有读数 | 80–129°C | 130°C 以上 |
| BALTHASAR·2 | 水温 | 低于 70°C 或没有读数 | 70–109°C | 110°C 以上 |
| CASPER·3 | 驱动 | P、R、N | 行驶中 | 到换挡点 |

## 时间

车机的系统时钟是 UTC，app 也读不到车机的时区，所以时间用菜单里的 **Time zone (GMT offset)** 换算，默认 `GMT-5`。没有夏令时自动切换：在加拿大东部，冬天用 `GMT-5`，夏天用 `GMT-4`。选 `Head unit's clock` 就直接用系统时钟。

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

## Demo 数据

菜单 **Demo data** 打开后，一轮 22 秒循环（`shared/eva_demo.js`）：

- **前 10 秒是行驶：** 全油门连升四挡到换挡点，六挡高速摆动，五挡加速，急刹，再依次 N、R、P。途中油温和水温先后过高，MAGI 会否決。
- **后 12 秒是报警：** 非常事態、燃圧喪失、空燃比異常、冷却過熱、増圧限界、多重警報，每种 2 秒，车停在 P。

菜单 **Full-screen alerts** 关掉后，demo 也不显示报警。**Preview an alert** 优先。

## 上车后要确认

- 工字形设计投 `map` 后，右侧 BC 区是否恢复，BMW 的数字车速是否完整。
- Central display area 设 Off 时是否一次就显示。Map view 下要和原厂地图抢位置，第一台车上约八成的尝试抢输，连输时要隔 10 秒、30 秒才再试，看起来就像加载失败。
- 开车门后多久回来。
- 菜单的行能否按 Mode 显示和隐藏：app 用 `ui.visible`，这个用法还没在车上的下拉菜单试过。隐藏不了时，所有行都会显示，功能不受影响。
- 切换驾驶模式时，新画面多久出来。
- 新的 shader（`evahex`、`evahazard`、`evaseven`、`evarings`）在 KOMBI 上的显示和负载。

1. 可见范围的右边缘和下边缘（见上）。
2. 每个诊断 ID 能否读到、数值是否合理。读不到的会显示在中控屏状态行，对应警报自动不触发。
3. 阈值。默认值是在不知道发动机型号时取的保守值，增压、水温和油压都要按实车调。
4. 用 **Preview an alert** 看白天和夜间玻璃上的效果：字清不清楚，挡不挡前车。
5. Comfort 和 Eco Pro：续航和燃料消費能否读到，数值是否合理；四角框左下角是否正好在 BMW 车速上方。
6. EVA HUD 显示时，BMW 自己的导航箭头和限速是否还在。不在的话，可以开 **Change with SPORT / COMFORT / ECO PRO**，让部分驾驶模式交还给 BMW。
