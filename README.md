# Gold Price Logic Desk

一个黄金价格逻辑分析台，用底层价格逻辑把黄金拆成四类驱动：

- 机会成本：实际利率
- 货币信用：美元与通胀预期
- 保险价值：风险冲击与 VIX
- 边际买盘：趋势、突破与仓位

平台包含实时数据读取、仓位/止损参考、60年历史回测和对抗性反例检查。

## 本地运行

```bash
node server.js
```

打开：

```text
http://localhost:4173
```

## 发布到 Render

1. 把项目推到 GitHub。
2. 在 Render 新建 Web Service。
3. 选择该仓库。
4. Render 会读取 `render.yaml`。
5. 发布完成后，把 Render 给出的公网链接发给朋友。

## 数据源

- 黄金长历史：DataHub `gold-prices`，1960 年后来源于 World Bank Commodity Markets portal。
- 黄金近期价格：BullionVault chart data。
- 宏观变量：FRED。

## 风险提示

本项目只用于研究和展示，不构成投资建议。杠杆交易可能导致快速亏损，任何仓位、止损和方向输出都需要自行复核。
