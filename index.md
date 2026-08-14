---
layout: home

hero:
  name: "Claw Code 代码讲解"
  text: "从 Java 后端到 Agent 工程师"
  tagline: 逐模块拆解 claw-code 源码，用 Java 工程师熟悉的概念理解 Agent 架构
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
  <li><a href="/claw-code-book/chapter-00/intro"><span class="ch-num">导读</span>本书介绍与阅读指南</a></li>
  <li><a href="/claw-code-book/chapter-01/what-is-agent"><span class="ch-num">第 1 章</span>什么是 Agent</a></li>
  <li><a href="/claw-code-book/chapter-02/architecture"><span class="ch-num">第 2 章</span>整体架构全景</a></li>
  <li><a href="/claw-code-book/chapter-03/architecture"><span class="ch-num">第 3 章</span>启动到第一条消息</a></li>
  <li><a href="/claw-code-book/chapter-04/startup"><span class="ch-num">第 4 章</span>启动流程深度解析</a></li>
  <li><a href="/claw-code-book/chapter-05/tools"><span class="ch-num">第 5 章</span>工具系统：ToolPool 与工具注册</a></li>
  <li><a href="/claw-code-book/chapter-06/turn-loop"><span class="ch-num">第 6 章</span>Turn Loop：查询引擎与多轮交互</a></li>
  <li><a href="/claw-code-book/chapter-07/permissions"><span class="ch-num">第 7 章</span>权限系统：PolicyEngine 与路径检查</a></li>
  <li><a href="/claw-code-book/chapter-08/hooks"><span class="ch-num">第 8 章</span>钩子系统：Hook 注册与生命周期</a></li>
  <li><a href="/claw-code-book/chapter-09/session"><span class="ch-num">第 9 章</span>会话管理：状态机与消息历史</a></li>
  <li><a href="/claw-code-book/chapter-10/coordinator"><span class="ch-num">第 10 章</span>协调器：TaskRegistry 与多 Agent 编排</a></li>
  <li><a href="/claw-code-book/chapter-11/plugins"><span class="ch-num">第 11 章</span>插件与命令扩展</a></li>
  <li><a href="/claw-code-book/chapter-12/rust-rewrite"><span class="ch-num">第 12 章</span>Rust 重构版深度解读</a></li>
  <li><a href="/claw-code-book/chapter-13/comparison"><span class="ch-num">第 13 章</span>TypeScript vs Python/Rust 对比</a></li>
  <li><a href="/claw-code-book/chapter-14/mindset"><span class="ch-num">第 14 章</span>从 Java 工程师到 Agent 工程师</a></li>
  <li><a href="/claw-code-book/chapter-15/config-layer"><span class="ch-num">第 15 章</span>配置层</a></li>
  <li><a href="/claw-code-book/chapter-16/workflow"><span class="ch-num">第 16 章</span>AI-Native 工程工作流</a></li>
  <li><a href="/claw-code-book/chapter-17/practice"><span class="ch-num">第 17 章</span>实战：研发全流程 Multi-Agent</a></li>
</ul>

## 关于本书

本书以 [claw-code](https://github.com/instructkr/claw-code)（Anthropic Claude Code 的 Python/Rust 重写版本）源码为解读对象，覆盖 Agent 启动流程、Turn Loop 引擎、工具系统、权限模型、会话管理等核心模块，共 18 章。

面向有 Java 后端经验的开发者，用 Spring Boot、MyBatis 等熟悉概念类比 Agent 架构，帮助读者从「用 AI 写代码」进阶到「看懂 AI 怎么写代码」。每段代码分析均来自实际源码文件，标注路径，可对照阅读。

</div>
