# 我的书

一本用 [VitePress](https://vitepress.dev) 构建的多章节书籍，托管在 GitHub Pages 上。

## 本地开发

```bash
npm install      # 安装依赖
npm run dev      # 启动本地预览 (http://localhost:5173)
npm run build    # 构建静态网站到 .vitepress/dist
npm run preview  # 预览构建结果
```

## 写作指南

在项目根目录下按章节创建文件夹，每个 `.md` 文件就是一个页面。

**添加新章节**的步骤：

1. 创建文件夹，如 `chapter-03/`
2. 在文件夹中创建 `.md` 文件
3. 打开 `.vitepress/config.ts`，在 `sidebar` 中添加对应配置
4. 如果需要在导航栏显示，在 `nav` 中添加链接

## 部署到 GitHub Pages

### 1. 创建 GitHub 仓库

将本项目推送到 GitHub 仓库（建议设为公开仓库，免费额度更大）。

### 2. 修改配置

打开 `.vitepress/config.ts`，将 `base` 的值改为你自己的仓库名：

```ts
base: '/你的仓库名/',
```

同时修改 `socialLinks` 中的 GitHub 链接和 `index.md` 中的仓库地址。

### 3. 开启 GitHub Pages

进入仓库的 **Settings → Pages → Build and deployment**，将 Source 设为 **GitHub Actions**。

### 4. 推送代码

```bash
git add .
git commit -m "初始化书籍项目"
git push origin main
```

推送后 GitHub Actions 会自动构建并部署。等待约 1-2 分钟，访问：

```
https://你的用户名.github.io/你的仓库名/
```

## 目录结构

```
my-book/
├── .vitepress/
│   └── config.ts        # 配置文件（导航栏、侧边栏、搜索等）
├── .github/
│   └── workflows/
│       └── deploy.yml   # GitHub Actions 自动部署
├── chapter-01/
│   ├── intro.md         # 第一章：导言
│   └── basics.md        # 第一章：基础概念
├── chapter-02/
│   ├── advanced.md      # 第二章：进阶主题
│   └── examples.md      # 第二章：实战示例
├── public/              # 图片等静态资源
├── index.md             # 首页
├── package.json
└── .gitignore
```
