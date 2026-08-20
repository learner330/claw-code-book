import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claw Code 代码讲解',
  description: '逐模块拆解 claw-code 源码，深入理解 Agent 运行时',

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

    // 侧边栏分两个可折叠组：第一阶段 + 第二阶段
    sidebar: [
      {
        text: '第一阶段：核心运行时',
        collapsed: false,
        items: [
          { text: '导读', link: '/chapter-00/intro' },
          { text: '第 1 章 什么是 Agent', link: '/chapter-01/what-is-agent' },
          { text: '第 2 章 整体架构全景', link: '/chapter-02/architecture' },
          { text: '第 3 章 启动流程', link: '/chapter-03/startup' },
          { text: '第 4 章 配置系统：运行时契约与子系统集成', link: '/chapter-04/config-layer' },
          { text: '第 5 章 API 通信与模型交互', link: '/chapter-05/api' },
          { text: '第 6 章 Turn Loop 与对话引擎', link: '/chapter-06/turn-loop' },
          { text: '第 7 章 工具系统', link: '/chapter-07/tools' },
          { text: '第 8 章 MCP 协议与外部工具连接', link: '/chapter-08/mcp' },
          { text: '第 9 章 权限系统', link: '/chapter-09/permissions' },
          { text: '第 10 章 会话管理', link: '/chapter-10/session' },
          { text: '第 11 章 Hooks系统', link: '/chapter-11/hooks' },
          { text: '第 12 章 任务与团队注册表', link: '/chapter-12/coordinator' },
          { text: '第 13 章 测试与源码审计', link: '/chapter-13/testing' },
          { text: '第 14 章 总结与展望', link: '/chapter-14/summary' },
        ],
      },
      {
        text: '第二阶段：社区扩展与深层子系统',
        collapsed: false,
        items: [
          { text: '第 15 章 claw-analog：精简 Agent Harness', link: '/chapter-15/claw-analog' },
          { text: '第 16 章 claw-rag-service：RAG 检索服务', link: '/chapter-16/rag-service' },
          { text: '第 17 章 telemetry：会话追踪与遥测', link: '/chapter-17/telemetry' },
          { text: '第 18 章 Python 原始实现：移植层架构', link: '/chapter-18/python-impl' },
          { text: '第 19 章 插件系统：契约与生命周期', link: '/chapter-19/plugins' },
          { text: '第 20 章 沙箱与进程隔离：Linux Namespace', link: '/chapter-20/sandbox' },
          { text: '第 21 章 故障恢复与自愈：Recovery Recipes', link: '/chapter-21/recovery' },
          { text: '第 22 章 容器化与部署：Docker/Podman', link: '/chapter-22/deployment' },
        ],
      },
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
