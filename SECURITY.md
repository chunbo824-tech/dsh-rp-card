# 安全说明

## 本仓库不含任何 API Key

插件源码、规范文档、测试与示例中都没有真实密钥。测试里出现的 `sk-seedream-test` 一类字符串是假值，只用于验证读写逻辑。

## 密钥存在哪里

| 数据 | 位置 | 说明 |
|---|---|---|
| 图像模型密钥（Seedream / Recraft） | `~/.dsh/.credentials.yaml` 的 `refs` 段 | 通过 DSH 凭据服务读写；写入前自动备份，保留其他插件的凭据 |
| 是否接入图像模型 | 同文件的 `RP_CARD_IMAGE_MODE`（`keys` / `none`） | 选择「不接入」后不再弹设置卡 |
| 生成的作品产物 | 用户当前工作区 | `card.json`、`part-*.json`、`0X-*` 等；不写系统目录 |

插件不会把密钥写入工作区、日志或卡片 JSON。

## 环境变量（可选）

密钥也可以放在环境变量里，优先级高于凭据文件：

```text
IMAGE_GEN_PROVIDER_API_KEY   Seedream（火山方舟）
RECRAFT_API_KEY             Recraft
```

## 网络请求

只有在用户主动生成图像时，插件才会请求：

- `https://ark.cn-beijing.volces.com/api/v3`（Seedream）
- `https://external.api.recraft.ai/v1`（Recraft）

其余功能全部本地执行，不上传作品内容。

## 报告问题

发现密钥泄漏或安全问题，请开 issue 并**不要**在 issue 里粘贴任何真实密钥。若已泄漏，请立刻到对应服务商后台吊销并重新生成。
