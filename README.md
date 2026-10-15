# 🚀 飞牛快传 FnDrop

局域网 / 外网通用的**文件 + 文字**互传服务。手机、电脑打开浏览器就能用，
不用装 App、不用加微信、数据全在自己的机器上。

- **零第三方依赖**：只有一个 `server.js` + 一个静态页面，Node.js 18+ 直接跑
- **Docker / 直接跑 Node** 两种部署，随你方便
- **手机 ⇄ 电脑、电脑 ⇄ 电脑**：谁打开网页谁就是一台“设备”，共享同一个传输区
- **大文件分片上传 + 断点续传**：4MB 一片、3 路并发；断网或关页面后重新选同一个文件自动接着传
- **粘贴即传**：`Ctrl+V` 直接粘贴截图 / 图片 / 文件；粘贴纯文字自动同步到其他设备
- **文字剪贴板**：电脑上复制的文字，手机上点一下“复制”就能粘贴
- **一键复制文件内容**：文本 / 代码类文件点“复制”直接进剪贴板；图片在 HTTPS 下可直接复制图片
- **批量删除**：勾选多个文件，一次删掉
- **实时推送**：SSE 长连接，任何设备上传立刻出现在其他设备上
- **可外网访问**：支持内网穿透 / 反向代理 / 直接挂 TLS 证书，带登录防爆破

---

## 目录结构

```
FnDrop/
├── server.js            # 后端（零依赖，单文件）
├── public/              # 前端（原生 HTML/CSS/JS）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── config.example.json  # 配置模板（复制成 config.json 再改）
├── Dockerfile
├── docker-compose.yml
├── package.json
└── .dockerignore
```

---

## 快速开始

### 方式一：Docker Compose（推荐，NAS / 服务器）

```bash
git clone <本仓库地址> FnDrop && cd FnDrop
cp config.example.json config.json      # 重要：先生成配置文件
# 编辑 config.json，把 password 改成你自己的密码
docker compose up -d --build
```

浏览器打开 `http://机器IP:8080`，输入密码即可。首次构建约 1~2 分钟（只拉 `node:22-alpine`，不装任何 npm 包）。

### 方式二：直接用 Node 跑（Windows / Linux / macOS）

1. 安装 Node.js 18+（[下载](https://nodejs.org/zh-cn/download)）。
2. 复制配置并改密码：

   ```bash
   cp config.example.json config.json
   # 用记事本/编辑器打开 config.json，改掉 password
   ```
3. 启动：

   ```bash
   node server.js
   ```

   屏幕上会打印本机与局域网访问地址，例如：

   ```
   http://127.0.0.1:8080
   http://192.168.1.20:8080
   ```

   > 关掉窗口服务就停。想后台常驻，可自行用 systemd / pm2 / NSSM 之类托管。

> 端口被占用就把 `config.json` 里的 `port` 改成 `8081`；`host` 保持 `0.0.0.0` 才能让别的设备访问。
> **Docker 里读的是环境变量**（优先级高于 `config.json`），用 Docker 时改 `docker-compose.yml` 里的环境变量即可。

---

## 开启外网访问

程序本身已支持外网，关键是让外面的网络能连到你的 `8080` 端口。

### 情况 A：机器有公网 IP（家宽 / 云服务器）

1. 路由器里做端口映射：外网端口 → `内网IP:8080`
2. 在 `config.json` 填 `publicUrl`，界面顶部就会显示它，方便复制给别人：

   ```json
   "publicUrl": "http://你的公网IP:8080"
   ```

3. **务必把密码改成强密码**，公网上一直有人在扫端口。

### 情况 B：没有公网 IP（大内网 / 云电脑）

推荐用**内网穿透**：

- **Cloudflare 隧道**：免费、自带 HTTPS、无需域名。本机跑
  `cloudflared tunnel --url http://127.0.0.1:8080` 即可拿到一个
  `https://xxxx-xxxx-xxxx.trycloudflare.com` 地址（免费临时域名每次重启会变）。
- **Tailscale / ZeroTier**：组虚拟局域网，设备间像在同一局域网里，安全性最好，但每台设备都要装客户端。
- **反向代理 + HTTPS**（有自己的域名和服务器时）：用 Nginx / Caddy 反代到 `127.0.0.1:8080`。
  程序会自动识别 `X-Forwarded-Proto` 和 `X-Forwarded-For`，无需额外配置。Caddy 一行：

  ```
  drop.你的域名.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```

  Nginx 参考：

  ```nginx
  server {
      listen 443 ssl;
      server_name drop.你的域名.com;
      ssl_certificate     /path/fullchain.pem;
      ssl_certificate_key /path/privkey.pem;

      client_max_body_size 512m;

      location / {
          proxy_pass http://127.0.0.1:8080;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_http_version 1.1;
          proxy_set_header Connection "";
          proxy_buffering off;        # SSE 实时推送必须关缓冲
          proxy_read_timeout 3600s;
      }
  }
  ```

> **为什么建议上 HTTPS？**
> 浏览器只在 HTTPS（或 localhost）下才开放剪贴板 API。
> 走 http 时程序会自动降级用 `execCommand` 复制文字，功能不受影响；但**复制图片**只有在 HTTPS 下才行。

---

## 配置项一览

配置文件 `config.json`（直接跑 Node）或环境变量（Docker），环境变量优先。

| config.json 键 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `password` | `APP_PASSWORD` | `123456` | 访问密码，**务必修改** |
| `username` | `APP_USERNAME` | `admin` | 登录账号，留空则只校验密码 |
| `port` | `PORT` | `8080` | 监听端口 |
| `host` | `HOST` | `0.0.0.0` | 监听地址 |
| `dataDir` | `DATA_DIR` | `./data` | 数据目录 |
| `publicUrl` | `PUBLIC_URL` | 空 | 外网地址，填了会在界面显示 |
| `httpsCert` / `httpsKey` | `HTTPS_CERT` / `HTTPS_KEY` | 空 | 直接启用 HTTPS 的证书路径 |
| `trustProxy` | `TRUST_PROXY` | `1` | 是否信任反代的 `X-Forwarded-*` |
| `sessionDays` | `SESSION_DAYS` | `30` | 登录保持天数 |
| `loginMaxFail` | `LOGIN_MAX_FAIL` | `8` | 连续密码错误几次后锁定该 IP |
| `loginLockMin` | `LOGIN_LOCK_MIN` | `10` | 锁定时长（分钟） |
| `fileTtlHours` | `FILE_TTL_HOURS` | `0` | 文件自动清理小时数，`0` = 不清 |
| `maxFileGb` | `MAX_FILE_GB` | `20` | 单文件大小上限（GB） |

---

## 数据放在哪

```
data/
├── files.json     # 文件索引（文件名、大小、来源设备）
├── clip.json      # 剪贴板记录（最多保留 60 条）
├── .secret        # 会话签名密钥（首次启动自动生成）
├── files/         # 实际文件内容
└── tmp/           # 上传中的分片，完成后自动删除
```

想存到别的盘（比如大容量分区），改 `config.json`：

```json
"dataDir": "D:/FnDropData"
```

---

## 手机 / 电脑怎么用

1. 手机连上同一 Wi-Fi（或在外网打开穿透地址），浏览器访问。
2. 输入访问密码进入。
3. 电脑上同样打开这个地址。
4. 任意一端拖文件进去 → 另一端列表里立刻出现 → 点 ⬇ 下载 / 点“复制”取内容。
5. 想批量清理时，勾选多个文件 → 点“删除所选”。

**建议**：在手机浏览器里“添加到主屏幕”，以后点一下就进来，和 App 一样。
页头 🌐 图标点开可以看到所有可用地址（局域网 / 外网），点一下直接复制。

---

## 安全与注意

- 传输区是**所有设备共享**的：任何人上传的文件，其他设备都能看到并下载。
  用完点“清空”，或设 `fileTtlHours: 72` 让它自动过期。
- 密码在 `config.json` / 环境变量里是明文，**别把这个文件外泄**（仓库已用 `.gitignore` 忽略它）。
- 单文件上限 `maxFileGb` 默认 20GB；分片 4MB，浏览器内存占用很低。
- 只监听一个端口，不需要数据库、不需要外网账号。

---

## License

[MIT](LICENSE)
