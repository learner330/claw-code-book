import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claw Code 代码讲解',
  description: '逐模块拆解 claw-code 源码，从 Java 后端到 Agent 工程师',

  lastUpdated: true,
  base: '/claw-code-book/',

  // 排除 claw-code 源码目录，不参与构建
  srcExclude: ['claw-code/**'],

  // 章节尚未全部创建，暂时忽略死链
  ignoreDeadLinks: true,

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '导读', link: '/chapter-00/intro' },
      { text: '架构', link: '/chapter-03/architecture' },
      { text: '启动流程', link: '/chapter-04/startup' },
    ],

    sidebar: {
      '/chapter-00/': [
        {
          text: '导读',
          items: [
            { text: '导读', link: '/chapter-00/intro' },
          ],
        },
      ],
      '/chapter-01/': [
        {
          text: '第一章：什么是 Agent',
          items: [
            { text: '什么是 Agent', link: '/chapter-01/what-is-agent' },
          ],
        },
      ],
      '/chapter-02/': [
        {
          text: '第二章：LLM 最小必要知识',
          items: [
            { text: 'LLM 最小必要知识', link: '/chapter-02/llm-basics' },
          ],
        },
      ],
      '/chapter-03/': [
        {
          text: '第三章：整体架构全景',
          items: [
            { text: '整体架构全景', link: '/chapter-03/architecture' },
          ],
        },
      ],
      '/chapter-04/': [
        {
          text: '第四章：启动流程深度解析',
          items: [
            { text: '启动流程深度解析', link: '/chapter-04/startup' },
          ],
        },
      ],
      '/chapter-05/': [
        {
          text: '第五章：工具系统',
          items: [
            { text: '工具系统', link: '/chapter-05/tools' },
          ],
        },
      ],
      '/chapter-06/': [
        {
          text: '第六章：查询引擎与 Turn Loop',
          items: [
            { text: '查询引擎与 Turn Loop', link: '/chapter-06/turn-loop' },
          ],
        },
      ],
      '/chapter-07/': [
        {
          text: '第七章：权限系统',
          items: [
            { text: '权限系统', link: '/chapter-07/permissions' },
          ],
        },
      ],
      '/chapter-08/': [
        {
          text: '第八章：钩子系统',
          items: [
            { text: '钩子系统', link: '/chapter-08/hooks' },
          ],
        },
      ],
      '/chapter-09/': [
        {
          text: '第九章：状态机与会话管理',
          items: [
            { text: '状态机与会话管理', link: '/chapter-09/session' },
          ],
        },
      ],
      '/chapter-10/': [
        {
          text: '第十章：协调器：多 Agent 编排',
          items: [
            { text: '协调器：多 Agent 编排', link: '/chapter-10/coordinator' },
          ],
        },
      ],
      '/chapter-11/': [
        {
          text: '第十一章：插件系统与命令扩展',
          items: [
            { text: '插件系统与命令扩展', link: '/chapter-11/plugins' },
          ],
        },
      ],
      '/chapter-12/': [
        {
          text: '第十二章：Rust 重构版深度解读',
          items: [
            { text: 'Rust 重构版深度解读', link: '/chapter-12/rust-rewrite' },
          ],
        },
      ],
      '/chapter-13/': [
        {
          text: '第十三章：TypeScript vs Python/Rust 对比',
          items: [
            { text: 'TypeScript vs Python/Rust 对比', link: '/chapter-13/comparison' },
          ],
        },
      ],
      '/chapter-14/': [
        {
          text: '第十四章：从 Java 工程师到 Agent 工程师',
          items: [
            { text: '思维转型', link: '/chapter-14/mindset' },
          ],
        },
      ],
      '/chapter-15/': [
        {
          text: '第十五章：配置层',
          items: [
            { text: '配置层：Rules、Commands、MCP 与 Skills', link: '/chapter-15/config-layer' },
          ],
        },
      ],
      '/chapter-16/': [
        {
          text: '第十六章：AI-Native 工程工作流',
          items: [
            { text: 'AI-Native 工程工作流', link: '/chapter-16/workflow' },
          ],
        },
      ],
      '/chapter-17/': [
        {
          text: '第十七章：实战：研发全流程 Multi-Agent',
          items: [
            { text: '实战：研发全流程 Multi-Agent', link: '/chapter-17/practice' },
          ],
        },
      ],
    },

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
