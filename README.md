# dsh-rp-card

DeepSeek Harness 插件：把你的一句话想法，做成一张能导入平台直接玩的 RP 卡。

四部分流水线、每部分人工验证、世界书规则层校验、图像能力设置、最终一键组装成平台 JSON。

> **年龄提示**：本插件面向 18 岁以上用户，用于创作虚构的成人向 / 成人题材角色扮演内容。插件本身不附带任何成人素材，所有内容由你与模型在本地生成。请自行确认所在地区法律法规与目标平台规则。

> **平台说明**：默认目标平台为 `fengyue.ai`，卡片结构按该平台导出格式适配。其他平台未做适配，字段与枚举可能不同。

---

## 安装

**npm（推荐）**：

```sh
dsh plugin --profile desktop add dsh-rp-card
```

**GitHub**（想跟最新提交时用）：

```sh
dsh plugin --profile desktop add github:chunbo824-tech/dsh-rp-card
```

**本地检出**：

```sh
dsh plugin --profile desktop add /绝对路径/dsh-rp-card
```

装完**完全退出 DSH 再打开**（不是关窗口），插件才会加载。

装好后你会得到：

- 一个对话工具 `card_build`
- 一个斜杠命令 `/card-build`
- 设置页「插件 → 图像能力」
- 生成图像时的设置弹窗

### 更新

插件由 DSH 的插件管理器维护：新版本可用时，按平台给出的更新入口操作即可；如果当前 DSH 版本没有提供更新按钮，卸载后再按上面的安装命令重装一次也能升级。

无论哪种方式，都**不影响你的作品目录**——卡片、`.card-build` 状态和产物都在工作区里，不在插件目录里。更新后建议重启一次 DSH 再继续做卡。

---

## 30 秒上手

1. 新建一个空目录作为作品目录，用 DSH 打开它。
2. 直接说你的想法，例如：

   ```text
   做一个雨夜咖啡馆的日常恋爱卡，玩家是新来的常客，店主是个话不多的女人。
   ```

3. 如果需求够清楚，它会直接开工；如果太模糊，它会先给你 2–3 个方向让你选。
4. 它给出第一部分方案，你回一句「按这个做」。
5. 它生成第一部分并停下，告诉你去平台哪里粘贴、看什么。
6. 你在平台试完，回「第 1 部分 PASS」，进入第二部分。
7. 四部分依次通过后，它组装出 `card.json`，你导入平台即可。

---

## 四部分与产物

| 部分 | 产出 | 平台字段 | 说明 |
|---|---|---|---|
| 1 写卡正文 | `01-writing.md`、`part-1-writing.json` | `name` `pre_prompt` `ptx` `post_text` `opening_statement` `lore_bk` | 主提示词、前缀、后缀、世界书 |
| 2 初始化档案页 | `02-profile.html`、`part-2-description.json` | `desc` | 玩家填资料、生成开场文本的单文件页面 |
| 3 聊天页 | `03-chat.css`、`part-3-chat.json` | `built_in_css` `rgx_rep` | 消息样式与正则替换 |
| 4 变量面板（可选） | `04-variables.md`、`part-4-variable.json` | `ai_variable_tmpl` `ai_v_prompt` `ai_v_json` `extend` | 地图、商店、状态卡等 |

前三部分做完就是**可玩版本**；第四部分是可选拓展。

每部分交付后，插件会自动产出两份可导入文件：

- `part-N-*.v2.json`：只含本部分的字段，用于单独验证；
- `card.json`：当前已交付部分的累计组装。

> 平台导入是整卡覆盖。单测某一部分就导入 part 件；恢复整张卡就导入 `card.json`。

---

## 人工验证与 PASS

- 每部分交付后流程停止，等你在平台实际测试。
- 确认通过就回「第 1 部分 PASS」；有问题就直说哪里不对，它会改。
- 「继续」不算 PASS。
- PASS 绑定文件摘要：你手动改过产物，那次 PASS 会失效。
- 第三部分通过后先停一次，让你选：组装可玩版本 / 全面评估 / 继续做变量面板。

---

## 头脑风暴与方案确认

需求太模糊时，插件不会硬猜，而是：

1. 用一句话复述它理解的需求；
2. 列出真正影响结构的缺口（最多三条）；
3. 给 2–3 个方向，每个都说清「玩家会得到什么」；
4. 你选一个，或说「你决定」，它选推荐方向并说明理由。

方案会写成 `00-design-<部分>.md`，你确认后才开始生成。每一部分都遵循同样的节奏：先方案、再实现。

---

## 图像能力（第二部分）

第二部分通常需要图像资源。插件只让你填 API Key，供应商地址、模型与参数都内置：

| 供应商 | 用途 | 获取地址 |
|---|---|---|
| Seedream 5.0 flash（火山方舟，豆包同源） | 背景图、地图、场景插画、带环境的人物图 | https://console.volcengine.com/ark/region:cn-beijing/overview |
| recraft V4.1 | 图标、装饰、需要透明背景的人物立绘 | https://www.recraft.ai/docs/api-reference/getting-started |

- 没有密钥时，进入第二部分会弹出设置窗口（也可以从「设置 → 插件 → 图像能力」打开）。
- 只填一个也能开始，缺的那类会自动跳过。
- 调用图像模型需要在对应服务商充值余额。
- 不想额外花钱，可以选「不接入图像模型（纯代码实现）」：之后不再弹窗，前端全部用 CSS / 内联 SVG / 布局完成，插件不会再尝试调用接口。

密钥存放在 `~/.dsh/.credentials.yaml` 的 `refs` 段（写入前自动备份，不影响其他插件的凭据），也可以用环境变量：

```text
IMAGE_GEN_PROVIDER_API_KEY
RECRAFT_API_KEY
```

---

## 世界书规则层

世界书不只是百科，它承担三件事：**世界运行规则**、**路由**、**按需知识**。

- **三类触发源**：内容锚（专名、行为词，按需加载）、格式字段锚（每轮输出的字段值，挂上即常驻）、格式标记锚（`IDLE`/`CONTINUE`/`END` 这类专用标记，按状态加载）。
- **常驻有预算**：合计 ≤800 字/轮，单条 ≤600 字，超了要按顺序削减。
- **路由必须写兜底**：否则状态切换的空窗期会掉规则。
- **状态机可选**：不启用时，主提示词不得承诺阶段、时限、进度。

插件会在交付时检查：常驻是否有锚词证据、路由是否覆盖分支、控制词是否成对、AND 词是否能命中、有没有空承诺等（WB101–WB113）。没有标签旁车文件时这些检查自动跳过，旧卡不受影响。

四份创作规范随插件一起分发，位于安装目录的 `docs/`，不需要你另外准备。

---

## 平台导出

- 按目标平台 40 键结构组装，字段名与枚举已实测导入通过。
- 组装会写 `card.json` 与 `build-report.md`（含验证状态、已知限制）。
- 背景图 `bg_img` / `mobile_bg` 插件不产出：请在平台导入后再设置；若来源里已有 URL 会原样保留。
- 世界书、正则、变量面板分别落在 `lore_bk`、`rgx_rep`、`ai_variable_*` 字段。

---

## 常用命令

```text
/card-build start --design clear|brainstorm
/card-build propose --part writing --file 方案.md
/card-build approve-design --part writing
/card-build template --part writing
/card-build deliver --part writing --file part-1-writing.json
/card-build pass --part writing
/card-build fail --part writing --feedback "哪里不对"
/card-build status
/card-build export --part writing
/card-build merge
/card-build assemble
```

参数基本可以省略：作品目录＝当前工作区，平台默认 `fengyue.ai`，类型自动判定。

---

## 数据与隐私

| 内容 | 位置 |
|---|---|
| 密钥 | `~/.dsh/.credentials.yaml`（`refs` 段） |
| 是否接入图像模型 | 同文件的 `RP_CARD_IMAGE_MODE` |
| 作品产物 | 你选择的工作区目录 |

插件不上传你的作品内容，只在生成图像时请求上述两个服务商。

---

## 常见问题

**没配密钥只想试试？** 选「不接入图像模型」，前端会用纯代码实现，功能不受影响，只是没有插图。

**想换平台？** 目前的导出结构是给 `fengyue.ai` 的，换平台需要改字段映射，插件未内置适配。

**中途想改已经 PASS 的部分？** 直接说要改什么。改动会让该部分 PASS 失效，相关下游部分会标记为过期，需要重新验证。

**卡住了怎么办？** `/card-build status` 看当前阶段；`pause` / `resume` 可以暂停恢复。

---

## 开发

```sh
node --test tests/*.test.mjs
```

测试覆盖：状态机、人工门禁、方案门禁、世界书标签校验、正则回归、图像设置、平台字段映射等 16 个测试文件。

---

## 许可

MIT。详见 [LICENSE](./LICENSE)。
