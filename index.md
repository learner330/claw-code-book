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

### 第一阶段：核心运行时

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

### 间章：演进脉络

<ul class="chapter-list">
  <li><a href="/claw-code-book/chapter-interlude/evolution"><span class="ch-num">间章</span>从泄漏到重构：新增模块总览</a></li>
</ul>

### 第二阶段：社区扩展与深层子系统

<ul class="chapter-list">
  <li><a href="/claw-code-book/chapter-15/claw-analog"><span class="ch-num">第 15 章</span>claw-analog：精简 Agent Harness</a></li>
  <li><a href="/claw-code-book/chapter-16/rag-service"><span class="ch-num">第 16 章</span>claw-rag-service：RAG 检索服务</a></li>
  <li><a href="/claw-code-book/chapter-17/telemetry"><span class="ch-num">第 17 章</span>telemetry：会话追踪与遥测</a></li>
  <li><a href="/claw-code-book/chapter-18/python-impl"><span class="ch-num">第 18 章</span>Python 原始实现：移植层架构</a></li>
  <li><a href="/claw-code-book/chapter-19/plugins"><span class="ch-num">第 19 章</span>插件系统：契约与生命周期</a></li>
  <li><a href="/claw-code-book/chapter-20/sandbox"><span class="ch-num">第 20 章</span>沙箱与进程隔离：Linux Namespace 与容器检测</a></li>
  <li><a href="/claw-code-book/chapter-21/recovery"><span class="ch-num">第 21 章</span>故障恢复与自愈：Recovery Recipes 与 Worker Boot</a></li>
  <li><a href="/claw-code-book/chapter-22/deployment"><span class="ch-num">第 22 章</span>容器化与部署：Docker/Podman 工作流</a></li>
</ul>

## 关于本书

Claw Code 是 Claude Code 的公开 Rust 实现。本书逐模块拆解它的源码，从 CLI 入口到 Turn Loop，从工具系统到权限边界，从会话持久化到测试验证，覆盖 Agent 运行时的完整链路。第二阶段进一步深入社区扩展模块（claw-analog、RAG 服务、遥测、插件系统）和深层子系统（沙箱隔离、故障恢复、容器化部署），并对照 Python 原始实现讲解架构演进。

全书 24 章（含导读和间章），分为两个阶段：第一阶段 14 章聚焦核心运行时的主线链路；间章梳理项目演进脉络和新增模块概览；第二阶段 8 章覆盖独立扩展模块和源码审查后确认具有独立架构价值的深层子系统。代码片段来自 `claw-code/` 目录的实际文件（含 Rust 和 Python），标注了完整路径，可以在本地打开源码对照阅读。

本书面向有开发经验的工程师。遇到 Rust 特有的语法时会做简要说明，重点放在设计思路和模块边界上。

</div>
