# /rewrite-chapter

重写已有章节。保留章节映射不变，但根据新的指令重新生成内容。

## 参数

$ARGUMENTS = 章节编号 + 可选的修改指令（如 `4 增加配置校验细节` 或 `6`）

格式：`<章节号> [修改指令...]`

## 执行步骤

1. 解析参数：第一个数字是章节号，其余文字是用户的修改指令（可选）
2. 读取 `chapter-plan.json`，找到对应章节的配置
3. 读取 `writing-guide.md`，获取写作风格规则
4. 读取当前 `output_path` 中已有的章节内容
5. 使用 `oa-skills citadel getSimpleMarkdown --contentId <km_doc_id>` 读取学城文档对应章节
6. 读取 `source_files` 中列出的 claw-code 源码文件
7. 根据用户的修改指令 + writing-guide.md 规则，重写章节内容
   - 如果用户给了具体指令（如"去掉类比""增加某节"），优先满足
   - 如果没有具体指令，则按 writing-guide.md 重新审视并改进
8. 将重写后的内容写入 `output_path`
9. 告知用户修改了哪些部分

## 注意

- 重写时必须保留已有的正确内容，只修改需要改的部分
- 如果用户指令与 writing-guide.md 冲突，以用户指令为准（用户可以临时覆盖规则）
- 重写后提示用户可以用 `/review-chapter` 检查质量
