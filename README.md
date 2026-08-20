# Egern Komari VPS Widget

在 Egern 的 iOS 主屏幕与锁屏小组件中显示 Komari VPS 状态。

## 功能

- 在线状态、CPU、内存、硬盘、实时上下行速度和到期时间
- 大号组件显示累计流量 / 流量限额、最近 1 小时平均延迟与丢包率
- 适配 Egern 全部主屏幕及锁屏小组件尺寸
- 优先使用 Komari 1.0.7+ RPC2，并兼容旧版 REST API
- 请求失败时自动显示最近一次缓存
- 点击小组件打开 Komari 面板

到期时间超过 10 年的节点会显示为“长期有效”，不会再显示异常的超大天数。

## 通过模块安装

在 Egern 打开“工具 → 模块”，点击右上角 `+`，添加以下模块 URL：

```text
https://raw.githubusercontent.com/kkkkkc123/egern-komari-widget/main/egern-komari-widget.yaml
```

保存后，在该模块的 **Env** 中设置下面两个参数：

```text
KOMARI_URL=https://你的-komari-地址
API_KEY=你的-Komari-API-Key
```

- `KOMARI_URL`：必填。填写面板根地址，不要添加 `/api`，末尾有没有 `/` 均可。
- `API_KEY`：私有站点或需要显示隐藏节点时填写；公开面板可以留空。

新版模块会直接显示这两个输入框，不需要手动创建 Env 键名。

然后进入“分析 → 小组件画廊”，找到模块提供的 `Komari VPS`，最后在 iOS 主屏幕添加 Egern 小组件并选择它。

## 直接引用脚本

如果不安装模块，可创建一个 `generic` 类型脚本并使用：

```text
https://raw.githubusercontent.com/kkkkkc123/egern-komari-widget/main/komari-widget.js
```

再创建一个关联此脚本的小组件，并设置相同的 `KOMARI_URL`、`API_KEY` 环境变量。

## 可选环境变量

脚本还支持 `NODE_FILTER`、`TITLE`、`REFRESH_MINUTES`、`MAX_NODES`、`TIMEOUT_MS` 和 `INSECURE_TLS`。不设置时均使用安全的默认值。

## 安全提示

不要把 Komari API Key 直接写进脚本或提交到公开仓库。请只在 Egern 模块或小组件的 Env 中保存。

## 空白组件排查

1. 在 Egern 的模块详情页点击更新，确认模块已启用。
2. 确认 `KOMARI_URL` 输入框不是示例地址，并且地址未包含 `/api`。
3. 进入“分析 → 小组件画廊”，确认预览的是模块下的 `Komari VPS`。
4. 如果主屏幕仍显示旧缓存，长按小组件重新选择一次 `Komari VPS`。
5. 更新后的脚本会把运行时错误直接显示在组件中；把错误文字截图提交到仓库 Issue 即可继续定位。
