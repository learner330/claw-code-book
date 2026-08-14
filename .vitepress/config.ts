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
      { text: '第 3 章 启动到第一条消息', link: '/chapter-03/architecture' },
      { text: '第 4 章 启动流程深度解析', link: '/chapter-04/startup' },
      { text: '第 5 章 工具系统：ToolPool 与工具注册', link: '/chapter-05/tools' },
      { text: '第 6 章 Turn Loop：查询引擎与多轮交互', link: '/chapter-06/turn-loop' },
      { text: '第 7 章 权限系统：PolicyEngine 与路径检查', link: '/chapter-07/permissions' },
      { text: '第 8 章 钩子系统：Hook 注册与生命周期', link: '/chapter-08/hooks' },
      { text: '第 9 章 会话管理：状态机与消息历史', link: '/chapter-09/session' },
      { text: '第 10 章 协调器：TaskRegistry 与多 Agent 编排', link: '/chapter-10/coordinator' },
      { text: '第 11 章 插件与命令扩展', link: '/chapter-11/plugins' },
      { text: '第 12 章 Rust 重构版深度解读', link: '/chapter-12/rust-rewrite' },
      { text: '第 13 章 TypeScript vs Python/Rust 对比', link: '/chapter-13/comparison' },
      { text: '第 14 章 从 Java 工程师到 Agent 工程师', link: '/chapter-14/mindset' },
      { text: '第 15 章 配置层', link: '/chapter-15/config-layer' },
      { text: '第 16 章 AI-Native 工程工作流', link: '/chapter-16/workflow' },
      { text: '第 17 章 实战：研发全流程 Multi-Agent', link: '/chapter-17/practice' },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/learner330/claw-code-book' },
    ],

    editLink: {
      pattern: 'https://github.com/learner330/claw-code-book/edit/main/:path',
      text: '编辑此页',
    },

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
