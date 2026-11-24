# 自己用的一个相册 (v1.2.0)

适用于 **macOS、Linux 和 Windows** 的本地相册。支持浏览和整理 **10 万级照片与视频**、按硬盘目录管理原片，以及在局域网内和家人共享图库。识别、索引和缩略图生成在本机完成。

---

## 核心特性

### 1. 10 万级多媒体极速浏览与全格式支持
- **按月分桶虚拟时间轴**：10 万张照片分桶检索仅需 ~13ms；配合 Justified 自适应等高瀑布流、持久高度缓存零抖动滚动、ThumbHash 瞬时模糊占位、多级带 `mtime` 校验的 WebP 缩略图、右侧全跨度防重叠年份速览滑块，以及按区间拉取的 `Shift + 点击` 连选。
- **全格式与硬件加速播放**：原生支持 JPG / PNG / WebP / AVIF / HEIC / 主流相机 RAW / Apple 实况照片（自动通过 ContentIdentifier 与同名 `.mov` 免重复探测配对）；视频支持 **3 秒静音悬停预览**（带缓存容量清理与奇数宽度兼容）、HTTP `206` Range 秒拖拽，以及不兼容编码一键 fMP4 实时转码（支持转码流进度跳转条）。

### 2. 本地 AI 识别与检索
- **中英文截图与文档 OCR（Tesseract.js 离线引擎）**：自动提取截屏、发票、证件、车票与路牌中的中英文文字并同步写入 SQLite FTS5 全文索引，顶部搜索框直接搜图中文字。
- **离线人脸检测与人物相册（Human WASM 引擎）**：自动检测人脸特征向量并采用增量内存质心聚类生成人物相册，支持人物命名、合并重复人物、隐藏次要人物，以及在灯箱详情内对单张人脸一键**纠错重归属 / 拆分新人物**；重扫索引自动保留已命名人物归属。
- **AI 自然语言语义搜图 & 以图搜图（SigLIP2 多语言视觉模型）**：支持用自然语言描述画面内容搜图（如“海边日落”“草地上的小狗”），以及从任意照片一键查找视觉构图相似照片；统一走 HEIC/RAW 解码与灰度图 `srgb` 转换，外置硬盘离线时自动延后索引而非跳过；首次启用支持切换官方源或国内加速镜像下载模型并永久离线缓存。

### 3. 超越传统相册的整理与挑片工作台
- **双轨相册体系（真实硬盘目录树 + 跨目录虚拟精选集）**：
  - **相册目录树**：实时映射真实硬盘文件夹（含空文件夹），拖拽或批量移动照片即物理移动原文件（连同关联实况 `.mov`），支持多级目录创建与自定义文件夹封面。
  - **虚拟精选集 & 动态智能相册**：不改动磁盘原文件位置，既可手动组合主题影集，也可按星级、收藏、媒体类型、RAW、实况、截屏、体积、标签与日期范围创建实时更新的**动态智能相册**。
- **精确查重 + 相似连拍并排挑片**：同时提供 SHA-256 精确重复清理与 64-bit dHash 相似连拍聚类；内置 **2–4 张并排放大对比挑图器**（支持同步缩放平移与单张独立缩放平移，一键仅保留最佳照片）。
- **批量时区/时间与地点修正 & 物理旋转**：支持相机跨时区小时偏移、统一指定拍摄时间/地点，以及单张静态照片的 90°/270° 物理旋转。旋转前会在照片同目录的 `.lumina-originals` 下保存可恢复的逐字节原片，并在完成提示中显示路径。多帧、多页和实况照片保留原样。
- **足迹地图、那年今日与空间瘦身分析**：内置离线逆地理编码词典自动解析「国家 · 省份 · 城市」并在交互式地图聚合展示；自动生成往年同日回忆卡片；按照片/视频/实况/RAW/截屏可视化统计占用空间并定位大文件。
- **外部重命名追踪 & 外接硬盘掉线熔断防丢**：在 Finder / 文件管理器中移动或重命名照片后，增量扫描自动按文件指纹原地迁移全部星级、收藏、标签与备注；外接硬盘拔出时自动触发防误删熔断保护。

### 4. 家庭多成员权限隔离、断点续传与元数据备份
- **家庭多账号与图库级权限隔离**：支持配置独立管理口令及多成员账号（支持在线编辑昵称、角色、重置口令与可见图库），提供 `管理员 (admin)`、`可整理成员 (member)`、`只读访客 (viewer)` 三级角色，并按 `allowedLibraryIds` 贯穿媒体、相册、标签、智能相册、人物/AI 检索与 SSE 进度全链路隔离；会话令牌支持 30 天有效期、登出服务端吊销（`revoked_sessions`）以及私有资源 `Cache-Control: private`。
- **文件夹口令与排除显示**：可给指定文件夹设置访问口令，或将该目录从全局相册和搜索中排除。
- **大文件/大视频分片断点续传**：浏览器上传自动按 4MB 分片并记录进度检查点（内置单文件与分片上限防滥用），网络波动中断后重传自动秒续并做 SHA-256 查重。
- **局域网 mDNS / Tailscale 访问与隐私脱敏分享**：支持安全 Data URL 二维码扫码直连与公开分享链接 `/s/<token>`（支持独立口令、防爆破限流、过期时间，以及照片、视频和实况视频的脱敏浏览与下载）。
- **一键元数据备份与安全恢复**：原子写入打包导出全部精选集、标签、星级、收藏、备注、OCR 文字与人物命名归属（自动脱敏剔除用户口令哈希、会话吊销记录与外链分享令牌）；恢复前自动创建 `pre-restore` 安全快照并校验 ZIP 条目大小和 CRC，按图库身份、相对路径和内容指纹匹配媒体，无可靠匹配的记录会跳过并显示数量。备份支持查看进度和取消。

> 元数据备份不包含原始照片或视频。请另行将原文件备份到独立位置。移动文件或跨磁盘移动相册时，来源会保留在原位置附近的 `.lumina-retained-original-*` 或 `.lumina-retained-folder-*` 隐藏目录，供并发修改或中断后恢复，因此不会立即释放来源磁盘空间。失败时还可能保留 `.lumina-transfer-recovery-*` 或 `.lumina-rot-*` 文件；请核实内容并另行备份后，再按需要手动整理。

## 隐私与数据

- 原片存放在选择的图库目录里。索引、缩略图、离线模型和备份默认存放在 `~/.lumina-photo`，可通过 `LUMINA_DATA_DIR` 更改。
- 相册网页中的文件夹「加密」为网页访问加设口令。拥有系统文件权限的用户可以直接访问原片。排除规则控制目录在全局相册和搜索中的展示。
- 地图默认使用离线底图。切换到在线底图后，底图提供方会收到瓦片坐标、缩放级别和请求端 IP，可据此推断浏览的区域。安装依赖和下载离线 AI 模型时也会连接对应的软件源。
- 元数据备份可能包含图库路径、文件名、拍摄位置、OCR 文字、备注、人物归属和文件夹口令的哈希，请按私人数据保管。分享链接含有访问令牌，创建时可为接收者设置口令和有效期。

---

## 快速启动

### 环境要求
- **Node.js 22.16+ 或 24+**（推荐 24 LTS）。使用 Node 内置 `node:sqlite` 的 FTS5 全文搜索，无需安装 Docker 或外部数据库服务。
- Linux 还需要带 `ctypes` 的 Python 3，以调用内核的原子文件操作。

### 获取源码

```bash
git clone https://github.com/lldynamics/lumina-photo.git
cd lumina-photo
```

按下方对应平台的方式启动，随后在浏览器打开 `http://localhost:3840`。首次使用时按页面提示添加图库目录。

### 方式一：macOS 桌面应用双击启动（推荐，无终端窗口 + 右上角菜单栏图标）
1. 首次运行时安装依赖，并构建应用与图标：
   ```bash
   npm run install:all
   npm run build && npm run build:desktop
   ```
   如需将应用安装到 `~/Applications`（方便在「启动台」或 Spotlight 搜索打开）：
   ```bash
   npm run desktop:install
   ```
2. 直接双击项目根目录（或 `~/Applications`）中的 **`自己用的一个相册.app`** 即可启动。不会弹出终端黑窗口，系统右上角菜单栏会出现相册图标，菜单内支持：
   - 一键打开相册、一键复制本机 / 局域网 / Tailscale 地址
   - 开启或关闭「开机自动启动」（写入 macOS `LaunchAgent`）
   - 打开数据目录、查看运行日志、重启服务、安全退出
3. 也可在 Finder 中双击项目里的 [start-mac.command](start-mac.command) 启动，会自动显示菜单栏图标并打开浏览器。

### 方式二：Linux / macOS 命令行启动（桌面环境自动带系统托盘）
```bash
./start.sh
```

首次运行时，`start.sh` 会安装依赖并构建项目。依赖已安装时，也可以运行 `npm start`。

- **macOS**：`npm start` 与 `./start.sh` 也会在屏幕右上角菜单栏自动显示相册状态图标（通过 SSH 无界面会话运行或设置 `LUMINA_NO_TRAY=1` 时自动跳过）。
- **Linux 桌面**：自动检测系统托盘组件（支持 `AyatanaAppIndicator3` / `AppIndicator3` / GTK StatusIcon / PyQt6 / PyQt5），点击托盘同样支持打开相册、复制地址、开关「开机自动启动」、查看日志与安全退出；也可运行 `npm run desktop:install` 注册系统应用菜单快捷方式 `lumina-photo.desktop`。无图形界面的服务器或 NAS 会自动以纯后台无托盘模式静默启动。
- **纯无头模式启动**：`npm run start:headless`（或设置 `LUMINA_NO_TRAY=1`）。

### Windows 命令行启动

在项目目录打开命令提示符，运行 `npm run install:all`，再运行 `npm start`。服务启动后可在浏览器打开 `http://localhost:3840`。

Windows ARM64 使用原生 Node.js 时，视频处理需要系统提供 FFmpeg。将 `ffmpeg.exe` 和 `ffprobe.exe` 所在目录加入 `PATH`，或通过 `FFMPEG_PATH` 和 `FFPROBE_PATH` 指定可执行文件的完整路径。

Windows 单文件复制、移动、物理旋转和跨磁盘相册移动使用系统复制，并核对扩展属性（EA）及附加数据流；目录复制还会核对访问控制条目。无法核对或目标文件系统不支持相应属性时会停止并保留来源。含链接或其他重解析点的目录、不能查询卷能力的路径（包括部分 SMB 网络共享）以及只读文件可能无法完成上述操作。

安全物理旋转要求文件系统支持硬链接及可靠的原子替换。macOS 当前仅对本地 APFS 启用，Linux 对常见本地文件系统启用；其他不支持安全操作的卷会保留原片并报错。旋转会保留原片快照及实际被替换的版本，所需空间会增加。

### 使用 HTTPS 访问

本机 HTTP 默认仍可用。为避免口令和照片在普通局域网明文传输，服务默认拒绝向非本机地址提供 HTTP。先在本机设置管理员口令或家庭账号，再准备受访问设备信任的 PEM 证书链与私钥。证书的 SAN 必须包含实际访问的域名或 IP；请将私钥放在项目和备份目录之外，仅允许当前用户读取。

Linux / macOS 示例（地址和文件路径均需替换）：

```bash
HOST=0.0.0.0 \
LUMINA_TLS_CERT=/path/to/fullchain.pem \
LUMINA_TLS_KEY=/path/to/private-key.pem \
LUMINA_PUBLIC_ORIGIN=https://photos.example:3840 \
./start.sh
```

Windows PowerShell 示例：

```powershell
$env:HOST = '0.0.0.0'
$env:LUMINA_TLS_CERT = 'C:\path\fullchain.pem'
$env:LUMINA_TLS_KEY = 'C:\path\private-key.pem'
$env:LUMINA_PUBLIC_ORIGIN = 'https://photos.example:3840'
npm start
```

`LUMINA_PUBLIC_ORIGIN` 是设备实际使用的 HTTPS 地址，必须可以从访问设备解析并连接；启用内置 TLS 时，启动会检查其主机名与证书 SAN 是否匹配。设备还必须信任签发证书的机构；不要通过忽略证书警告访问。需要使用反向代理时，可保持服务只监听本机 HTTP，并让代理提供可信 HTTPS；代理必须覆盖客户端传来的转发头，并准确设置 `X-Forwarded-Proto: https` 与 `X-Forwarded-Host`。若设置公开地址，二维码和分享链接会使用该地址。只有在网络隔离保证后端只能被可信远程代理访问时，才应启用 `LUMINA_TRUST_PROXY`。

若使用 Tailscale 承载 HTTP，应确认双方确实位于受信任的 Tailnet，仅将 `HOST` 绑定到已确认的 Tailscale IP，再显式设置 `LUMINA_ALLOW_INSECURE_LAN=1`。这个开关不会给 HTTP 加密；绑定到 `0.0.0.0` 也会向普通局域网暴露明文服务。

### 开发与测试命令
```bash
npm run install:all    # 安装前后端依赖
npm run typecheck      # 运行服务端与前端 TypeScript 静态类型检查
npm run build          # 原子化编译服务端与按需拆包前端静态资源
npm run build:desktop  # 生成 macOS「自己用的一个相册.app」/ Linux 桌面启动器与图标资源
npm run desktop:install # 将桌面应用快捷方式安装到 ~/Applications 或 ~/.local/share/applications
npm test               # 运行全部服务端与前端自动化测试（typecheck/test/build 已接入 GitHub Actions CI）
npm run test:server    # 仅运行服务端单元、性能与安全回归测试
npm run test:web       # 仅运行前端核心工具单元测试
npm start              # 启动生产服务并自动显示系统菜单栏 / 托盘图标
npm run start:headless # 以纯命令行无托盘模式启动
```

---

## 常用快捷键（时间轴与灯箱）

| 快捷键 | 功能说明 |
| :--- | :--- |
| `←` / `→` | 灯箱内切换上一张 / 下一张（自动跨月预加载） |
| `1` – `5` / `0` | 快速打星评级（1–5 星）或清除星级 |
| `F` | 切换收藏状态 |
| `R` / `Shift + R` | 顺时针 / 逆时针物理旋转照片 90° |
| `I` | 展开 / 收起右侧拍摄参数、OCR 文字与人物归属面板 |
| `X` / `Delete` | 将当前照片安全移入软件回收站（不直接删盘，二次确认才进系统废纸篓） |
| `Shift + 点击` | 时间轴区间连选多张照片（可选 2–4 张开启并排对比） |
| `Esc` | 退出灯箱、对比视图或取消多选 |

---

## 环境变量配置

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3840` | Web 服务监听端口 |
| `HOST` | `127.0.0.1` | 默认仅本机访问；监听非本机地址需要配置 HTTPS，或显式允许明文 HTTP |
| `LUMINA_TLS_CERT` / `LUMINA_TLS_KEY` | 空 | 同时设置 PEM 证书链和私钥文件路径以启用内置 HTTPS（TLS 1.2 及以上）；配置不完整或无效时拒绝启动 |
| `LUMINA_PUBLIC_ORIGIN` | 空 | 可选的 HTTPS 访问源地址，如 `https://photos.example:3840`；用于访问向导及分享二维码 |
| `LUMINA_ALLOW_INSECURE_LAN` | 空 | 设为 `1` 才允许非本机 HTTP；仅在已经确认传输层受到保护时使用 |
| `LUMINA_DATA_DIR` | `~/.lumina-photo` | SQLite 数据库、缩略图缓存、离线模型与备份存放目录 |
| `LUMINA_LG_CACHE_MB` | `4096` | 1800px 高清预览图 LRU 磁盘缓存上限（MB） |
| `LUMINA_ADMIN_PASSCODE` | 空（可在网页「安全与成员」设置） | 可选通过环境变量强制指定管理员访问口令 |
| `LUMINA_ALLOWED_ROOTS` | 不限制 | 可选限制允许浏览/导入/导出的宿主机根目录白名单（逗号或系统路径分隔符分隔） |
| `LUMINA_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 允许跨域访问的开发前端源地址（本机反代或启用 `LUMINA_TRUST_PROXY` 时自动兼容 `X-Forwarded-Host` 同源校验） |
| `LUMINA_TRUST_PROXY` | `false` | 若服务部署在非本机反向代理（Nginx / Caddy / Traefik）之后，设为 `true` 或 `1` 以信任 `X-Forwarded-*` 请求头（用于 HTTPS Cookie `Secure`、同源 Origin 校验与按真实客户端 IP 限流） |
| `LUMINA_NO_TRAY` | 空 | 设为 `1` 时禁用右上角菜单栏 / Linux 系统托盘图标 |
| `LUMINA_OPEN_ON_READY` | 空 | 设为 `1` 时服务就绪后自动在默认浏览器打开页面 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 内置静态二进制 | 可选覆盖指定系统自定义 `ffmpeg` / `ffprobe` 路径 |

## 许可证

本仓库的原创内容采用 [MIT 许可证](LICENSE)。第三方依赖、AI 模型和在线地图瓦片遵循各自的许可证及署名要求。导入的照片和视频适用原有授权。
