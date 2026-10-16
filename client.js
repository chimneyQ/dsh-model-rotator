window.__ModuleLoader__.load({
  id: "dsh-model-rotator",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    let jsxRuntime = require("react/jsx-runtime");
    let P = require("@deepseek-ai/dsh-client-ui-primitives");
    let jsx = jsxRuntime.jsx;
    let jsxs = jsxRuntime.jsxs;

    //#region lib/types/client/locales.js
    /** Locale bundles for the model rotator's settings page. */
    const zh = {
      "title": "模型自动切换",
      "description": "发现可用模型、按连通率与速度排序，并在当前模型不可用时自动切换到下一个候选。",
      "enabled": "启用自动切换",
      "enabledHint": "总开关。关闭后插件不再介入任何请求，一切照原样直连。",
      "maxCandidates": "每轮最多尝试几个模型",
      "maxCandidatesHint": "一轮对话里最多换几个候选（1 到 8）。",
      "confirmSwitch": "切换前先询问我",
      "confirmSwitchHint": "要换模型时先在对话里问你一次。超时未答按下面的等待上限自动切换；选「保持当前模型」就不换。",
      "confirmTimeoutMs": "询问等待上限（毫秒）",
      "confirmTimeoutMsHint": "超过这个时间仍没有回答就自动切换；范围 1000 到 600000。",
      "retriesPerModel": "判定失败前先重试几次",
      "retriesPerModelHint": "同一个模型先重试几次才算真的失败（0 到 5）。填 0 表示一次失败就立刻换。",
      "retryBackoffMs": "重试前的退避时长（毫秒）",
      "retryBackoffMsHint": "第 n 次重试前等待 n 倍这个时间，避免把限流的渠道打得更狠；范围 0 到 60000。",
      "noticeSwitch": "切换后在对话里提示",
      "noticeSwitchHint": "模型切换后，在对话里加一行提示（形如「模型已切换：A → B」）。它是上下文提示行，不是模型回复，也不会触发新的模型调用。",
      "preferSameModel": "优先同名模型",
      "preferSameModelHint": "换模型时先试其他渠道的同名模型，再试相近型号，最后才按测量排名。",
      "adoptSwitchedModel": "切换后更新本会话的模型",
      "adoptSwitchedModelHint": "让真正作答的模型成为本会话的模型，对话界面随即显示它。只写在会话里：不改任何 provider 配置，也不写默认模型。",
      "cooldownBaseMs": "冷却起始时长（毫秒）",
      "cooldownBaseMsHint": "失败后该模型休息多久；连续失败按倍数增长。",
      "maxCooldownMs": "冷却上限（毫秒）",
      "maxCooldownMsHint": "冷却时长增长到多少毫秒就不再增长。",
      "quotaCooldownMs": "额度耗尽后的休息时长（毫秒）",
      "quotaCooldownMsHint": "额度或余额不足后该模型休息多久，从失败时刻起算。0 表示与其他失败一样按普通退避处理。",
      "quotaCooldownHour": "额度恢复的本地整点",
      "quotaCooldownHourHint": "额度耗尽的模型几点可以再试（本地小时 0-23）。休息至少持续到次日这个整点，凌晨失败也不会当天复活。",
      "statsPersistTtlMs": "测量数据跨重启保留时长（毫秒）",
      "statsPersistTtlMsHint": "连通率、冷却等测量记录在重启后保留多久。额度冷却以小时计，重启不该把它清掉；0 表示不落盘。",
      "allowImageFailover": "带图片的轮次也参与切换",
      "allowImageFailoverHint": "默认只对纯文本轮次切换；打开后带图片的轮次也会换模型。",
      "overridden": "已覆盖",
      "reset": "恢复默认",
      "readOnly": "本部署的设置为只读。",
      "unavailable": "该插件当前未加载，暂时无法配置。",
      "save": "保存",
      "saving": "保存中…",
      "saveFailed": "本部署没有接受这些值，已保留供你修改。",
      "invalidNumber": "请填数字；留空表示使用默认值。",
      "note": "嵌套的权重（weights.connectivity / weights.speed）不在本页，需要时改 config.json。",
      "models.title": "模型列表",
      "models.hint": "扫描到的全部模型，按渠道分组。每行显示连通情况（可用 / 冷却中 / 额度耗尽 / 已关闭），可以逐个手动关闭或重新启用。",
      "models.loading": "正在读取模型列表…",
      "models.reload": "刷新",
      "models.hide": "收起",
      "models.show": "展开",
      "models.empty": "还没有扫描到任何模型。",
      "models.failed": "读取模型列表失败：",
      "models.channel": "渠道",
      "models.rotation": "参与切换",
      "models.summary": "共 {total} 个模型，{rotating} 个参与切换，{disabled} 个已关闭",
      "models.group.chat": "对话渠道",
      "models.group.vision": "识图模式（vision-router 创建）",
      "models.groupHint.chat": "这些是参与自动切换的候选。",
      "models.groupHint.vision": "vision-router 为每个渠道生成的识图孪生，是同一个模型套了图像管线，不参与切换；个别命名不规范的 wrapper 可用行末开关放回。",
      "models.counts": "{n} 个 · 可用 {ok} · 冷却 {resting} · 关闭 {off}",
      "models.channelOk": "全部可用",
      "models.channelOff": "全部关闭",
      "models.expandAll": "全部展开",
      "models.collapseAll": "全部收起",
      "models.search": "搜索模型…（空格分隔多个关键词，需全部命中）",
      "models.searchClear": "清除",
      "models.searchHits": "命中 {n} / {total} 个模型",
      "models.searchNone": "没有匹配的模型",
      "models.visionBadge": "识图",
      "models.reason.channel": "整个渠道已关闭",
      "models.disableChannel": "关闭本渠道",
      "models.enableChannel": "启用本渠道",
      "models.on": "已启用",
      "models.off": "已关闭",
      "models.enable": "启用",
      "models.disable": "关闭",
      "models.health.ok": "可用",
      "models.health.error": "异常",
      "models.health.cooling": "冷却中",
      "models.health.quota": "额度耗尽",
      "models.health.off": "已关闭",
      "models.health.unknown": "未测",
      "models.rest": "{m} 分钟后重试",
      "models.reason.manual": "已手动关闭",
      "models.reason.provider": "该渠道在 config.json 的 excludeProviders 中",
      "models.reason.excluded": "在 config.json 的 excludeModels 中",
      "models.reason.non-chat": "非对话模型",
      "models.reason.combo": "组合路由",
      "models.reason.vision": "识图模式（vision-router 创建的同名模型，不参与切换）",
      "models.lastError": "最近错误",
      "models.never": "没有测量记录",
      "models.readOnly": "config.json 不可写，这次改动只对当前进程有效。",
      "models.writeFailed": "写入 config.json 失败，改动未保存。"
    };
    const en = {
      "title": "Model failover",
      "description": "Discovers usable models, ranks them by connectivity and speed, and switches to the next candidate when the current one stops working.",
      "enabled": "Enable automatic failover",
      "enabledHint": "Master switch. When off, the plugin stays out of every request.",
      "maxCandidates": "Models to try per turn",
      "maxCandidatesHint": "How many candidates one turn may walk (1 to 8).",
      "confirmSwitch": "Ask me before switching",
      "confirmSwitchHint": "Ask in the conversation before changing model. If nobody answers within the wait below, it switches anyway; choosing \"keep the current model\" never switches.",
      "confirmTimeoutMs": "Wait for the answer (ms)",
      "confirmTimeoutMsHint": "After this long without an answer the switch happens automatically; 1000 to 600000.",
      "retriesPerModel": "Retries before a model counts as failed",
      "retriesPerModelHint": "How many extra tries one model gets before it really counts as failed (0 to 5). 0 means the first failure switches immediately.",
      "retryBackoffMs": "Backoff before each retry (ms)",
      "retryBackoffMsHint": "The n-th retry waits n times this long, so a throttled provider is not hammered harder; 0 to 60000.",
      "noticeSwitch": "Announce a switch in the conversation",
      "noticeSwitchHint": "After a switch, post one line in the conversation (like \"model switched: A → B\"). It is a context notice row, not a model reply, and triggers no further model call.",
      "preferSameModel": "Prefer the same model elsewhere",
      "preferSameModelHint": "Try the same model on another provider first, then close relatives, and only then the measured ranking.",
      "adoptSwitchedModel": "Show the served model in this session",
      "adoptSwitchedModelHint": "Makes the model that really answered the model of this session, so the conversation displays it. Session only: no provider configuration and no saved default is touched.",
      "cooldownBaseMs": "First cooldown (ms)",
      "cooldownBaseMsHint": "How long a failed model rests; consecutive failures grow it by multiples.",
      "maxCooldownMs": "Cooldown ceiling (ms)",
      "maxCooldownMsHint": "Cooldown growth stops at this many milliseconds.",
      "quotaCooldownMs": "Rest after a quota wall (ms)",
      "quotaCooldownMsHint": "How long a model rests once its quota or balance is gone, counted from the failure. 0 treats it like any other failure and keeps the ordinary backoff.",
      "quotaCooldownHour": "Hour a quota-exhausted model returns",
      "quotaCooldownHourHint": "Local hour (0-23) at which an exhausted model may be tried again. The rest always reaches this hour of the following day, so a failure just after midnight never revives the same evening.",
      "statsPersistTtlMs": "Keep measurements across restarts (ms)",
      "statsPersistTtlMsHint": "How long connectivity, cooldowns and the last failure survive a restart. A quota rest is measured in hours, and a restart should not undo it; 0 disables the file.",
      "allowImageFailover": "Also fail over image turns",
      "allowImageFailoverHint": "By default only text-only turns switch; with this on, turns carrying images switch too.",
      "overridden": "Overridden",
      "reset": "Reset to default",
      "readOnly": "This deployment stores settings read-only.",
      "unavailable": "This plugin is not loaded, so it cannot be configured right now.",
      "save": "Save",
      "saving": "Saving…",
      "saveFailed": "The deployment did not accept these values; they were left for you to correct.",
      "invalidNumber": "Enter a number, or leave blank to use the default.",
      "note": "The nested weights (weights.connectivity / weights.speed) are not on this page; edit config.json for those.",
      "models.title": "Models",
      "models.hint": "Every discovered model, grouped by channel, with its health (usable / cooling / quota / off). Each row can be switched off or back on by hand.",
      "models.loading": "Reading the model list…",
      "models.reload": "Refresh",
      "models.hide": "Hide",
      "models.show": "Show",
      "models.empty": "No model has been discovered yet.",
      "models.failed": "Could not read the model list: ",
      "models.channel": "Channel",
      "models.rotation": "In rotation",
      "models.summary": "{total} models, {rotating} in rotation, {disabled} off",
      "models.group.chat": "Chat channels",
      "models.group.vision": "Vision mode (created by vision-router)",
      "models.groupHint.chat": "These are the failover candidates.",
      "models.groupHint.vision": "The image-reading twins vision-router generates for each channel: one model behind an image pipeline, never a failover candidate. A wrapper with an unusual name can be put back with the switch on its row.",
      "models.counts": "{n} total · {ok} usable · {resting} cooling · {off} off",
      "models.channelOk": "all usable",
      "models.channelOff": "all off",
      "models.expandAll": "Expand all",
      "models.collapseAll": "Collapse all",
      "models.search": "Search models… (space-separated terms must all match)",
      "models.searchClear": "Clear",
      "models.searchHits": "{n} of {total} models match",
      "models.searchNone": "No model matches",
      "models.visionBadge": "vision",
      "models.reason.channel": "the whole channel is switched off",
      "models.disableChannel": "Disable channel",
      "models.enableChannel": "Enable channel",
      "models.on": "Enabled",
      "models.off": "Disabled",
      "models.enable": "Enable",
      "models.disable": "Disable",
      "models.health.ok": "usable",
      "models.health.error": "failing",
      "models.health.cooling": "cooling",
      "models.health.quota": "quota",
      "models.health.off": "off",
      "models.health.unknown": "untested",
      "models.rest": "retry in {m}m",
      "models.reason.manual": "switched off by hand",
      "models.reason.provider": "channel is in excludeProviders in config.json",
      "models.reason.excluded": "listed in excludeModels in config.json",
      "models.reason.non-chat": "not a chat model",
      "models.reason.combo": "combo route",
      "models.reason.vision": "vision mode (the same model wrapped by vision-router; never a failover candidate)",
      "models.lastError": "last error",
      "models.never": "no measurements yet",
      "models.readOnly": "config.json is not writable; this change applies to the running process only.",
      "models.writeFailed": "Writing config.json failed; the change was not saved."
    };

    /** The form frame's copy, read from this page's dictionary. */
    function formLabels(t) {
      return {
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving")
      };
    }
    //#endregion

    //#region lib/types/client/fields.js
    /** The fields this page owns, in the order it renders them. */
    const FIELDS = [
  { field: 'enabled', kind: 'bool', label: 'enabled', hint: 'enabledHint' },
  { field: 'maxCandidates', kind: 'number', label: 'maxCandidates', hint: 'maxCandidatesHint' },
  { field: 'confirmSwitch', kind: 'bool', label: 'confirmSwitch', hint: 'confirmSwitchHint' },
  { field: 'confirmTimeoutMs', kind: 'number', label: 'confirmTimeoutMs', hint: 'confirmTimeoutMsHint' },
  { field: 'retriesPerModel', kind: 'number', label: 'retriesPerModel', hint: 'retriesPerModelHint' },
  { field: 'retryBackoffMs', kind: 'number', label: 'retryBackoffMs', hint: 'retryBackoffMsHint' },
  { field: 'preferSameModel', kind: 'bool', label: 'preferSameModel', hint: 'preferSameModelHint' },
  { field: 'noticeSwitch', kind: 'bool', label: 'noticeSwitch', hint: 'noticeSwitchHint' },
  { field: 'adoptSwitchedModel', kind: 'bool', label: 'adoptSwitchedModel', hint: 'adoptSwitchedModelHint' },
  { field: 'cooldownBaseMs', kind: 'number', label: 'cooldownBaseMs', hint: 'cooldownBaseMsHint' },
  { field: 'maxCooldownMs', kind: 'number', label: 'maxCooldownMs', hint: 'maxCooldownMsHint' },
  { field: 'quotaCooldownMs', kind: 'number', label: 'quotaCooldownMs', hint: 'quotaCooldownMsHint' },
  { field: 'quotaCooldownHour', kind: 'number', label: 'quotaCooldownHour', hint: 'quotaCooldownHourHint' },
  { field: 'statsPersistTtlMs', kind: 'number', label: 'statsPersistTtlMs', hint: 'statsPersistTtlMsHint' },
  { field: 'allowImageFailover', kind: 'bool', label: 'allowImageFailover', hint: 'allowImageFailoverHint' },
    ];

    /** Inline layout for the toggle rows; the page ships no stylesheet. */
    const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 0" };
    const labelStyle = { display: "flex", flexDirection: "column", gap: "2px" };
    const nameStyle = { fontSize: "13px" };
    const hintStyle = { fontSize: "12px", opacity: 0.7, maxWidth: "46em" };
    const controlsStyle = { display: "flex", alignItems: "center", gap: "8px", flex: "0 0 auto" };
    const resetStyle = { background: "transparent", border: "none", color: "inherit", opacity: 0.75, cursor: "pointer", fontSize: "12px", textDecoration: "underline", padding: 0 };

    /**
     * A boolean setting: label, hint, and the shared switch.
     * The primitives expose no boolean field control, so the row is local and
     * drives the same staged text ("true"/"false"/"" = default) as the others.
     */
    function BoolField(props) {
      const t = props.t;
      const state = props.state;
      const field = props.spec.field;
      const fieldState = state[field] === undefined ? {} : state[field];
      const disabled = !state.writable;
      return jsxs("div", {
        style: rowStyle,
        children: [
          jsxs("div", {
            key: "label",
            style: labelStyle,
            children: [
              jsx("div", { key: "name", style: nameStyle, children: t(props.spec.label) }),
              jsx("div", { key: "hint", style: hintStyle, children: t(props.spec.hint) })
            ]
          }),
          jsxs("div", {
            key: "controls",
            style: controlsStyle,
            children: [
              fieldState.overridden === true
                ? jsx("button", {
                    key: "reset",
                    type: "button",
                    style: resetStyle,
                    disabled: disabled,
                    onClick: () => props.onReset(),
                    children: t("reset")
                  })
                : null,
              jsx(P.Switch, {
                key: "switch",
                checked: fieldState.text === "true",
                disabled: disabled,
                label: t(props.spec.label),
                onChange: (next) => props.onEdit(next ? "true" : "false")
              })
            ]
          })
        ]
      });
    }
    //#endregion

    //#region lib/types/client/ModelList.js
    /**
     * Where the host serves the model list, and where this page writes a switch.
     * Kept in sync with MODELS_PATH in index.js.
     */
    const MODELS_PATH = "/_dsh/model-rotator/models";

    /** Colour per health, so the row states are readable without a legend. */
    const HEALTH_COLOR = {
      ok: "#2ea043",
      error: "#d1242f",
      cooling: "#bf8700",
      quota: "#8250df",
      off: "#8b949e",
      unknown: "#8b949e"
    };

    const listStyle = { marginTop: "20px", borderTop: "1px solid rgba(128,128,128,0.25)", paddingTop: "14px" };
    /** The search box: full width, inherits the form's type styling. */
    const searchInputStyle = {
      flex: "1 1 auto", minWidth: "0", padding: "5px 8px", fontSize: "13px",
      border: "1px solid rgba(128,128,128,0.4)", borderRadius: "4px",
      background: "transparent", color: "inherit"
    };
    const listHeadStyle = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" };
    const listTitleStyle = { fontSize: "13px", fontWeight: 600 };
    const listHintStyle = { fontSize: "12px", opacity: 0.7, margin: "4px 0 10px", maxWidth: "46em" };
    const channelStyle = { marginTop: "12px" };
    const modelRowStyle = { display: "flex", alignItems: "center", gap: "10px", padding: "6px 0", borderTop: "1px solid rgba(128,128,128,0.12)" };
    const modelNameStyle = { fontFamily: "monospace", fontSize: "12px", flex: "1 1 auto", wordBreak: "break-all" };
    const modelMetaStyle = { fontSize: "11px", opacity: 0.65, flex: "0 0 auto", textAlign: "right" };
    const dotStyle = (health) => ({ width: "8px", height: "8px", borderRadius: "50%", background: HEALTH_COLOR[health] ?? HEALTH_COLOR.unknown, flex: "0 0 auto" });
    const badgeStyle = (health) => ({ fontSize: "11px", color: HEALTH_COLOR[health] ?? HEALTH_COLOR.unknown, flex: "0 0 auto", minWidth: "4.5em" });
    const smallButtonStyle = { background: "transparent", border: "1px solid rgba(128,128,128,0.4)", borderRadius: "4px", color: "inherit", cursor: "pointer", fontSize: "11px", padding: "2px 8px", flex: "0 0 auto" };
    const disclosureStyle = { display: "flex", alignItems: "baseline", gap: "6px", width: "100%", background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "4px 0", textAlign: "left", font: "inherit" };
    const chevronStyle = { fontSize: "10px", opacity: 0.7, width: "1em", flex: "0 0 auto" };
    const groupNameStyle = { fontSize: "12.5px", fontWeight: 600 };
    const groupMetaStyle = { fontSize: "11px", opacity: 0.6 };
    const groupHintStyle = { fontSize: "11.5px", opacity: 0.6, margin: "0 0 6px 1.6em", maxWidth: "46em" };
    const channelWrapStyle = { marginLeft: "1.6em" };
    const channelHeadWrapStyle = { marginLeft: "1.6em" };
    const channelDisclosureStyle = Object.assign({}, disclosureStyle, { paddingTop: "2px", paddingBottom: "2px" });
    const channelNameStyle = { fontSize: "12px", flex: "0 0 auto" };
    const channelTallyStyle = { fontSize: "11px", opacity: 0.65, fontFamily: "monospace" };
    const channelTallyStyleDim = Object.assign({}, channelTallyStyle, { opacity: 0.4 });
    const modelWrapStyle = { marginLeft: "1.2em" };
    const channelButtonStyle = Object.assign({}, smallButtonStyle, { marginLeft: "auto" });
    const channelHeadRowStyle = { display: "flex", alignItems: "center", gap: "6px", width: "100%" };
    const channelHeadButtonStyle = Object.assign({}, channelDisclosureStyle, { flex: "1 1 auto", width: "auto" });

    /** Fill the {name} holes in a translated sentence. */
    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (whole, name) => values[name] === undefined ? whole : String(values[name]));
    }

    /**
     * The grouped model list, with one manual switch per row.
     *
     * It reads its own data over HTTP rather than through the settings form: the
     * form carries the user's *policy* (how many candidates, how long to wait),
     * while this is a *roster* that changes whenever a provider republishes, and
     * whose rows are written to config.json one at a time instead of staged and
     * saved together. Keeping it out of the staged form also means a refresh
     * cannot silently discard a half-typed number above it.
     */
    function ModelList(props) {
      const t = props.t;
      const [state, setState] = React.useState({ status: "loading", data: null, error: "" });
      const [busy, setBusy] = React.useState("");
      const [note, setNote] = React.useState("");
      // Open by default: the roster is the answer to "what is available and what
      // is wrong", and a reader who opened the Settings page to ask that should
      // not have to ask twice. It collapses because ~900 rows are a lot to scroll
      // past when the policy fields are the actual destination.
      const [open, setOpen] = React.useState(true);
      // Folds, keyed by group ('chat' / 'vision') or by "group/provder". Chat
      // starts open (those are the candidates) and the vision twins start closed
      // (there are as many of them as everything else, and they never rotate) -
      // which is the shape that makes ~900 rows readable at all. Every provider
      // line folds on its own from there.
      const [folded, setFolded] = React.useState({ chat: false, vision: true });
      // The roster is ~900 rows, so a reader hunting one model name otherwise has
      // to scroll every channel. The query filters by substring over
      // "provider/model" (case-insensitive); an empty query is the unfiltered view.
      const [query, setQuery] = React.useState("");
      /**
       * Whether a row survives the current query.
       *
       * Matching is a case-insensitive substring over "provider/model" rather than
       * a token list: the roster is read by a human looking for one name they
       * half-remember, and "" always matches, so an empty box is the full list.
       *
       * Declared with the state, above every reader: the header, the counter and
       * the rows all call it during the same render pass.
       */
      const matches = (row) => {
        // Split on whitespace and require EVERY token, rather than matching the whole
        // box as one substring. A reader types "deepseek flash", not
        // "deepseek-v4-flash": as a single substring the first form matches nothing
        // while the second matches only the rows that happen to be hyphenated that
        // way. Per-token AND is what the half-remembered name actually needs.
        const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return true;
        const hay = (String(row.provider) + "/" + String(row.model)).toLowerCase();
        for (const token of tokens) if (!hay.includes(token)) return false;
        return true;
      };
      // True whenever the box holds something. Declared with the state, before
      // anything that reads it: the box renders before the payload is inspected,
      // so a declaration further down would be a temporal-dead-zone read.
      const searching = query.trim() !== "";
      // How many models match, for the line under the box. Read straight off the
      // payload rather than the later `data` binding: the header renders before
      // that binding exists, and reaching for it here was a temporal-dead-zone
      // read that crashed the whole page on first paint.
      /**
       * How many models match, for the line under the box.
       *
       * Computed where it is read rather than declared once: on the first paint the
       * payload has not arrived yet (the effect fills it a tick later), so a value
       * captured at declaration time stayed 0 and the counter reported "no match"
       * while the matching rows were plainly on screen.
       */
      const matchedCount = () => {
        if (!searching) return 0;
        const payload = state.data;
        if (payload === null || payload === undefined) return 0;
        // Prefer the flat roster. Fall back to walking the sections when the host
        // sent none: `models` is the newer field, and a host that omits it would
        // otherwise make the counter claim "no match" while the rows were on screen.
        if (Array.isArray(payload.models) && payload.models.length > 0) {
          return payload.models.filter(matches).length;
        }
        const sections = Array.isArray(payload.groups) ? payload.groups : [];
        let n = 0;
        for (const group of sections) {
          for (const channel of group.channels || []) {
            for (const row of channel.models || []) if (matches(row)) n += 1;
          }
        }
        return n;
      };
      const flip = (key) => setFolded((prev) => Object.assign({}, prev, { [key]: !prev[key] }));
      /**
       * Collapse or expand every section and channel at once.
       *
       * Both layers are written into the same map, so a single key answers for a
       * section and for each provider inside it - and a later per-row click simply
       * overrides its own key, because it is the same map.
       */
      const foldAll = (value) => setFolded((prev) => {
        // Every key this render could have written, plus the two section keys. The
        // previously folded ids are carried over too, so a channel that disappeared
        // from a refresh does not resurrect as expanded when it comes back.
        const next = Object.assign({}, prev, { chat: value, vision: value });
        for (const channel of channelIds) next[channel] = value;
        return next;
      });
      // Filled during render with "<section>/<provider>" for every row on screen.
      const channelIds = [];

      const load = React.useCallback(() => {
        setState((prev) => ({ status: "loading", data: prev.data, error: "" }));
        return fetch(MODELS_PATH, { headers: { accept: "application/json" } })
          .then((response) => response.json().catch(() => null).then((payload) => ({ response, payload })))
          .then(({ response, payload }) => {
            if (!response.ok) throw new Error((payload && payload.error) || ("HTTP " + response.status));
            setState({ status: "ready", data: payload, error: "" });
          })
          .catch((error) => {
            setState((prev) => ({ status: "failed", data: prev.data, error: String((error && error.message) || error) }));
          });
      }, []);

      React.useEffect(() => { void load(); }, [load]);

      /**
       * Flip one model row, or one whole channel (scope: "provider").
       *
       * Both go through the same POST because both write the same file with the
       * same contract; only the key and the list it lands in differ.
       */
      const toggle = React.useCallback((row, enabled, scope) => {
        // A channel row carries "provider" and its models; a model row carries "key".
        const isChannel = scope === "provider";
        const key = isChannel ? row.provider : row.key;
        setBusy(key);
        setNote("");
        fetch(MODELS_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: key, enabled: enabled, scope: isChannel ? "provider" : "model" })
        })
          .then((response) => response.json().catch(() => null).then((payload) => ({ response, payload })))
          .then(({ response, payload }) => {
            if (!response.ok) throw new Error((payload && payload.error) || ("HTTP " + response.status));
            if (payload && payload.list) setState({ status: "ready", data: payload.list, error: "" });
            if (payload && payload.persisted === false) setNote(t("models.readOnly"));
          })
          .catch((error) => { setNote(t("models.failed") + String((error && error.message) || error)); })
          .then(() => { setBusy(""); });
      }, [t]);

      const children = [];
      children.push(jsxs("div", {
        key: "head",
        style: listHeadStyle,
        children: [
          jsx("div", { key: "title", style: listTitleStyle, children: t("models.title") }),
          jsxs("div", {
            key: "actions",
            style: { display: "flex", gap: "8px", flex: "0 0 auto" },
            children: [
              jsx("button", {
                key: "reload",
                type: "button",
                style: smallButtonStyle,
                disabled: state.status === "loading",
                onClick: () => { void load(); },
                children: t("models.reload")
              }),
              jsx("button", {
                key: "expand",
                type: "button",
                style: smallButtonStyle,
                disabled: !open,
                onClick: () => foldAll(false),
                children: t("models.expandAll")
              }),
              jsx("button", {
                key: "collapse",
                type: "button",
                style: smallButtonStyle,
                disabled: !open,
                onClick: () => foldAll(true),
                children: t("models.collapseAll")
              }),
              jsx("button", {
                key: "toggle",
                type: "button",
                style: smallButtonStyle,
                onClick: () => { setOpen(!open); },
                children: open ? t("models.hide") : t("models.show")
              })
            ]
          })
        ]
      }));
      // The box. Kept outside the settings form for the same reason the roster is:
      // it is a view control over a live roster, not a value the page stages and
      // saves, and typing in it must never look like an unsaved edit.
      children.push(jsxs("div", {
        key: "search",
        style: { display: "flex", alignItems: "center", gap: "8px", margin: "10px 0 6px" },
        children: [
          jsx("input", {
            key: "box",
            type: "search",
            value: query,
            placeholder: t("models.search"),
            "aria-label": t("models.search"),
            onChange: (event) => setQuery(event && event.target ? event.target.value : ""),
            style: searchInputStyle
          }),
          searching
            ? jsx("button", {
                key: "clear",
                type: "button",
                style: smallButtonStyle,
                onClick: () => setQuery(""),
                children: t("models.searchClear")
              })
            : null
        ].filter((child) => child !== null)
      }));
      if (searching) {
        children.push(jsx("div", {
          key: "hits",
          style: { fontSize: "12px", opacity: 0.75, marginBottom: "6px" },
          children: matchedCount() === 0
            ? t("models.searchNone")
            : fill(t("models.searchHits"), {
                n: matchedCount(),
                total: state.data === null || state.data === undefined ? 0 : state.data.total
              })
        }));
      } else {
        children.push(jsx("div", { key: "hint", style: listHintStyle, children: t("models.hint") }));
      }

      /**
       * Health tally for one channel or one section, counted from its own rows.
       *
       * The host also sends counters, but deriving them here means the two fold
       * levels never depend on a field a running host may not have yet: the rows
       * are the contract, and a stale bundle then renders correctly instead of
       * printing a placeholder.
       */
      const tallyOf = (channels) => {
        let ok = 0;
        let resting = 0;
        let off = 0;
        let total = 0;
        for (const channel of channels) {
          for (const row of channel.models) {
            total += 1;
            if (row.health === "ok") ok += 1;
            else if (row.health === "off") off += 1;
            else resting += 1;
          }
        }
        return { total: total, ok: ok, resting: resting, off: off };
      };

      /**
       * The rows a channel would render under the current query, and the two
       * counters the folded line needs so a collapsed channel never hides whether
       * the match is inside it.
       */
      const visibleModels = (channel) => channel.models.filter(matches);


      /** One collapsible line: chevron, name, counts. */
      const disclosure = (key, label, meta, hint) => jsxs("button", {
        key: key + "#head",
        type: "button",
        style: disclosureStyle,
        onClick: () => flip(key),
        children: [
          jsx("span", { key: "chev", style: chevronStyle, children: folded[key] ? "\u25B6" : "\u25BC" }),
          jsx("span", { key: "name", style: groupNameStyle, children: label }),
          jsx("span", { key: "meta", style: groupMetaStyle, children: meta })
        ]
      });

      /** One model row. */
      const modelRow = (row) => {
        const meta = [];
        if (row.health === "off") meta.push(t("models.reason." + row.reason));
        else if (row.health === "unknown") meta.push(t("models.never"));
        else if (row.rest > 0) meta.push(fill(t("models.rest"), { m: row.rest }));
        else meta.push("TTFT " + (row.ttftMs === null ? "-" : row.ttftMs + "ms") + " · " + row.successes + "/" + row.attempts);
        if (row.lastErrorKind !== "") meta.push(row.lastErrorKind);
        return jsxs("div", {
          key: row.key,
          style: modelRowStyle,
          children: [
            jsx("span", { key: "dot", style: dotStyle(row.health) }),
            jsx("span", { key: "name", style: modelNameStyle, children: row.model }),
            jsx("span", { key: "badge", style: badgeStyle(row.health), children: t("models.health." + row.health) }),
            jsx("span", { key: "meta", style: modelMetaStyle, children: meta.filter((part) => part !== "").join(" · ") }),
            row.switchable
              ? jsx("button", {
                  key: "switch",
                  type: "button",
                  style: smallButtonStyle,
                  disabled: busy === row.key,
                  onClick: () => toggle(row, row.health === "off"),
                  children: row.health === "off" ? t("models.enable") : t("models.disable")
                })
              : null
          ].filter((child) => child !== null)
        });
      };

      const data = open ? state.data : null;
      /**
       * The two sections, from `groups` when the host sends it and rebuilt from
       * `channels` when it does not.
       *
       * The fallback exists because the host half and this bundle are versioned
       * together but not *loaded* together: a stale host would otherwise leave the
       * roster blank after a client-only update. The classification is the same
       * rule the host applies (a "kind" of vision, or a -vision provider), so both
       * paths produce the same two sections.
       */
      const sections = (() => {
        if (data === null) return null;
        if (Array.isArray(data.groups)) return data.groups;
        if (!Array.isArray(data.channels)) return null;
        const kindOf = (channel) => channel.kind !== undefined
          ? channel.kind
          : (/[-_.]vision$/i.test(String(channel.provider)) ? "vision" : "chat");
        return ["chat", "vision"].map((key) => {
          const channels = data.channels.filter((channel) => kindOf(channel) === key);
          return {
            key: key,
            channels: channels,
            models: channels.reduce((sum, channel) => sum + channel.models.length, 0)
          };
        }).filter((group) => group.channels.length > 0);
      })();
      if (sections !== null && sections.length > 0) {
        const disabled = data.models.filter((row) => row.health === "off").length;
        children.push(jsx("div", {
          key: "summary",
          style: { fontSize: "12px", opacity: 0.75 },
          children: fill(t("models.summary"), { total: data.total, rotating: data.inRotation, disabled: disabled })
        }));
        for (const group of sections) {
          // Recorded for the expand/collapse-all buttons: they must cover exactly
          // the rows this render produced, whatever shape the payload had.
          for (const channel of group.channels) channelIds.push(group.key + "/" + channel.provider);
          // A query narrows the section to the channels that still have a match,
          // and counts the matches rather than every row the channel owns - a
          // folded line that reported the unfiltered tally would contradict the
          // rows below it.
          const matched = group.channels.filter((channel) => visibleModels(channel).length > 0);
          if (matched.length === 0) continue;
          // Searching should reveal, not hide: a hit inside a folded channel would
          // otherwise be invisible, which is exactly what the box was opened to fix.
          const shown = searching || folded[group.key] !== true;
          children.push(disclosure(
            group.key,
            t("models.group." + group.key),
            fill(t("models.counts"), Object.assign({ n: tallyOf(matched).total }, tallyOf(matched)))
          ));
          if (!shown) continue;
          children.push(jsx("div", { key: group.key + "#hint", style: groupHintStyle, children: t("models.groupHint." + group.key) }));
          const wrap = [];
          for (const channel of matched) {
            const channelKey = group.key + "/" + channel.provider;
            const channelOpen = searching || folded[channelKey] !== true;
            // The tally is the point of a folded line: "18 models, all usable" or
            // "18 models, 2 cooling" answers the question the fold is hiding, so
            // collapsing never costs the reader the state.
            const tally = fill(t("models.counts"), Object.assign({ n: visibleModels(channel).length }, tallyOf([channel])));
            // The channel's own switch. Its label follows the channel rather than
            // the individual rows, so a half-closed channel still offers the one
            // action that finishes the job: close the rest.
            // The channel header's button is decided by the channel's own switch, not
            // by whether some row happens to be in rotation. The two are different
            // questions: a channel whose rows are all off for per-row reasons is still
            // an *open* channel, and a channel that was closed must offer the action
            // that reopens it. The fallback keeps a host that does not publish
            // switchedOff on the older, row-derived reading.
            const closed = channel.switchedOff === true
              || (channel.switchedOff === undefined && !channel.models.some((row) => row.inRotation));
            const head = jsxs("div", {
              key: channelKey + "#row",
              style: channelHeadRowStyle,
              children: [
                jsxs("button", {
                  key: channelKey + "#head",
                  type: "button",
                  style: channelHeadButtonStyle,
                  onClick: () => flip(channelKey),
                  children: [
                    jsx("span", { key: "chev", style: chevronStyle, children: channelOpen ? "\u25BC" : "\u25B6" }),
                    jsx("span", {
                      key: "n",
                      style: channelNameStyle,
                      children: channel.displayName !== undefined && channel.displayName !== "" && channel.displayName !== channel.channel
                        ? channel.displayName + " (" + channel.channel + ")"
                        : channel.channel
                    }),
                    // A twin is named after the channel it wraps; saying which one
                    // is what makes "amd-vision" legible as "the image arm of amd".
                    channel.kind === "vision" && channel.sourceChannel !== ""
                      ? jsx("span", { key: "src", style: groupMetaStyle, children: "\u2192 " + channel.sourceChannel })
                      : null,
                    jsx("span", {
                      key: "tally",
                      style: channel.ok === 0 && channel.models.length > 0 ? channelTallyStyleDim : channelTallyStyle,
                      children: tally
                    })
                  ].filter((child) => child !== null)
                }),
                // No channel switch on a vision channel: its rows are all kept out by
                // the twin rule, which the channel flag cannot lift, so the button would
                // write an entry that changes nothing while reading like a promise. The
                // per-row switches below still put an individual twin back.
                channel.kind === "vision" ? null : jsx("button", {
                  key: channelKey + "#switch",
                  type: "button",
                  style: channelButtonStyle,
                  disabled: busy === channel.provider,
                  // scope: "provider" - a channel row is keyed by its provider, not
                  // by a "provider/model" key, so the two scopes cannot be swapped.
                  onClick: () => toggle(channel, closed, "provider"),
                  children: closed ? t("models.enableChannel") : t("models.disableChannel")
                })
              ]
            });
            const rows = [head];
            if (channelOpen) {
              for (const row of visibleModels(channel)) rows.push(modelRow(row));
            }
            wrap.push(jsx("div", { key: channelKey, style: channelStyle, children: rows }));
          }
          children.push(jsx("div", { key: group.key + "#rows", style: channelWrapStyle, children: wrap }));
        }
      } else if (!open) {
        // Collapsed: the header and the counter stay, the rows do not.
        children.push(jsx("div", { key: "collapsed", style: { fontSize: "12px", opacity: 0.7 }, children: t("models.hint") }));
      } else if (state.status === "loading") {
        children.push(jsx("div", { key: "loading", style: { fontSize: "12px", opacity: 0.7 }, children: t("models.loading") }));
      } else if (state.status === "failed") {
        children.push(jsx("div", { key: "failed", style: { fontSize: "12px", color: HEALTH_COLOR.error }, children: t("models.failed") + state.error }));
      } else {
        children.push(jsx("div", { key: "empty", style: { fontSize: "12px", opacity: 0.7 }, children: t("models.empty") }));
      }
      if (note !== "") {
        children.push(jsx("div", { key: "note", style: { fontSize: "12px", opacity: 0.8, marginTop: "8px" }, children: note }));
      }
      return jsx("div", { key: "models", "data-model-list": true, style: listStyle, children: children });
    }
    //#endregion

    //#region lib/types/client/ModelRotatorCard.js
    /**
     * Render the rotator's one-liner or its settings form, as the Plugins page asks.
     */
    function ModelRotatorCard(props) {
      const t = props.t;
      const state = props.useModelRotatorCard((snapshot) => snapshot);
      if (props.view === "summary") return t("description");
      const children = FIELDS.map((spec) => {
        const fieldState = state[spec.field] === undefined ? {} : state[spec.field];
        if (spec.kind === "number") {
          return jsx(P.SettingsValueField, {
            key: spec.field,
            id: "plugin-config-model-rotator-" + spec.field,
            label: t(spec.label),
            hint: t(spec.hint),
            overriddenLabel: t("overridden"),
            resetLabel: t("reset"),
            invalidLabel: t("invalidNumber"),
            numeric: true,
            disabled: !state.writable,
            text: fieldState.text,
            overridden: fieldState.overridden,
            invalid: fieldState.invalid,
            onEdit: (text) => props.edit(spec.field, text),
            onReset: () => props.resetField(spec.field)
          });
        }
        return jsx(BoolField, {
          key: spec.field,
          t: t,
          state: state,
          spec: spec,
          onEdit: (text) => props.edit(spec.field, text),
          onReset: () => props.resetField(spec.field)
        });
      });
      children.push(jsx("p", {
        key: "__note",
        style: { margin: "12px 0 0", fontSize: "12px", opacity: 0.6 },
        children: t("note")
      }));
      // The roster lives inside the same frame but outside the staged form: its
      // rows are saved one at a time, straight to config.json, so a refresh there
      // cannot discard a half-typed number in the settings above it.
      children.push(jsx(ModelList, { key: "__models", t: t }));
      return jsx(P.SettingsForm, {
        labels: formLabels(t),
        state: state,
        onSave: props.save,
        onDiscard: props.discard,
        children: children
      });
    }
    //#endregion

    //#region lib/types/client/model-rotator-card-controller.js
    /** Namespace of the rotator's user-owned settings (the plugin's cordis id). */
    const MODEL_ROTATOR_NS = "model-rotator";

    /** Bridges the "model-rotator" settings scope onto the page's staged form. */
    const ModelRotatorCardController = class {
      constructor(scope) {
        this.form = new P.SettingsFormModel(scope, [
          P.settingsNumberField("maxCandidates"),
          P.settingsNumberField("confirmTimeoutMs"),
          P.settingsNumberField("retriesPerModel"),
          P.settingsNumberField("retryBackoffMs"),
          P.settingsNumberField("cooldownBaseMs"),
          P.settingsNumberField("maxCooldownMs"),
          P.settingsNumberField("quotaCooldownMs"),
          P.settingsNumberField("quotaCooldownHour"),
          P.settingsNumberField("statsPersistTtlMs"),
          { field: "enabled", format: formatBoolean, parse: parseBoolean },
          { field: "confirmSwitch", format: formatBoolean, parse: parseBoolean },
          { field: "preferSameModel", format: formatBoolean, parse: parseBoolean },
          { field: "noticeSwitch", format: formatBoolean, parse: parseBoolean },
          { field: "adoptSwitchedModel", format: formatBoolean, parse: parseBoolean },
          { field: "allowImageFailover", format: formatBoolean, parse: parseBoolean }
        ]);
        this.store = this.form.bind(() => this.projection());
      }
      projection() {
        const snapshot = Object.assign({}, this.form.shell());
        for (const spec of FIELDS) snapshot[spec.field] = this.form.field(spec.field);
        return snapshot;
      }
      /** The face the page's slot registration injects. */
      inject() {
        return Object.assign({ hooks: { modelRotatorCard: this.store } }, this.form.actions());
      }
      dispose() {
        this.form.dispose();
      }
    };

    /** Stage a boolean as the same text the other fields use; blank clears. */
    function formatBoolean(value) {
      if (value === true) return "true";
      if (value === false) return "false";
      return "";
    }

    /** Read a staged boolean; blank means "follow the default". */
    function parseBoolean(text) {
      const trimmed = String(text).trim().toLowerCase();
      if (trimmed === "") return { kind: "clear" };
      if (trimmed === "true" || trimmed === "on" || trimmed === "1" || trimmed === "yes") return { kind: "set", value: true };
      if (trimmed === "false" || trimmed === "off" || trimmed === "0" || trimmed === "no") return { kind: "set", value: false };
      return undefined;
    }
    //#endregion

    //#region lib/types/client/index.js
    /** Dictionary namespace owned by this plugin. */
    const NS = "settings.modelRotator";
    /** Required services (cordis fiber inject). */
    const inject = ["slots", "locale", "configForms"];

    /**
     * Mount the rotator's settings form while the Host serves its namespace.
     *
     * Two host containers publish a slot this form can occupy, and registering
     * both is what makes it reachable:
     *   - settings.section is the Settings shell's own navigation list, one
     *     entry per settings page: this is what puts the form in 设置 beside
     *     General / Models / Plugins. The shell hands it {close} and filters by
     *     the registration id.
     *   - plugins.item is the Plugins panel card list - a sidebar panel, not a
     *     settings page - and it renders the same form as its card body.
     * Either consumer renders the whole form, so both get the same component.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "model-rotator: dictionaries");
      const card = new ModelRotatorCardController(ctx.configForms.get(MODEL_ROTATOR_NS));
      ctx.effect(() => () => { card.dispose(); }, "model-rotator: form subscription");
      /** One definition shape, reused so the two cells cannot drift apart. */
      const definition = (name, order) => ({
        name: name,
        id: "model-rotator",
        order: order,
        label: () => t("title"),
        locale: NS,
        inject: () => card.inject()
      });
      // Register unconditionally. `configForms.whileServed` is for a page whose edits a
      // namespace ANOTHER plugin owns: it keeps that page hidden while the owner was never
      // composed. This page edits OUR OWN namespace, so gating it silently hid the entry
      // on deployments where the Host had not served the namespace - the gate fails with
      // no error and zero cells registered, leaving an empty settings nav slot.
      // The Host's own SettingsForm already renders an "unavailable" line when no form is
      // served, so the unconditional registration degrades gracefully instead of vanishing.
      ctx.slots.inject("settings.section", () => ctx.slots.register(definition("settings.section", 20), ModelRotatorCard));
      ctx.slots.inject("plugins.item", () => ctx.slots.register(definition("plugins.item", 45), ModelRotatorCard));
    }
    //#endregion

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
