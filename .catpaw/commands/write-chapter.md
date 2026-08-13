# /write-chapter

写入或生成指定章节。

## 参数

$ARGUMENTS = 章节编号（如 `4` 或 `04`）

## 执行步骤

1. 读取 `chapter-plan.json`，找到对应章节的配置（km_doc_id、source_files、output_path）
2. 读取 `writing-guide.md`，获取写作风格规则
3. 使用 `oa-skills citadel getSimpleMarkdown --contentId <km_doc_id>` 读取学城文档对应章节，作为结构参考
4. 读取 `source_files` 中列出的 claw-code 源码文件（如果路径是目录，列出目录下所有文件并读取核心文件）
5. 按以下顺序生成章节内容：
   a. 浏览学城文档的结构和要点（仅作参考，不照搬）
   b. 阅读源码，理解实际实现
   c. 以源码为准，按 writing-guide.md 的风格规则撰写
   d. 代码引用必须来自实际源码文件，标注文件路径
6. 将生成的内容写入 `output_path` 指定的文件
7. 更新 `chapter-plan.json` 中该章节的 status 为 "done"
8. 告知用户文件路径，提示可以用 `/rewrite-chapter` 修改

## 注意

- 每次只处理一个章节
- 如果章节已存在，提示用户是否覆盖，建议使用 `/rewrite-chapter` 代替
- 如果源码文件不存在，跳过并标注警告，不要编造代码
- 严格遵循 writing-guide.md 中的所有规则
