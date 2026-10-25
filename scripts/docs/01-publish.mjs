/** 文档一：发布部署指南（图文版） */

export default {
  file: '1-云作业-发布部署指南.docx',
  doc: {
    title: '发布部署指南',
    subtitle: '从本机到公网，让所有人都能打开这个作业平台',
    footerLabel: '云作业 · 发布部署指南',
    meta: [
      ['文档版本', 'v1.1（图文版）'],
      ['适用系统', '云作业 · 在线作业平台 1.0'],
      ['更新日期', '2026 年 10 月'],
      ['适用读者', '管理员 / 负责发布网站的运维人员'],
    ],
    blocks: [
      { h1: '一、开始之前' },
      {
        p: '本指南教你把这个作业平台**发布到公网**，做到「把网址发给任何人，他打开就能用」。全程不需要改代码，按步骤复制命令即可。',
      },

      { h2: '1.1 三种发布方式怎么选' },
      {
        table: {
          head: ['方式', '费用', '耗时', '数据是否永久保存', '适合谁'],
          rows: [
            ['方式一 · Render 免费部署', '免费', '约 5 分钟', '否（重新部署会重置）', '想立刻拿到公网网址、先用起来'],
            ['方式二 · 自己的云服务器', '约 25~40 元/月', '约 20 分钟', '是（可长期稳定使用）', '正式教学使用、数据重要'],
            ['方式三 · 本机 + 临时隧道', '免费', '约 3 分钟', '是（存在本机）', '临时演示，电脑关机即失效'],
          ],
          widths: [26, 14, 12, 22, 26],
        },
      },
      { img: 'shots/steps/diagram-deploy.png', caption: '图 1　Render 免费部署只需四步' },
      {
        note: {
          kind: 'tip',
          text: '**正式给班级用**建议直接看「方式二」；只想**先看看效果**用「方式一」。两者可随时切换，数据能用备份文件迁移。',
        },
      },

      { h2: '1.2 你需要准备什么' },
      {
        bullets: [
          '**方式一**：一个 GitHub 账号（免费注册）+ 一个 Render 账号（可用 GitHub 直接登录）。',
          '**方式二**：一台云服务器（阿里云 / 腾讯云 / 华为云的「轻量应用服务器」，1 核 2G 足够）+ 公网 IP 和登录密码。',
          '**方式三**：只需要你现在这台电脑。',
          '**通用**：本机试用时需要 **Node.js 18 或更高版本**；Render 与 Docker 会自动安装。',
        ],
      },

      { pagebreak: true },

      { h1: '二、方式一：Render 免费部署（推荐新手）' },
      {
        p: 'Render 是一家海外云托管平台，提供免费套餐。部署完成后你会得到一个形如 `https://你的名字.onrender.com` 的 https 网址，**手机、电脑都能直接打开**。',
      },

      { h2: '2.1 第一步：把代码上传到 GitHub' },
      { p: '在项目文件夹（包含 `package.json` 的那个目录）空白处右键 →「在终端中打开」，依次执行：' },
      {
        code: 'git init\ngit add .\ngit commit -m "首次提交：云作业平台"\ngit branch -M main\ngit remote add origin https://github.com/你的用户名/homework-platform.git\ngit push -u origin main',
      },
      {
        note: {
          kind: 'warn',
          text: 'GitHub 上需要先**新建一个空仓库**（不要勾选自动生成 README），仓库名随意，例如 `homework-platform`。命令里的「你的用户名」要换成你自己的。',
        },
      },
      { p: '项目里的 `.gitignore` 已排除 `node_modules/`、`data/`、`uploads/`，**不会把数据和依赖上传**，可以放心提交。' },

      { h2: '2.2 第二步：在 Render 创建 Blueprint' },
      {
        steps: [
          '打开 https://render.com，点右上角 **Sign Up**，选择「GitHub」登录并授权。',
          '登录后点右上角 **New +**，在菜单里选择 **Blueprint**。',
          '在仓库列表里选中你刚推送的仓库，点 **Connect**。',
          'Render 会自动读取项目里的 `render.yaml`，显示一个名为 `homework-platform` 的 Web 服务。',
        ],
      },

      { h2: '2.3 第三步：填写管理员密码并部署' },
      {
        steps: [
          '在环境变量里找到 `ADMIN_PASSWORD`，输入一个**足够强的密码**（建议 10 位以上，含字母和数字）。',
          '点击页面底部 **Apply** / **Create** 开始部署。',
          '等待约 2~3 分钟，状态从 Building 变成 **Live** 即部署成功。',
        ],
      },
      {
        note: {
          kind: 'info',
          text: '`render.yaml` 里 `SEED_DEMO=0`，所以首次启动**只创建管理员账号**（用户名 `admin`，密码就是你刚填的），不会生成演示班级和学生——这是正式使用最干净的状态。',
        },
      },

      { h2: '2.4 第四步：验证网站是否正常' },
      {
        steps: [
          '在 Render 服务页面顶部复制你的网址，例如 `https://homework-platform-abcd.onrender.com`。',
          '在浏览器打开，应该看到下图这个登录页。',
          '用 `admin` + 你设置的密码登录，进入「数据概览」。',
          '点「作业管理 → 发布作业」，随便填标题和内容并发布，能正常看到作业即表示一切正常。',
        ],
      },
      { img: 'shots/steps/step-login.png', caption: '图 2　部署成功后打开的登录页' },
      { legend: ['用户名输入框（管理员填 admin）', '密码输入框（部署时设置的密码）', '登录按钮', '自助注册标签（可在后台关闭）'] },
      { img: 'shots/steps/admin-overview.png', caption: '图 3　登录成功后的管理后台（数据概览）' },
      { legend: ['功能菜单', '待审批提交', '作业总数', '提交总数', '提交审批入口'] },
      { p: '最后把这个网址**发给老师和学生**，他们用手机、电脑打开都能直接用。' },

      { h2: '2.5 免费实例的两个限制（务必了解）' },
      {
        bullets: [
          '**会自动休眠**：15 分钟没人访问就休眠，下次打开需等约 30 秒唤醒（页面一直转圈，耐心等即可）。',
          '**磁盘是临时的**：重新部署、改配置、平台重启后 `data/` 会被重置，**之前的作业和提交记录会丢失**。',
        ],
      },
      {
        table: {
          head: ['需求', '做法'],
          rows: [
            ['不想丢数据，又要用免费版', '定期在「系统设置 → 下载数据备份」保存备份，重新部署后按第八章恢复'],
            ['数据必须永久保存', '升级 Render 付费实例（约 7 美元/月）后，把 `render.yaml` 中 `disk:` 那几行注释打开，并把 `DATA_DIR` 设为 `/data`'],
            ['不想花钱又要稳定', '改用「方式二：自己的云服务器」，数据存服务器硬盘，永久保存'],
          ],
          widths: [30, 70],
        },
      },

      { pagebreak: true },

      { h1: '三、方式二：部署到自己的云服务器（长期稳定推荐）' },
      { p: '正式教学场景最推荐的方案：**网站 24 小时在线、数据永久保存、可绑定自己的域名**。' },

      { h2: '3.1 第一步：准备服务器' },
      {
        bullets: [
          '购买一台轻量应用服务器，1 核 2G 起步，系统选 **Ubuntu 22.04 / 24.04**。',
          '在云厂商控制台的「安全组 / 防火墙」放行 **80、443** 端口（临时测试也可放行 **3000**）。',
          '用 SSH 登录服务器，或使用云厂商网页版远程终端。',
        ],
      },

      { h2: '3.2 第二步：安装 Docker' },
      { code: 'curl -fsSL https://get.docker.com | sh\ndocker --version' },
      { p: '看到版本号输出（例如 `Docker version 27.x`）即安装成功。' },

      { h2: '3.3 第三步：把项目代码传到服务器' },
      {
        bullets: [
          '**用 git**：项目推送到 GitHub 后，在服务器执行 `git clone 你的仓库地址`。',
          '**用 scp**：在自己电脑执行 `scp -r 项目文件夹 用户名@服务器IP:/root/`。',
          '**用宝塔面板**：在文件管理器里上传压缩包并解压。',
        ],
      },

      { h2: '3.4 第四步：修改配置并启动' },
      { p: '进入项目目录，编辑 `docker-compose.yml`，至少改两处：' },
      { code: 'SESSION_SECRET: "改成你自己的随机字符串，至少 32 位"\nADMIN_PASSWORD: "你的管理员密码"' },
      {
        note: {
          kind: 'danger',
          text: '修改 `SESSION_SECRET` 后**已登录的用户需要重新登录**，这是正常现象。生产环境务必改成随机值，不要用示例字符串。',
        },
      },
      { code: 'docker compose up -d\ndocker logs homework' },
      { p: '用浏览器打开 `http://服务器公网IP:3000`，能看到登录页（图 2）就成功了。打不开请检查安全组是否放行 3000 端口。' },

      { h2: '3.5 第五步（推荐）：绑定域名并开启 HTTPS' },
      { p: '把域名解析到服务器 IP 后，用 Caddy 自动申请证书最省事：' },
      {
        code: 'apt install -y caddy\n\necho "homework.你的域名.com {\n    reverse_proxy 127.0.0.1:3000\n}" > /etc/caddy/Caddyfile\n\nsystemctl reload caddy',
      },
      { p: '之后用 `https://homework.你的域名.com` 访问即可，证书自动续期。若更习惯 Nginx：' },
      {
        code: 'server {\n    listen 80;\n    server_name homework.你的域名.com;\n    client_max_body_size 25m;      # 与上传限制保持一致\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Real-IP $remote_addr;\n    }\n}',
      },
      {
        note: {
          kind: 'warn',
          text: '用 Nginx 时一定要设置 `client_max_body_size`（建议 25m 以上），否则学生上传附件会失败（413）。',
        },
      },

      { h2: '3.6 日常运维命令' },
      {
        table: {
          head: ['要做什么', '命令'],
          rows: [
            ['查看服务是否在运行', 'docker compose ps'],
            ['查看日志（含初始账号提示）', 'docker logs homework'],
            ['重启服务', 'docker compose restart'],
            ['停止服务', 'docker compose down'],
            ['更新到新代码', 'git pull && docker compose up -d --build'],
            ['备份数据', 'tar -czf backup-$(date +%F).tar.gz data/'],
            ['进入容器排查', 'docker exec -it homework sh'],
          ],
          widths: [34, 66],
        },
      },
      {
        note: {
          kind: 'tip',
          text: '数据保存在宿主机项目目录的 `data/` 里（`docker-compose.yml` 把它挂载到容器 `/data`）。**只要不删这个目录，升级、重启、换容器都不会丢数据。**',
        },
      },

      { pagebreak: true },

      { h1: '四、方式三：临时演示（本机 + 公网隧道）' },
      { p: '适合「人不在同一 WiFi，只想让别人临时看几分钟」的场景。' },
      {
        steps: [
          '在本机项目目录启动服务：`npm start`（或双击 `start.cmd`）。',
          '另开一个终端，准备并运行 cloudflared（Windows 可在 Cloudflare 官网下载 `cloudflared.exe`）。',
          '运行 `cloudflared tunnel --url http://localhost:3000`。',
          '命令会输出 `https://xxxx-yyyy.trycloudflare.com` 的临时链接，发给别人即可。',
        ],
      },
      { code: 'npm start\n# 另开一个窗口\ncloudflared tunnel --url http://localhost:3000' },
      {
        note: {
          kind: 'warn',
          text: '这个链接在你**关闭终端、电脑休眠或断网后立即失效**，且每次重启网址都会变，只适合演示测试，**不要用于正式教学**。',
        },
      },

      { h1: '五、方式四：其他平台' },
      { p: '本项目是标准 Node.js 应用，自带 `Dockerfile`，几乎任何平台都能跑。通用约定：**端口 3000**、**数据目录 `/data`**。' },
      {
        table: {
          head: ['平台', '要点'],
          rows: [
            ['Railway / Fly.io / Zeabur', '连接 GitHub 自动构建；务必挂载持久卷到 `/data`，否则重启丢数据'],
            ['群晖 / 威联通 NAS', '用 Docker 图形界面导入项目，映射端口 3000 与目录 /data'],
            ['宝塔面板', '用「Node 项目」功能，启动命令 `node src/server.js`，端口 3000'],
            ['局域网内使用', '双击 start.cmd，学生用 `http://你的电脑IP:3000` 访问（需同一 WiFi）'],
          ],
          widths: [30, 70],
        },
      },

      { pagebreak: true },

      { h1: '六、环境变量速查' },
      { p: '可在 Render 控制台、`docker-compose.yml` 或启动前设置。**只有前 3 个建议改动**，其余保持默认即可。' },
      {
        table: {
          head: ['变量', '默认值', '说明'],
          rows: [
            ['PORT', '3000', '监听端口，云平台通常自动注入'],
            ['ADMIN_USERNAME', 'admin', '首次启动创建的管理员账号'],
            ['ADMIN_PASSWORD', 'admin123456', '首次启动创建的管理员密码（务必改掉）'],
            ['ADMIN_NAME', '系统管理员', '管理员显示名称'],
            ['SESSION_SECRET', '自动生成', '会话签名密钥，生产环境建议显式设置（≥32 位）'],
            ['DATA_DIR', './data', '数据目录（db.json + uploads）'],
            ['UPLOAD_DIR', '$DATA_DIR/uploads', '附件目录'],
            ['SEED_DEMO', '1', '1=首次启动生成演示数据；0=只创建管理员'],
            ['ALLOW_REGISTER', '1', '1=允许学生自助注册；0=完全禁止'],
            ['MAX_UPLOAD_MB', '20', '单个附件大小上限（MB）'],
          ],
          widths: [22, 22, 56],
        },
      },
      {
        note: {
          kind: 'info',
          text: '`ADMIN_USERNAME` / `ADMIN_PASSWORD` **只在第一次启动（数据库为空）时生效**。网站已经在用了再改这两个变量不会改变现有密码——那种情况请用第九章的「忘记管理员密码」方法。',
        },
      },

      { h1: '七、上线后必做的 5 件事' },
      {
        steps: [
          '**改密码**：管理员登录 → 左下角「修改密码」，换掉默认密码。',
          '**处理演示账号**：演示模式启动的，到「账号管理」把 `student`、`li`、`wang`、`teacher` 停用或删除。',
          '**决定注册策略**：「系统设置 → 开放学生自助注册」，一般建议关闭，由管理员统一建号。',
          '**建班级 + 加学生**：先「班级管理」建班，再「账号管理 → 批量添加学生」导入名单并分班。',
          '**备份一次**：点下面的「下载数据备份」，确认备份能用。',
        ],
      },
      { img: 'shots/steps/admin-settings.png', caption: '图 4　系统设置：注册开关与数据备份都在这里' },
      { legend: ['站点名称', '自助注册开关', '注册页提示语', '保存设置', '下载数据备份'] },
      { p: '完成后就可以把网址发给老师和学生了。具体操作请看《管理员与教师使用手册》和《学生使用手册》。' },

      { pagebreak: true },

      { h1: '八、数据与备份' },
      { h2: '8.1 数据都存在哪里' },
      {
        table: {
          head: ['路径', '内容', '丢了会怎样'],
          rows: [
            ['data/db.json', '所有账号、班级、作业、提交、评分', '全部业务数据丢失（最严重）'],
            ['data/uploads/', '师生上传的附件文件', '附件打不开，记录仍在'],
            ['data/secret.key', '会话签名密钥', '所有人需要重新登录（不影响数据）'],
          ],
          widths: [22, 40, 38],
        },
      },
      {
        note: {
          kind: 'info',
          text: '整个 `data/` 目录就是完整的「数据库」。**复制它＝完成备份**，拷到新服务器＝完成迁移。',
        },
      },

      { h2: '8.2 备份与恢复' },
      { p: '**服务器方式备份**：' },
      { code: 'cd 项目目录\ntar -czf homework-backup-$(date +%F).tar.gz data/' },
      { p: '**网页方式备份**（适合免费托管）：管理员登录 → 系统设置 → 下载数据备份（JSON）。注意网页方式只含 `db.json`，不含附件。' },
      { p: '**恢复**：把备份的 `db.json` 放回 `data/db.json`（附件放回 `data/uploads/`），然后重启：' },
      { code: 'docker compose restart      # 服务器方式\n# 本机：Ctrl+C 后重新 npm start' },

      { h2: '8.3 换平台迁移' },
      {
        steps: [
          '在旧环境备份整个 `data/` 目录。',
          '在新环境按任一方式部署，先启动一次让 `data/` 生成。',
          '停止服务，用备份覆盖新的 `data/` 目录。',
          '重启服务，账号、作业、附件都会原样回来。',
        ],
      },

      { pagebreak: true },

      { h1: '九、常见故障排查' },
      {
        table: {
          head: ['现象', '可能原因', '解决办法'],
          rows: [
            ['打开网址一直转圈 / 超时', '免费实例休眠中', '等约 30 秒会自动唤醒，属正常现象'],
            ['页面显示 502 / Bad Gateway', '服务进程没起来', '看日志 `docker logs homework`；确认 3000 端口未被占用'],
            ['本机打不开 localhost:3000', '端口被占用或没启动', '换端口：`PORT=8080 npm start`'],
            ['部署后之前的作业没了', '免费实例磁盘被重置', '换方式二，或恢复备份（第八章）'],
            ['上传附件失败', '超过 20MB 或类型不支持', '压缩后重传，或调大 `MAX_UPLOAD_MB`；Nginx 同步调大限制'],
            ['忘了管理员密码', '—', '见下方命令'],
            ['学生打不开但自己能打开', '用的是本机/局域网地址', '换成公网网址（Render 域名或服务器域名）'],
            ['换域名后要重新登录', 'Cookie 与域名绑定', '正常现象，重新登录即可'],
          ],
          widths: [24, 26, 50],
        },
      },
      { h2: '忘记管理员密码怎么办' },
      { p: '在服务器（或本机项目目录）执行，会把指定账号的密码重置为你给的新密码：' },
      { code: 'node scripts/reset-password.mjs admin 新的密码' },
      { p: 'Docker 部署时先进容器再执行：' },
      { code: 'docker exec -it homework sh\nnode scripts/reset-password.mjs admin 新的密码\nexit' },

      { pagebreak: true },

      { h1: '十、附录' },
      { h2: '10.1 项目目录结构' },
      {
        code: 'peixun/\n├─ src/                # 后端（Express + JSON 存储）\n│  ├─ server.js        # 入口\n│  ├─ routes/          # 8 组接口：auth/assignments/submissions/users/classes/files/stats/settings\n│  ├─ db.js auth.js    # 数据层与鉴权\n│  └─ seed.js          # 首次启动初始化\n├─ public/             # 前端（index.html / app.js / styles.css，无需构建）\n├─ scripts/            # 自测、截图与文档生成脚本\n├─ docs/               # 三份 Word 使用文档\n├─ data/               # 运行后生成：db.json + uploads/\n├─ Dockerfile / docker-compose.yml / render.yaml\n└─ start.cmd           # Windows 一键启动',
      },

      { h2: '10.2 本机常用命令' },
      {
        table: {
          head: ['目的', '命令'],
          rows: [
            ['安装依赖', 'npm install'],
            ['启动服务', 'npm start'],
            ['开发模式（改代码自动重启）', 'npm run dev'],
            ['运行 57 项端到端自测', 'npm test'],
            ['重置某个账号的密码', 'node scripts/reset-password.mjs 用户名 新密码'],
            ['重新生成三份 Word 文档', 'node scripts/build-docs.mjs'],
          ],
          widths: [36, 64],
        },
      },

      { h2: '10.3 发布完成检查清单' },
      {
        bullets: [
          '公网网址能打开（建议是 https）',
          '管理员能登录，默认密码已修改',
          '已建好班级，学生已导入并分班',
          '已发布 1 份测试作业，学生端能看到',
          '学生能提交，管理员能批阅，学生能看到结果',
          '已完成一次数据备份',
          '网址已发给老师和学生（附一句说明：用老师给的账号登录）',
        ],
      },
    ],
  },
};
