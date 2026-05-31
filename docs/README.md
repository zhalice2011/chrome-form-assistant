# docs/

存放 README 引用的演示资源。

## 占位文件

| 文件 | 用途 | 建议规格 |
|---|---|---|
| `demo.gif` | README 顶部的全流程演示 | 宽 ≤ 800px，时长 8–15s，≤ 3MB |

## 录制建议

录制全流程：打开扩展 → 抓取字段 → 输入意图 → 生成方案 → 确认填写。

推荐工具：
- macOS：[Kap](https://getkap.co/) / [LICEcap](https://www.cockos.com/licecap/)
- 跨平台：[Peek](https://github.com/phw/peek) / [ScreenToGif](https://www.screentogif.com/)

录完后用 [gifski](https://gif.ski/) 或 `ffmpeg` 压到 800px 宽、3MB 以内：

```bash
gifski -o docs/demo.gif --width 800 --fps 12 frames/*.png
```
