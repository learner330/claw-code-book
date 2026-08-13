# 进阶主题

本章将深入探讨一些进阶主题，帮助你从「能用」迈向「用好」。

## 性能优化

性能优化是一个永恒的话题。以下是几个关键方向：

- **减少渲染次数**：避免不必要的状态更新
- **懒加载**：按需加载资源，缩短首屏时间
- **缓存策略**：合理利用缓存，减少重复计算

## 设计模式

掌握常见的设计模式可以让你的代码更加优雅：

```typescript
// 观察者模式示例
class EventEmitter {
  private listeners: Record<string, Function[]> = {}

  on(event: string, fn: Function) {
    (this.listeners[event] ||= []).push(fn)
  }

  emit(event: string, ...args: any[]) {
    this.listeners[event]?.forEach(fn => fn(...args))
  }
}
```

## 小结

进阶的关键在于理解「为什么这样做」而不仅仅是「怎么做」。

---

← [基础概念](/chapter-01/basics) | [下一节：实战示例](./examples) →
