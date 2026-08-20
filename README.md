# Egern Komari VPS Widget

在 Egern 的 iOS 主屏幕与锁屏小组件中显示 Komari VPS 状态。

## 功能

- 在线状态、CPU、内存、磁盘、实时上下行速度和到期天数
- 适配 Egern 全部主屏幕及锁屏小组件尺寸
- 优先使用 Komari 1.0.7+ RPC2，并兼容旧版 REST API
- 请求失败时自动显示最近一次缓存
- 点击小组件打开 Komari 面板

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
