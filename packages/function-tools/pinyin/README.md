# pinyin

汉字转拼音 function tool。例如输入 `北京`，返回 `beijing`。

工具名是 `chinese_to_pinyin`。非汉字会原样保留。`separator` 控制音节之间的分隔符，默认空字符串。`tone` 为 `true` 时在音节后附加声调数字，例如 `北京` 返回 `bei3jing1`。

转换使用本地常用汉字拼音表，不访问网络，也不需要密钥。常见词组使用词组读音，例如 `重庆` 返回 `chongqing`；未收录的多音字返回常见默认读音。

## 打包

```bash
pnpm --filter @open-agent-tools/function-tools build-package -- --tool=pinyin
```
