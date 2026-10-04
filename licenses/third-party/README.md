# 第三方许可证补充文本

本目录保存安装包未携带的上游许可证副本，以及明确声明许可对应的标准正文。生成器按“生态、包名、
精确版本”匹配；依赖升级后必须重新核对，不能自动沿用旧版本登记。

| 文件 | 适用依赖 | 上游来源 |
| --- | --- | --- |
| `common/Apache-2.0.txt` | `flatbuffers@25.12.19`、`tokenizers@0.23.1` | https://www.apache.org/licenses/LICENSE-2.0.txt |
| `npm/saxes-6.0.0-LICENSE.txt` | `saxes@6.0.0` | https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE |
| `npm/lazy-val-1.0.5-LICENSE.txt` | `lazy-val@1.0.5` | npm 精确版本的 MIT/作者声明；标准正文 https://spdx.org/licenses/MIT.html |
| `pypi/langchain-core-1.4.9-LICENSE.txt` | `langchain-core@1.4.9` | https://github.com/langchain-ai/langchain/blob/master/LICENSE |
| `pypi/langsmith-0.10.6-LICENSE.txt` | `langsmith@0.10.6` | https://github.com/langchain-ai/langsmith-sdk/blob/main/LICENSE |

`common/Apache-2.0.txt` 是 Apache License 2.0 标准正文；本地副本与项目已安装依赖
随附的同一标准文本核对。这里不替代各依赖可能存在的 `NOTICE` 文件，生成器仍会优先
收集安装包自带的许可证和通知文件。

`lazy-val@1.0.5` 的 npm 元数据明确声明 MIT，作者为 Vladimir Krivosheev；发布包及上游
仓库未附原始版权行或 LICENSE。补充文件保留这项事实并附 MIT 标准条款，不套用其他
项目的版权行、不补造年份，也不把它称为已取得的上游原始 LICENSE；若后续取得原始通知，
须保留并替换此精确版本补充。工具链或依赖版本变更时重新核对。
