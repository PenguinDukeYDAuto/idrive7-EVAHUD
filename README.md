# idrive7-EVAHUD

把 BMW iDrive 7（MGU）的挡风玻璃 HUD 和仪表盘画成《新世纪福音战士》NERV 作战界面的 app。

作者：DukeAPenguin。这是非官方的个人项目，和 BMW、khara 以及下面列出的上游作者都没有关系。改装车机的风险由你自己承担。

> **本仓库不包含任何字体**，也不包含构建好的 `.mgu` 和 BMW 的 `oap-sdk`。没有字体就无法构建，做法见[字体](#字体)。NERV 标志包含在仓库里。

## 功能

- **三种模式：** HUD only、Dash only、HUD + Dash，在中控屏菜单里选。每种模式有自己的布局和内存方案。
- **HUD only 跟随驾驶模式换版面：**
  - Sport：战斗风格，巨大挡位和转速条。
  - Comfort：时间、续航和一句中二文字（菜单里六选一）。
  - Eco Pro：续航、时间和油耗。
- **挡位大字：** Comfort 和 Eco Pro 挂进 P、R、N 时显示 `出撃待命`、`緊急撤退`、`同期解除`，开起来就消失。
- **全屏警报：** 爆震、燃油压力、空燃比、水温、增压。
- **只读：** 发动机数据只读取，不向车辆写入。
- **避让 BMW 内容：** BMW 自己的 HUD 车速去不掉，版面给它留了位置；BMW 弹窗出现时自动让路。

更多内容见 [apps/eva_hud/README.md](apps/eva_hud/README.md)、[设计文档](docs/superpowers/specs/2026-11-05-eva-hud-design.md) 和[性能研究](docs/superpowers/2026-11-05-eva-hud-performance.md)。

**当前状态：** 车上跑的是较早的 0.3.1，显示正常。之后的时区设置和 Comfort 改动（文字加大、菜单选文字、去掉胎压）只在模拟器里验证过，还没有装车。

## 开发自哪些项目

| 上游项目 | 作者 | 本仓库用到的部分 | 许可证 |
|---|---|---|---|
| [bimmer-lab/apps](https://github.com/bimmer-lab/apps) | bimmer-lab | 直接上游。`shared/` 的 HUD Widgets 绘制引擎、`bench/` 模拟器、`tools/bake_fonts.py`、仓库结构 | MIT |
| [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) | cauliflowermossgrape（中文翻译：小白151 / JackieZ123430） | `kit/` 的 MGU App Kit；`app.json` 里发动机控制单元的诊断 ID 和换算（来自 car_vitals 和 Live Data）；换挡评分和转速条（来自 Redline，经 bimmer-lab/apps 移植） | MIT |
| [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) | Robert Nisipeanu | `shared/cluster_render_client.js`（未修改）；运行时依赖它的 cluster-render 服务，需要单独安装，**不在本仓库** | 客户端 MPL-2.0，服务 GPL-3.0 |

另外：

- `shared/eva_popups.js` 的弹窗让路做法，和 cluster-render 里 eroobeeroo 贡献的 `hud_yield_slots` 是同一思路。HUD 使用的 slot `0x323` 也是 eroobeeroo 先在实车上验证的。
- 视觉风格来自作者自己的 EVA HUD 手机项目。
- NERV 标志出自《新世纪福音战士》（khara）。

### 基准版本

| 上游 | 版本 |
|---|---|
| bimmer-lab/apps | `44a50c5`。上游之后又加了 4 个主题提交，没有合并 |
| MGU App Kit | 随 bimmer-lab/apps `44a50c5` 带来 |
| cluster-render | `cluster-render@0.3.10`（`bbcbe42`）。`0.4.0` 也在车上跑过，显示正常，弹窗让路还没验证 |

这个仓库是一次全新的提交，**没有带上游的 git 历史**，因为上游历史里有字体文件。

### 和上游的差别

新增：

- `apps/eva_hud/`
- `shared/eva_*.js`
- `tools/eva_layout.py` 和 `tools/assets/`
- `bench/test/`
- `docs/superpowers/`

修改：

- `shared/hud.js`、`hud_themes.js`、`layouts.js`、`shaders.js`
- `bench/` 的模拟器
- `tools/bake_fonts.py`
- `kit/tools/build.py`：`app.json` 可以用 `credits` 指定菜单最后一行的署名
- `scripts/deploy.sh`、`docs/DEVELOPING.md`：默认指向 `eva_hud`

删除：

- 上游的 `apps/cluster_themes`、`apps/idrive_hud_widgets`
- `docs/images/`、`mgu-repo.json`
- 所有字体

## 字体

仓库里没有字体文件，也没有烘焙好的字形。`.gitignore` 会挡住这些路径和字体扩展名。

构建前需要自己准备：

| 字体 | 放在哪里 | 来源 | 许可 |
|---|---|---|---|
| MatissePro EB（`MatissePro-EB.otf`） | 任意位置，用环境变量 `MATISSE` 指定 | 商业字体，需要自己取得授权 | 商业授权 |
| Barlow Condensed Bold 和 SemiBold（`BarlowCondensed-Bold.ttf`、`BarlowCondensed-SemiBold.ttf`） | `tools/fonts-src/` | [Barlow](https://github.com/jpt/barlow) | SIL OFL 1.1 |

然后烘焙字形，生成 `apps/eva_hud/hud/fonts/`：

```sh
MATISSE=/path/to/MatissePro-EB.otf uv run --no-project --with pillow python tools/eva_layout.py
```

**构建产物 `.mgu` 里含有 MatissePro 字形，不要发布到 Releases 或其他公开位置。**

## 构建和测试

需要 Node、Python 3，以及上一步生成的字体。

```sh
node bench/server.js eva_hud        # Mac 上的模拟器，打开 http://localhost:8078
```

模拟器第一次运行时会生成一个假的 `oap-sdk/`，它不能装车。测试也需要这个文件夹，所以先运行一次模拟器，然后：

```sh
for t in flicker layout popups alerts canvas diag dash; do node bench/test/eva_${t}_test.js | tail -1; done
```

装车要用从 BMW app 提取的真实 `oap-sdk`，它不能再分发，所以不在这里。步骤见 [apps/eva_hud/README.md](apps/eva_hud/README.md#装上车)。**应用运行时更新会带动车机重启，开车时不要装。**

## 许可证

本仓库的代码使用 [MIT](LICENSE)，以下部分除外：

| 部分 | 许可 |
|---|---|
| `kit/` | MIT，版权归原作者，见 [kit/LICENSE](kit/LICENSE) |
| `shared/cluster_render_client.js` | MPL-2.0，版权归 Robert Nisipeanu |
| `apps/eva_hud/hud/logos/`、`tools/assets/nerv_mask.png`、`apps/eva_hud/icon.png` 里的 NERV 标志 | 不在 MIT 授权范围内，相关权利归权利人所有 |

第三方说明见 [apps/eva_hud/NOTICE](apps/eva_hud/NOTICE)。

## English summary

An unofficial NERV-style display for the windshield HUD and instrument cluster of BMW iDrive 7 (MGU) cars, by DukeAPenguin.

- **Upstream:** built on [bimmer-lab/apps](https://github.com/bimmer-lab/apps) (bimmer-lab, MIT), [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MGU App Kit, MIT) and [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (cluster-render, installed separately).
- **Not included:** fonts, built packages and BMW's `oap-sdk`. You must supply the fonts yourself to build it; see 字体 above.
- **Licence:** MIT, except the parts listed in the table above.
