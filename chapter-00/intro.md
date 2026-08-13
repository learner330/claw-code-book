# 第0章 导读

本书以 claw-code（instructkr/claw-code）源码为解读对象，覆盖 Agent 启动流程、Turn Loop 引擎、工具系统、权限模型、会话管理等核心模块，共 18 章。

claw-code 是 Anthropic Claude Code 的 Python/Rust 重写版本。本书同时参考 TypeScript 原版架构作对比，帮助读者理解不同语言实现下的设计差异。

## 读者画像

本书面向有 Java 后端经验的开发者。假设你熟悉 Spring Boot、MyBatis、Maven 等工具，但不了解 LLM 和 Agent 的内部实现。

## 如何阅读

按章节顺序阅读效果最好。前 3 章建立全局认知，第 4-11 章逐模块深入源码，第 12-13 章对比不同语言实现，第 14-17 章偏向工程实践和思维转型。

每章的代码片段均来自 `claw-code/` 目录，标注了文件路径。建议在本地打开源码对照阅读。

## 源码版本

本书基于 claw-code 仓库的 main 分支，分析时间为 2025 年。如果后续源码有变动，以实际代码为准。

---

← [首页](/) | [下一章：什么是 Agent](/chapter-01/what-is-agent) →
