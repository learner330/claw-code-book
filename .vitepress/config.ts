import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claw Code 代码讲解',
  description: '深入理解 Claw Code 的设计与实现',

  // 最后更新时间
  lastUpdated: true,

  // GitHub Pages 部署需要设置 base
  // 如果部署到 https://用户名.github.io/仓库名/，请将下方改为你自己的仓库名
  // 如果部署到 https://用户名.github.io/（用户名子域名），则删除下面这行
  base: '/claw-code-book/',

  themeConfig: {
    // 导航栏
    nav: [
      { text: '首页', link: '/' },
      { text: '第一章', link: '/chapter-01/intro' },
      { text: '第二章', link: '/chapter-02/advanced' },
    ],

    // 侧边栏 —— 按章节分组
    sidebar: {
      '/chapter-01/': [
        {
          text: '第一章：起步',
          items: [
            { text: '导言', link: '/chapter-01/intro' },
            { text: '基础概念', link: '/chapter-01/basics' },
          ],
        },
      ],
      '/chapter-02/': [
        {
          text: '第二章：进阶',
          items: [
            { text: '进阶主题', link: '/chapter-02/advanced' },
            { text: '实战示例', link: '/chapter-02/examples' },
          ],
        },
      ],
    },

    // 社交链接
    socialLinks: [
      { icon: 'github', link: 'https://github.com/learner330/claw-code-book' },
    ],

    // 全文搜索（零配置，自带）
    search: {
      provider: 'local',
    },

    // 页脚
    footer: {
      message: '基于 MIT 协议发布',
      copyright: 'Copyright © 2024 learner330',
    },

    // 上一页 / 下一页导航
    outline: {
      label: '本页目录',
    },

    docFooter: {
      prev: '上一页',
      next: '下一页',
    },

    lastUpdated: {
      text: '最后更新',
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
  },
})
