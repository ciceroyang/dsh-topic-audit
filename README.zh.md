# dsh-topic-audit

GitHub 上的 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 是 DeepSeek Harness 插件事实上的注册表,但它同时可以按 star 排序:一个跟 DSH 毫无关系的仓库蹭上这个 topic,就能排在所有真插件前面。

这个工具用机械规则审计该 topic,把仓库分成三类:

| 判定 | 含义 |
| --- | --- |
| `plugin` | 仓库根目录带 cordis bundle manifest(`cordis.patch.yml` / `cordis.yml` / `.yaml`),可用 `dsh plugin add` 安装 |
| `companion` | 根目录没有 manifest,但 README 提到 DeepSeek Harness,或写了 `dsh plugin add` —— 属于生态周边工具,留在 topic 里是合理的 |
| `not-a-plugin` | 两者皆无:没有 manifest,README 里也没有任何 DSH 关系 |

`companion` 这一类是刻意保留的。真插件和生态工具(独立 CLI、脚手架、诊断)是两种东西;把后者和"贴个 dsh-plugin 标签的简历生成器"塞进同一个桶,对任何人都没有用。

## 覆盖范围:为什么单次查询不够

首次运行时 topic 报告 **14846** 个仓库,而 GitHub 搜索接口单次查询最多返回 **1000** 条。因此单次查询运行时审计的是 star 前 1000 名 —— 恰好是 topic 页面最先展示的那一屏,也是访客实际看到的内容。

`--bands` 并不能解决全部问题:最低的三个区间本身就超过一个窗口 —— 2-4 star 有 **2755** 个、1 star **3503** 个、0 star **6581** 个,合计 12839 个仓库是星段遍历也看不到全的。`--full` 会把触顶的区间再按创建日期递归二分,直到每个窗口都放得下;个别即使在"单日"窗口仍触顶的情况会被明确标出:

```sh
node topic-audit.mjs --full --json --out audit.json
```

触顶的区间或窗口都会在输出里标出,不会静默截断;日常先用 `--bands` 快速过一遍即可。

## 首次基线

首次运行,star 前 1000 名(topic 总量 14846):`plugin` **580**、`companion` **323**、`not-a-plugin` **97**。topic star 前十里有五个与 DSH 插件无关,包括一个 42k star 的简历生成器和一个 72k star 的通用 agent 框架;这 97 个仓库合计 30 万 star,超过 580 个真插件之和(7 万)。判定完全由下面的规则复现,每一行都带 evidence。

## 用法

零依赖、免安装,clone 即用:

```sh
git clone https://github.com/ciceroyang/dsh-topic-audit
cd dsh-topic-audit

node topic-audit.mjs                              # 人读报告
node topic-audit.mjs --json --out audit.json      # 机器可读,喂给定时任务或目录站
node topic-audit.mjs --strict                     # CI 里用:出现 not-a-plugin 时退出码 1
node topic-audit.mjs --full --json --out audit.json   # 覆盖长尾
```

暂未发布到 npm(发布需要本项目当前没有的凭证),所以今天的 `npx dsh-topic-audit` 取不到包。npm 包名是空的;想自己发的话,直接在这个 clone 里 `npm publish` 即可。

设置 `GITHUB_TOKEN`(或 `GH_TOKEN`)可以解除搜索接口的匿名限流;逐仓库检查走 `raw.githubusercontent.com`,不占用 API 配额。

## 夜间索引

仓库里有一个定时 workflow,把审计结果发布成滚动的 release 资产,目录站不需要自己跑就能取到一份可验证的清单:

- JSON:`https://github.com/ciceroyang/dsh-topic-audit/releases/download/latest/audit.json`
- 计数与当期挂名榜:见 `https://github.com/ciceroyang/dsh-topic-audit/releases/tag/latest` 的说明

该资产每晚由一次干净的 `--bands` 运行重新生成,任何人都能用同一条命令复现并 diff。用滚动的 `latest` 标签是刻意的:这里提供的是一份**当前清单 + 可复核的配方**,而不是权威快照。

## 在 CI 里用

本仓库同时是一个 composite action,定时任务三行搞定:

```yaml
- uses: ciceroyang/dsh-topic-audit@main
  with:
    args: --json --out audit.json
```

action 会注入 workflow token(解除搜索限流),并把报告路径作为 `report` 输出。需要出现 `not-a-plugin` 就失败时在 `args` 里加 `--strict`;需要覆盖 star 前 1000 名之外时加 `--bands` 或 `--full`。

## 选项

| 参数 | 作用 |
| --- | --- |
| `--json` | 输出 JSON 而不是文本报告 |
| `--out <file>` | 同时写入文件(默认 markdown,配合 `--json` 写 JSON) |
| `--bands` | 按 star 区间遍历(topic 总量远超单次查询 1000 条的上限) |
| `--full` | 在 `--bands` 基础上,对仍触顶的区间按创建日期递归二分,覆盖低 star 长尾 |
| `--concurrency <n>` | 并发检查数(默认 10) |
| `--max <n>` | 最多扫描 n 个仓库(默认 1000,即搜索接口上限) |
| `--strict` | 出现 `not-a-plugin` 时退出码 1 |
| `--help` | 帮助 |

## 判定规则(逐条写清)

1. `plugin`:根目录存在 `cordis.patch.yml`、`cordis.yml`、`cordis.patch.yaml` 或 `cordis.yaml`(HTTP 200 且非空)。
2. 否则读取根目录 README(`readme.md`、`README.md`、`README.zh.md`、`readme.zh.md` 依次尝试):若含 `dsh plugin add`,或大小写不敏感地匹配 `deep[ -]?seek[ -]?harness`,判定 `companion`。
3. 其余判定 `not-a-plugin`。

每一行都带 `evidence` 字段,写明判定依据,人可以复核而不用重跑。

## 使用边界

- 只看仓库根目录。bundle 放在子目录、README 又没提的,会被判成 `not-a-plugin` —— 修法是在 README 里补一行。
- 匹配的是产品名 `DeepSeek Harness`,不是 "DeepSeek" 这个词。仅仅支持填 DeepSeek API Key 的仓库不算通过,这是刻意的:那正是一个 41k star 仓库上的误判来源。
- `raw.githubusercontent.com` 区分大小写,所以 README 探测会尝试常见拼写;README 文件名特别的话会被视为缺失。
- 搜索接口单次查询上限 1000 个仓库,而 topic 总量远大于此:单次运行覆盖 star 前 1000 名,并在报告里注明。`--bands` 按 star 区间(`stars:>=10000` 到 `stars:0`)分片抓取并去重,是接近全量覆盖的唯一方式;每个触顶的分片都会被标出,不会静默截断。
- 判定针对的是"是否在蹭 `dsh-plugin` topic",与仓库质量无关。

## 相关项目

- [dsh-doctor](https://github.com/ciceroyang/dsh-doctor) —— 单机环境、profile、会话日志诊断。
- [dsh-plugin-starter](https://github.com/ciceroyang/dsh-plugin-starter) —— 生成的插件天然通过本审计。
- [dsh-report-studio](https://github.com/ciceroyang/dsh-report-studio) —— 会话转可分享报告。

## License

MIT。[@ciceroyang](https://github.com/ciceroyang) 维护。如果它帮你省下半个下午的 topic 考古,[爱发电](https://afdian.com/a/cicero) 可以请作者喝杯咖啡。