# 实战示例

理论需要实践来巩固。本节通过一个完整的实战示例，将前面学到的知识串联起来。

## 项目目标

我们将构建一个简单的待办事项应用，包含以下功能：

- 添加待办项
- 标记完成
- 删除待办项
- 过滤显示

## 完整代码

```javascript
class TodoApp {
  constructor() {
    this.todos = []
  }

  add(text) {
    this.todos.push({ id: Date.now(), text, done: false })
  }

  toggle(id) {
    const todo = this.todos.find(t => t.id === id)
    if (todo) todo.done = !todo.done
  }

  remove(id) {
    this.todos = this.todos.filter(t => t.id !== id)
  }

  filter(status = 'all') {
    if (status === 'active') return this.todos.filter(t => !t.done)
    if (status === 'done') return this.todos.filter(t => t.done)
    return this.todos
  }
}
```

## 练习

尝试扩展这个应用，加入以下功能：

- 编辑待办项内容
- 按优先级排序
- 数据持久化到 localStorage

---

← [进阶主题](./advanced) | [回到首页](/) →
