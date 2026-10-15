# Contributing / 贡献指南

Thanks for helping grow the list! / 感谢参与！

## Adding a plugin / 收录插件

> **The READMEs are generated — don't edit them by hand.** The list lives in `data/plugins/`, one YAML file per plugin. / **两个 README 由脚本生成，请勿手工编辑。** 列表数据在 `data/plugins/`，一个插件一个 YAML 文件。

Open a PR that adds **one file**, named after your repo — `data/plugins/<owner>__<repo>.yml`:

```yaml
url: https://github.com/owner/repo        # must match the repo exactly / 必须与仓库完全一致
name: owner/repo                          # link text shown in the list / 列表中显示的链接文字
category: ui                              # see the category list below / 见下方分类列表
description:
  en: One-line description ending with a period.
  zh: 一句话描述，以句号结尾。   # optional — a maintainer will add it / 可选，维护者会补
```

**Only `description.en` is required.** If you can't write the Chinese, leave `zh` out and a maintainer will add it — a missing translation is our work, not a reason to bounce your plugin. / **只有 `description.en` 是必填的。** 写不了中文就不写 `zh`，维护者会补上——缺翻译是我们的活，不该成为你的插件被打回的理由。

**That one file is the whole submission.** The two READMEs are generated from `data/plugins/*.yml` and are regenerated on `main` after your PR merges — you do not have to run anything, and you should not edit them by hand. This is also why your PR will not conflict with anyone else's: entry files never collide, generated README lines always did. / **一个文件就是全部投稿。** 两个 README 由 `data/plugins/*.yml` 生成，你的 PR 合并后会在 `main` 上自动重新生成——你不需要跑任何命令，也不要手工编辑它们。这同时也是你的 PR 不会和别人冲突的原因：条目文件永不相撞，而生成出来的 README 行总是相撞。

Want to preview what your line will look like? Regenerating locally is fine, and committing the result is still accepted — it just has to match / 想预览你那一行长什么样？本地重新生成没问题，把结果一起提交也照样接受，只是必须与数据源一致：

```sh
npm ci
node scripts/generate-readme.mjs
```

⚠️ **A description containing `: ` must be quoted** — otherwise YAML reads it as a nested key. / **描述中含 `: `（冒号加空格）时必须加引号**，否则 YAML 会把它当成嵌套键：

```yaml
description:
  en: 'Vision toolkit: OCR, grounding and pixel diff.'   # ✅ quoted / 加引号
  zh: '识图工具包：OCR、定位与像素比对。'                    # 中文全角冒号无此问题，加引号也无妨
```

```yaml
  en: Vision toolkit: OCR, grounding and pixel diff.     # ❌ breaks the parser / 解析失败
```

**Why one file per plugin / 为什么一个插件一个文件：** everyone used to append to the same spot in the same README section, so merging one PR broke the next. Separate files never collide. / 以前所有人都往同一分类的同一位置追加，合并一个 PR 就会撞掉下一个。独立文件永不冲突。

Valid `category` values / 可用的 `category` 取值：
`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`

This set is not fixed — see the note on categories under [how submissions are reviewed](#how-submissions-are-reviewed--收录如何评审). / 这组取值不是固定的，说明见[收录如何评审](#how-submissions-are-reviewed--收录如何评审)中关于分类的那条。

Monorepo subpackages / monorepo 子包: point `url` at the subdirectory and use `owner/repo#subname` as the `name`, e.g. `url: https://github.com/owner/repo/tree/main/packages/my-plugin`. The filename becomes `owner__repo--packages-my-plugin.yml`.

Requirements / 要求：

- The repo declares a `dsh.bundle` manifest in `package.json` (this is what makes it installable via `dsh plugin add`). Monorepos qualify if the root or a subpackage declares it. / 仓库的 `package.json` 需声明 `dsh.bundle` manifest（monorepo 根包或子包声明亦可）。

  ⚠️ Most rejected submissions declare only `dsh.client` — that alone is **not** installable. A complete example / 最常见的被拒原因是只声明了 `dsh.client`——那样无法安装。完整示例：

  ```jsonc
  {
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },   // ← required / 必须
      "client": { "platform": "web" }                // only if you ship browser UI / 仅带前端 UI 时需要
    }
  }
  ```

  with a `cordis.patch.yml` next to it / 并在仓库根放一个 `cordis.patch.yml`：

  ```yaml
  - insert:
      - id: your-plugin-id
        name: your-package-name
  ```
- The repo contains real, working code — placeholder, name-squat, or README-only repos don't qualify. / 仓库需有真实可用的代码——占位仓库、纯 README 仓库不收。
- The repo is at least **1 day old**. (There is no commit-count bar: history length measures development habit, not quality — see #4196.) / 仓库**创建满 1 天**。（没有提交数门槛：历史长短反映的是开发习惯而非质量，见 #4196。）

  This is checked automatically. It isn't a judgement about your plugin — it filters out repos created minutes before the PR, which were the bulk of what had to be rejected by hand. If you're just under the bar, finish the work and resubmit; nothing is held against a resubmission. / 这一项由 CI 自动检查。它不是对插件质量的评价，只是为了过滤掉「PR 前几分钟才建好」的仓库——过去人工被迫拒掉的大多是这类。如果暂时没达标，把功能做完再提交即可，重新提交不会有任何影响。
- The project is actively maintained. A periodic scan flags entries whose repo is gone, archived, or long dormant; they're collected in a tracking issue and removed after review. / 项目处于活跃维护状态。定期扫描会标记仓库消失、已归档或长期停更的条目，汇总到一个跟踪 issue，经确认后移除。
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your repo. / 为仓库添加 `dsh-plugin` topic。
- Descriptions state what the plugin does — no superlatives or marketing. / 描述只说功能，不带营销词。
- **The description must be accurate.** It is read as a claim about your plugin, and it is checked against your code. If you write "46 tools across six domains", there should be 46 tools and six domains; if you name a command or an API, it should exist. Overstating is the one thing that gets an otherwise-good plugin sent back. / **描述必须属实。** 它会被当作对你插件的声明，并与代码核对。写「46 个工具、六大领域」，就应该真有 46 个工具和六个领域；提到某个命令或 API，它就应该存在。夸大是让一个本来不错的插件被打回的主要原因。
- **Pick the category that matches what the plugin does**, not where you'd like it to appear. A near miss is fixed by a maintainer, not bounced back. / **选贴合插件实际做的事的分类**，而不是你希望它出现在哪里。选得不够准的，维护者会直接改，不会打回。

Maintainers also add notable plugins directly — the list grows through both community PRs and editorial curation. / 维护者也会主动收录值得关注的插件——列表由社区 PR 与编辑精选共同生长。

### How submissions are reviewed / 收录如何评审

A green CI run is the **precondition**, not the decision. CI verifies the shape of a submission — manifest, repo age, formatting, that the READMEs regenerate. It cannot tell whether a plugin does what its entry says, whether the category fits, or whether an entry duplicates one already on the list. A maintainer reads the target repository before merging.

CI 通过是**前置条件**，不是结论。CI 校验的是提交的形式——manifest、仓库年龄、格式、README 能否重新生成；它无法判断插件是否名副其实、分类是否贴切、是否与已有条目重复。合并前维护者会实际阅读目标仓库。

What that review looks at / 评审会看：

1. **Does the code do what the entry claims** — including any numbers or API names in the description. / 代码是否与条目声明一致，包括描述里的数字与 API 名称。
2. **Is the category reasonable.** Nobody gets sent back over a category — if a better one fits, a maintainer just changes it. The taxonomy itself keeps moving: categories get split as they grow — `usage` and `vision` came from that, and so did `security`, `browser`, `git`, `docs`, `remote` and `voice`, all split out of `tools`, `ui` and `dev` once those had grown past the point where anyone could scan them — and categories get renamed or merged when they stop being useful. Today's best fit may be re-filed later; that is maintenance, not a correction of your judgement. Pick the closest one and don't agonise. / 分类是否合理。**不会有人因为分类被打回**——如果有更贴切的，维护者直接改。分类体系本身也在变：某一类长大了就会拆分——`usage` 与 `vision` 就是这么来的，`security`、`browser`、`git`、`docs`、`remote`、`voice` 也是，它们都是在 `tools`、`ui`、`dev` 大到没人能扫完之后从中拆出来的——不再有用的分类则会改名或合并。今天最贴切的归类以后也可能被重新归档，那是维护，不是在纠正你的判断。挑最接近的一个即可，不必纠结。
3. **Is it real, working code** rather than a placeholder or a wrapper around nothing. / 是否是真实可用的代码，而非占位或空壳。
4. **Is it already covered** by an entry on the list. Where two plugins do the same thing, whoever got here first keeps the slot — but that is a tiebreaker, not tenure. Being listed is not permanent: entries that stop being maintained, behave badly, or carry obvious defects get removed. So a fork *is* added when it is the better-kept one, or when it genuinely adds something. The rule is not first-come; the rule is whichever is better. / 是否已被现有条目覆盖。两个插件做同一件事时，先来者保留位置——但这只是平局时的排序依据，不是既得利益。收录不是永久的：停止维护、有恶意行为、存在明显缺陷的条目会被移除。所以一个分叉**是可以**被收录的——只要它维护得更好，或者确实做了新东西。规则不是先来后到，规则是谁更好。
5. **Anything alarming in the source** — obfuscated code, credential exfiltration, surprising install-time behaviour. Being listed is still **not** a security review (see the warning at the top of the README); this is a sanity check, not an audit. / 源码中是否有可疑之处——混淆代码、凭据外传、异常的安装期行为。收录仍**不等于**做过安全审查（见 README 顶部警告），这只是常识性检查，不是审计。
6. **Does the PR touch entries it has no business touching.** A PR updating one plugin should not rewrite another's description. This slipped through twice ([#1348](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/issues/1348)) because every mechanical check passed — the YAML was valid, the READMEs regenerated, lint was clean. The gate now lists every existing entry a PR modifies so it can be questioned. / PR 是否动了与它无关的条目。更新某个插件的 PR 不该改写另一个插件的描述。这类问题曾两次蒙混过关（[#1348](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/issues/1348)）——因为所有机械检查都通过了：YAML 合法、README 能生成、lint 干净。现在 gate 会列出 PR 修改的每一个既有条目，以便被追问。

7. **Is it a meta-package.** A bundle whose only content is a dependency list — it installs a set of other plugins and ships no behaviour of its own — is not listed as an entry. **List the plugins, not the bundle.** The bundle can keep existing and users can keep installing it; it just does not get a row of its own, because a row that only points at other rows tells a reader nothing they could not already see, and it double-counts the same work in every category it touches. `hyzyn/dsh-plugin-kit` and `wingsky-1/dsh-plugin-hub` are the shape to copy: both ship an all-in-one package, both list only the individual plugins. A bundle that does something itself — composes configuration, adds a settings surface, coordinates the parts at runtime — is a plugin and is judged like any other. / **是不是纯聚合包。** 内容只有一份依赖清单的聚合包——装上一组别的插件、自己不带任何行为——**不单独收录**。**收插件，不收聚合包。** 聚合包本身可以继续存在、用户也可以继续装，只是不占一行:一行只指向别的行,对读者没有增量信息,还会让同一份工作在它涉及的每个分类里被重复计数。`hyzyn/dsh-plugin-kit` 与 `wingsky-1/dsh-plugin-hub` 是可以照抄的形态:两者都发了 all-in-one 包,也都只收录了单个插件。如果聚合包自己做事——合成配置、提供设置界面、在运行时协调各部分——那它就是个插件,按普通标准审。

8. **Do its dependencies point at the original.** A bundle's dependencies must resolve to the original author's repository or their published npm package. Re-uploading other people's plugins under your own account and depending on those copies is not listed — the copies carry no fork relationship, no attribution, and no upstream, so a user installing your bundle gets a silent snapshot of someone else's work with the author's name kept only in the package name. This is not a judgement about who wrote what; depending on the upstream directly fixes it. / **依赖是否指向原作者。** 聚合包的依赖必须解析到原作者的仓库或其发布的 npm 包。把别人的插件重新上传到自己账号下、再依赖这些副本的,不予收录——副本没有 fork 关系、没有署名、也没有上游,用户装到的是别人作品的一份静默快照,而原作者只在包名里留了个名字。这不是在裁定谁写了什么;把依赖直接指向上游即可解决。

If you're updating your own entry, **change only your own entry**. Editing the READMEs by hand is the usual way this goes wrong: line positions shift as the list grows, and an edit lands on a neighbour. That's why the READMEs are generated — edit your `data/plugins/<owner>__<repo>.yml` and regenerate. / 如果你在更新自己的条目，**请只改自己那一条**。手工编辑 README 是这类事故的常见起因：列表增长会让行号移位，改动就落到了邻居身上。这正是 README 改为生成的原因——请编辑你自己的 `data/plugins/<owner>__<repo>.yml` 再重新生成。

Feedback comes as a PR comment naming exactly what to change. Being sent back for an inaccurate description isn't a rejection of the plugin — fix the line and it goes in. / 反馈会以 PR 评论给出，明确指出要改什么。因描述不准确被打回不是对插件本身的否定——改好那一行即可收录。

**One thing worth saying plainly:** we are not judges of plugin quality, and being on this list — or not being on it — is not a verdict on your work. Plenty of good software will never be here, and a slot here proves nothing beyond meeting the rules above. We have no interest in being that arbiter. The rules exist for one reason: someone landing on this page should be able to install what they pick and have it do what the line said it would. Thanks for bearing with them.

**有一点想说清楚：** 我们不是插件好坏的裁判，收录与否也不代表对你作品的评价。有很多优秀的软件永远不会出现在这里，而出现在这里也仅仅说明它符合上面这些规则，不说明别的。我们无意扮演这个裁判。这些规则只为一件事存在：让打开这个页面的人，装上他挑中的插件后，它确实做描述里写的那件事。感谢理解与配合。

Recommended for a better install experience / 推荐（更好的安装体验）：

- Publish your plugin to npm — prebuilt installs skip the `allowBuilds` build-approval step. / 发布 npm 包：预构建安装免 `allowBuilds` 构建授权。
- Not publishing to npm? Attach a prebuilt tarball to a GitHub Release and point at it with an optional `tarball:` field — storefronts will offer it instead of the build-from-source command. Required if your repo can't be installed from source at all. / 不发 npm 也可以：把预构建 tarball 附加到 GitHub Release，并用可选的 `tarball:` 字段指向它，市场会优先展示它而不是源码构建命令。**如果你的仓库根本无法从源码安装，这一项是必需的。**

  ```yaml
  tarball: https://github.com/owner/repo/releases/latest/download/your-plugin.tgz
  ```

  Must be an `https` `.tgz` on GitHub's own release hosting — the list won't hand users a download link it can't vouch for. / 必须是 GitHub Release 托管的 `https` `.tgz`——列表不会给用户一个无法担保来源的下载链接。

  ⚠️ **`latest/download/` resolves `latest` at request time but takes the filename literally.** If the asset name carries the version, the URL works the day you submit it and 404s the moment you cut your next release — a quiet rot nobody notices, least of all you. Either keep the asset name version-free (as above), or pin the release tag, where a versioned filename is the normal con