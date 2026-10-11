本目录仅用于重建 HTML 性能分析报告，不是 AI Interview 应用代码。

入口：python3 source/build-report.py
输入：../report-data.json、../flow-data.json，以及本目录的 HTML/JS 模板。
输出：../index.html、../flow.html。无网络访问，不修改原始证据或产品仓库。
可选参数：传入一个绝对路径，另外输出用于对话内展示的 HTML 片段。

build-flow-data.py 从 report-data.json 派生 flow-data.json 和 evidence/flow-derivation.json。
其调用只使用已保存记录，不查询云端、不发起面试或模型请求。

HTML 模板包含构建占位符，请通过构建入口生成报告后阅读。
报告数据窗口、固定代码版本、各类计时起点见 evidence/flow-derivation.json。
