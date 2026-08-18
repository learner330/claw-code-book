---
layout: home

hero:
  name: "Claw Code 代码讲解"
  text: "深入理解 Agent 运行时"
  tagline: 逐模块拆解 claw-code 源码，理解 Agent 架构的设计决策与实现细节
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapter-00/intro
    - theme: alt
      text: GitHub 仓库
      link: https://github.com/learner330/claw-code-book
---

<div class="home-content">

## 章节目录

<ul class="chapter-list">
  <li><a href="/claw-code-book/chapter-00/intro"><span class="ch-num">导读</span>本书定位与阅读指南</a></li>
  <li><a href="/claw-code-book/chapter-01/what-is-agent"><span class="ch-num">第 1 章</span>什么是 Agent</a></li>
  <li><a href="/claw-code-book/chapter-02/architecture"><span class="ch-num">第 2 章</span>整体架构全景</a></li>
  <li><a href="/claw-code-book/chapter-03/startup"><span class="ch-num">第 3 章</span>启动流程</a></li>
  <li><a href="/claw-code-book/chapter-04/config-layer"><span class="ch-num">第 4 章</span>配置系统：运行时契约与子系统集成</a></li>
  <li><a href="/claw-code-book/chapter-05/api"><span class="ch-num">第 5 章</span>API 通信与模型交互</a></li>
  <li><a href="/claw-code-book/chapter-06/turn-loop"><span class="ch-num">第 6 章</span>Turn Loop 与对话引擎</a></li>
  <li><a href="/claw-code-book/chapter-07/tools"><span class="ch-num">第 7 章</span>工具系统</a></li>
  <li><a href="/claw-code-book/chapter-08/mcp"><span class="ch-num">第 8 章</span>MCP 协议与外部工具连接</a></li>
  <li><a href="/claw-code-book/chapter-09/permissions"><span class="ch-num">第 9 章</span>权限系统</a></li>
  <li><a href="/claw-code-book/chapter-10/session"><span class="ch-num">第 10 章</span>会话管理</a></li>
  <li><a href="/claw-code-book/chapter-11/hooks"><span class="ch-num">第 11 章</span>Hooks系统</a></li>
  <li><a href="/claw-code-book/chapter-12/coordinator"><span class="ch-num">第 12 章</span>任务与团队注册表</a></li>
  <li><a href="/claw-code-book/chapter-13/testing"><span class="ch-num">第 13 章</span>测试与源码审计</a></li>
  <li><a href="/claw-code-book/chapter-14/summary"><span class="ch-num">第 14 章</span>总结与展望</a></li>
</ul>

## 关于本书

Claw Code 是 Claude Code 的公开 Rust 实现。本书逐模块拆解它的源码，从 CLI 入口到 Turn Loop，从工具系统到权限边界，从会话持久化到测试验证，覆盖 Agent 运行时的完整链路。

全书 15 章（含导读），每章聚焦一个核心模块。代码片段全部来自 `claw-code/rust/` 目录的实际文件，标注了完整路径，可以在本地打开源码对照阅读。

本书面向有开发经验的工程师。遇到 Rust 特有的语法时会做简要说明，重点放在设计思路和模块边界上。

</div>
