# 发布到 GitHub 的完整流程（dsh-model-rotator）

> 这份文件是为「明天醒来后照着做」写的。全程约 15 分钟，只有 3 个地方需要你动手。
> 顺便更正一处：**GitHub 并不是完全不通**——本机是国内网络，时通时断，
> 所以任何一步失败都可以直接重试，不必当成永久故障。

---

## 第 0 步：确认用户名（唯一必填的信息）

所有 URL 现在写的是 `chimney`（取自本机 `git config user.name`，
`user.email=826766879@qq.com`），**这不一定等于你的 GitHub 账号名**。

先确认你的真实用户名，然后全局替换：

```powershell
cd D:\DS_harness\dsh-model-rotator-publish
# 把 <你的用户名> 换成真实值，下面命令会同时改文件名与内容
$me = '<你的用户名>'
(Get-Content package.json -Raw).Replace('chimney', $me) | Set-Content package.json -NoNewline
Rename-Item awesome-dsh-plugin-entry\data\plugins\chimney__dsh-model-rotator.yml "$me`__dsh-model-rotator.yml"
$f = "awesome-dsh-plugin-entry\data\plugins\$me`__dsh-model-rotator.yml"
(Get-Content $f -Raw).Replace('chimney', $me) | Set-Content $f -NoNewline
```

改完自查（三处都应是你的用户名）：

```powershell
Select-String -Path package.json -Pattern "github.com"
Get-Content awesome-dsh-plugin-entry\data\plugins\*.yml
```

---

## 第 1 步：处理本机 git 的镜像改写

本机全局配置把 github.com 重写到了一个镜像，而该镜像在本机会 TLS 失败
（`schannel SEC_E_NO_CREDENTIALS`）。**推送前必须临时移除**：

```powershell
git config --global --unset url."https://gh-proxy.net/".insteadOf
```

推完之后，如果你想恢复原来的镜像设置：

```powershell
git config --global url."https://gh-proxy.net/".insteadOf "https://github.com/"
```

> 注意：置空之后直连 github.com 仍然可能因为国内网络时通时断而失败。
> **失败就直接重试同一命令**，或换成 `git config --global http.proxy` 走你自己的代理。

---

## 第 2 步：建仓并推送

```powershell
cd D:\DS_harness\dsh-model-rotator-publish
git init -b main
git add .
git commit -m "dsh-model-rotator: model auto-ranking and transparent failover"
git remote add origin https://github.com/$me/dsh-model-rotator.git
git push -u origin main
```

推送会要求凭据。本机 `gh` 未登录、凭据管理器里也没有 GitHub 条目，二选一：

- **推荐**：`gh auth login`（浏览器登录），然后
  `gh repo create dsh-model-rotator --public --source . --push`
- 或者：用 Personal Access Token 作为密码（`git push` 提示时
  Username 填用户名、Password 粘贴 token）

---

## 第 3 步：仓库设置（会被收录 CI 检查）

1. 打开仓库 → **Settings → Topics**，添加 `dsh-plugin`
   （收录规范明确要求；`package.json` 的 keywords 里也已经有它）
2. **仓库必须创建满 1 天**。CI 会自动检查创建时间，当天新建的仓库会被拒。
   所以如果今天刚建，明天再提 PR 即可——插件本身可以先推上去。

---

## 第 4 步：提交收录 PR

往 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
提一个 PR，**只添加一个文件**：

```
data/plugins/<你的用户名>__dsh-model-rotator.yml
```

内容已经生成好，直接复制：

```powershell
Get-Content awesome-dsh-plugin-entry\data\plugins\*__dsh-model-rotator.yml
```

PR 操作：
1. 在 GitHub 上 fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 在网页上 **Add file → Create new file**，文件名填
   `data/plugins/<你的用户名>__dsh-model-rotator.yml`，内容粘贴上面的 YAML
3. 提交并开 PR

⚠️ **千万不要手改那个仓库的两个 README**——它们由脚本从 `data/plugins/*.yml` 生成。

---

## 第 5 步：已经替你做完的自检（可跳过）

| 检查 | 结果 |
|------|------|
| `dsh.bundle` manifest + 根目录 `cordis.patch.yml` | 齐备（这是最常见的被拒原因） |
| `files[]` / `exports` 指向的文件 | 全部存在 |
| `private` 字段 | 已移除 |
| 是否有 bare import 依赖宿主 | 无 |
| `main` 入口 / LICENSE 与 `license` 字段 | 一致（MIT） |
| README 声明的工具数 = 代码实际注册数 | 3 = 3 |
| README 声称的能力（通知行、渠道名） | 代码中均存在 |
| 三套离线测试（在**发布副本**上跑） | 140 / 48 / 34 全绿，`node test-offline.mjs` 等三条命令可复现 |
| 发布自检（`release-check.mjs`） | 17 项全过：manifest / files / exports / 无裸导入 / 工具数 / 渠道开关判向 / 收录条目 |
| 收录条目 YAML | 已被真实 YAML 解析器解析通过 |

---

## 常见问题

**Q: `git push` 报 TLS / schannel 错误？**
A: 第 1 步没做，或做了但网络正好断了。先确认 `git config --global --list` 里
没有 `gh-proxy` 的 insteadOf，然后重试。

**Q: 收录 PR 被拒？**
A: 规范里列的原因按频率是：只声明了 `dsh.client`（本包没这问题）→ 仓库不满 1 天
→ 描述与代码不符。前两条是时间问题，第三条本包已逐条核对。

**Q: 想先本地验证插件能装吗？**
A: 在 DSH 里执行：

```powershell
dsh plugin --profile desktop add D:\DS_harness\dsh-model-rotator-publish
```

装完需要**完全重启** DeepSeek Harness，然后打开 设置 → 模型自动切换。
