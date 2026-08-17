import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claw Code 代码讲解',
  description: '逐模块拆解 claw-code 源码，从 Java 后端到 Agent 工程师',

  lastUpdated: true,
  base: '/claw-code-book/',

  // 排除 claw-code 源码目录，不参与构建
  srcExclude: ['claw-code/**'],

  head: [
    ['link', { rel: 'stylesheet', href: '/claw-code-book/style.css' }],
  ],

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
    ],

    // 统一侧边栏：所有页面共享完整章节目录
    sidebar: [
      { text: '导读', link: '/chapter-00/intro' },
      { text: '第 1 章 什么是 Agent', link: '/chapter-01/what-is-agent' },
      { text: '第 2 章 整体架构全景', link: '/chapter-02/architecture' },
      { text: '第 3 章 启动流程', link: '/chapter-03/startup' },
      { text: '第 4 章 配置系统：运行时契约与子系统集成', link: '/chapter-04/config-layer' },
      { text: '第 5 章 API 通信与模型交互', link: '/chapter-05/api' },
      { text: '第 6 章 工具系统', link: '/chapter-06/tools' },
      { text: '第 7 章 MCP 协议与外部工具连接', link: '/chapter-07/mcp' },
      { text: '第 8 章 权限系统', link: '/chapter-08/permissions' },
      { text: '第 9 章 会话管理', link: '/chapter-09/session' },
      { text: '第 10 章 钩子系统', link: '/chapter-10/hooks' },
      { text: '第 11 章 Turn Loop 与对话引擎', link: '/chapter-11/turn-loop' },
      { text: '第 12 章 协调器', link: '/chapter-12/coordinator' },
      { text: '第 13 章 测试与源码审计', link: '/chapter-13/testing' },
      { text: '第 14 章 总结与展望', link: '/chapter-14/summary' },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/learner330/claw-code-book' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: '基于 MIT 协议发布',
      copyright: 'Copyright © 2024 learner330',
    },

    outline: {
      label: '本页目录',
    },

    docFooter: {
      prev: '上一章',
      next: '下一章',
    },

    lastUpdated: {
      text: '最后更新',
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
  },
})
