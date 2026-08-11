# 第三方许可证补充文本

本目录只保存安装包未携带许可证正文时所需的上游许可证副本。生成器按“生态、包名、
精确版本”匹配；依赖升级后必须重新核对，不能自动沿用旧版本登记。

| 文件 | 适用依赖 | 上游来源 |
| --- | --- | --- |
| `common/Apache-2.0.txt` | `flatbuffers@25.12.19`、`tokenizers@0.23.1` | https://www.apache.org/licenses/LICENSE-2.0.txt |
| `npm/saxes-6.0.0-LICENSE.txt` | `saxes@6.0.0` | https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE |
| `pypi/langchain-core-1.4.9-LICENSE.txt` | `langchain-core@1.4.9` | https://github.com/langchain-ai/langchain/blob/master/LICENSE |
| `pypi/langsmith-0.10.6-LICENSE.txt` | `langsmith@0.10.6` | https://github.com/langchain-ai/langsmith-sdk/blob/main/LICENSE |

`common/Apache-2.0.txt` 是 Apache License 2.0 标准正文；本地副本与项目已安装依赖
随附的同一标准文本核对。这里不替代各依赖可能存在的 `NOTICE` 文件，生成器仍会优先
收集安装包自带的许可证和通知文件。
