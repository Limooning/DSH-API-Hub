window.__ModuleLoader__.load({
	id: "dsh-api-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useCallback } = React;
		/** Services this plugin uses; `slots` is where the overlay registers. */
		const inject = ["slots"];

		// ---------------------------------------------------------------- base
		// Where the panel service lives, in preference order: the origin the host
		// injected (Electron loads the client from a non-http origin), the page
		// origin for http(s) pages, then a relative path.
		const injected = typeof window !== "undefined" && window.__API_HUB_ORIGIN__
			? String(window.__API_HUB_ORIGIN__).replace(/\/+$/, "")
			: "";
		const httpOrigin = location.protocol === "http:" || location.protocol === "https:";
		const CANDIDATES = [];
		if (injected) CANDIDATES.push(injected + "/api-hub");
		if (httpOrigin) CANDIDATES.push(location.origin + "/api-hub");
		CANDIDATES.push("/api-hub");

		async function probeHealth(base) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 1500);
				const response = await fetch(base + "/api/health", { signal: controller.signal });
				clearTimeout(timer);
				return response.ok;
			} catch {
				return false;
			}
		}

		async function resolvePanelBase() {
			for (const base of CANDIDATES) {
				if (await probeHealth(base)) return base;
			}
			return "";
		}

		async function call(base, path, body) {
			const response = await fetch(base + path, body === undefined
				? {}
				: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			return response.json();
		}

		// --------------------------------------------------------------- styles
		const MONO = "ui-monospace, Consolas, monospace";
		const S = {
			fab: {
				position: "fixed", right: "22px", bottom: "22px", zIndex: 60,
				height: "38px", padding: "0 14px", borderRadius: "999px",
				border: "1px solid #324055", background: "#1b2130", color: "#dce4f2",
				font: "600 13px/38px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
				cursor: "pointer", boxShadow: "0 6px 24px rgba(0,0,0,.45)",
			},
			backdrop: { position: "fixed", inset: 0, zIndex: 59, background: "rgba(6,8,12,.55)" },
			modal: {
				position: "fixed", zIndex: 61, top: "5vh", left: "50%", transform: "translateX(-50%)",
				width: "min(1180px, 92vw)", height: "86vh", borderRadius: "12px",
				border: "1px solid #2b3344", background: "#0f1115", overflow: "hidden",
				boxShadow: "0 24px 80px rgba(0,0,0,.6)", display: "flex", flexDirection: "column",
				color: "#e7eaf1", font: "13px/1.5 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
			},
			bar: {
				display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px",
				borderBottom: "1px solid #232a36", color: "#8b93a7", fontSize: "12px", flexWrap: "wrap",
			},
			btn: {
				background: "#1d212a", color: "#e7eaf1", border: "1px solid #262b36",
				borderRadius: "8px", padding: "4px 10px", cursor: "pointer", fontSize: "12px",
			},
			btnPrimary: {
				background: "rgba(79,140,255,.14)", color: "#bcd2ff",
				border: "1px solid rgba(79,140,255,.45)", borderRadius: "8px",
				padding: "4px 10px", cursor: "pointer", fontSize: "12px",
			},
			tab: (active) => ({
				background: active ? "#2a3242" : "transparent", border: "none",
				color: active ? "#e7eaf1" : "#8b93a7", padding: "4px 12px",
				borderRadius: "7px", cursor: "pointer", fontSize: "12.5px",
			}),
			body: { flex: 1, overflow: "auto", padding: "18px 22px" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: "14px" },
			card: (off) => ({
				background: "#171a21", border: "1px solid #262b36", borderRadius: "12px",
				padding: "14px 15px", display: "flex", flexDirection: "column", gap: "8px",
				opacity: off ? 0.55 : 1,
			}),
			row: { display: "flex", alignItems: "center", gap: "8px" },
			name: {
				fontSize: "14.5px", fontWeight: 650, minWidth: 0,
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			tag: {
				fontSize: "11px", padding: "1px 7px", borderRadius: "6px",
				background: "#1d212a", border: "1px solid #262b36", color: "#8b93a7",
				whiteSpace: "nowrap", flexShrink: 0, lineHeight: "16px",
			},
			metaRow: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
			url: {
				fontFamily: MONO, fontSize: "11.5px", color: "#8f99ac",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			buttonGrid: (columns) => ({
				display: "grid", gridTemplateColumns: "repeat(" + columns + ", minmax(0, 1fr))", gap: "8px",
			}),
			dot: (on) => ({
				width: "8px", height: "8px", borderRadius: "50%",
				background: on ? "#35c46b" : "#3a4150",
				boxShadow: on ? "0 0 0 3px rgba(53,196,107,.15)" : "none",
			}),
			mono: { fontFamily: MONO, fontSize: "11.5px", color: "#a9b3c9" },
			line: {
				display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px",
				background: "#1d212a", border: "1px solid #262b36", borderRadius: "8px",
				fontFamily: MONO, fontSize: "11.5px", color: "#c6cede",
			},
			bal: (ok) => ({
				fontFamily: MONO, fontSize: "11.5px",
				padding: "1px 7px", borderRadius: "6px", whiteSpace: "nowrap",
				border: ok ? "1px solid rgba(53,196,107,.35)" : "1px solid #262b36",
				background: ok ? "rgba(53,196,107,.12)" : "none",
				color: ok ? "#7fd8a0" : "#5c6474",
			}),
			hint: { fontSize: "11.5px", color: "#6f7787" },
		};

		const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
		const symbol = (currency) => (currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency ? currency + " " : "");

		// Buttons share one class so hover/press feedback comes from CSS instead of
		// inline styles (inline styles cannot express :hover / :active).
		const UI_CSS = [
			".ahb { transition: transform .06s ease, filter .12s ease, box-shadow .12s ease; }",
			".ahb:hover:not(:disabled) { filter: brightness(1.14); }",
			".ahb:active:not(:disabled) { transform: translateY(1px) scale(.985); box-shadow: inset 0 2px 6px rgba(0,0,0,.45); }",
			".ahb:disabled { opacity: .42; cursor: default; }",
		].join("\n");

		function ensureUiStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById("api-hub-ui-style")) return;
			const el = document.createElement("style");
			el.id = "api-hub-ui-style";
			el.textContent = UI_CSS;
			document.head.appendChild(el);
		}
		ensureUiStyles();

		// ----------------------------------------------------------- components
		function Switch({ on, onChange, title }) {
			return h("label", { title, style: { position: "relative", width: "34px", height: "19px", cursor: "pointer", flex: "none" } },
				h("input", {
					type: "checkbox", checked: on, onChange: (e) => onChange(e.target.checked),
					style: { opacity: 0, width: 0, height: 0 },
				}),
				h("span", {
					style: {
						position: "absolute", inset: 0, borderRadius: "999px",
						background: on ? "rgba(53,196,107,.28)" : "#2b3140", transition: "background .15s",
					},
				}),
				h("span", {
					style: {
						position: "absolute", width: "13px", height: "13px", left: "3px", top: "3px",
						borderRadius: "50%", background: on ? "#35c46b" : "#8b93a7",
						transform: on ? "translateX(15px)" : "none", transition: "transform .15s, background .15s",
					},
				}));
		}

		function ProviderCard({ provider, balances, onTest, onToggle, onDefault, onBalance, onModels, onKey, onRequest, onRemove, drag }) {
			const p = provider;
			const dragging = drag && drag.draggingId === p.id;
			const edge = drag && drag.overId === p.id ? drag.edge : null;
			const balance = balances[p.id];
			const balanceLabel = balance === undefined
				? null
				: balance === null
					? "…"
					: balance.ok
						? symbol(balance.currency) + Number(balance.amount).toFixed(2)
						: "—";
			return h("div", {
				style: {
					...S.card(false),
					...(p.enabled ? null : { borderColor: "#232833" }),
					...(dragging ? { opacity: 0.35 } : null),
					...(edge === "before" ? { boxShadow: "inset 0 2px 0 #4f8cff" } : null),
					...(edge === "after" ? { boxShadow: "inset 0 -2px 0 #4f8cff" } : null),
				},
				draggable: Boolean(drag),
				onDragStart: drag ? (e) => {
					try {
						e.dataTransfer.effectAllowed = "move";
						e.dataTransfer.setData("text/plain", p.id);
					} catch { /* older engines */ }
					drag.onStart(p.id);
				} : undefined,
				onDragEnd: drag ? () => drag.onEnd() : undefined,
				onDragOver: drag ? (e) => {
					e.preventDefault();
					const rect = e.currentTarget.getBoundingClientRect();
					drag.onOver(p.id, e.clientY > rect.top + rect.height / 2 ? "after" : "before");
				} : undefined,
				onDrop: drag ? (e) => {
					e.preventDefault();
					drag.onDrop(p.id);
				} : undefined,
			},
				h("div", { style: { ...S.row, justifyContent: "space-between", gap: "10px" } },
					h("span", { style: S.name, title: p.name }, p.name),
					h("div", { style: { ...S.row, gap: "10px", flexShrink: 0 } },
						h("span", { style: S.dot(p.keyPresent) }),
						h(Switch, { on: p.enabled, title: p.enabled ? "已启用" : "已停用", onChange: (v) => onToggle(p, v) }))),
				h("div", { style: S.metaRow },
					h("span", { style: S.tag }, p.tag || p.kind),
					p.isDefault ? h("span", { style: { ...S.tag, color: "#bcd2ff", borderColor: "rgba(79,140,255,.45)" } }, "默认") : null,
					balanceLabel ? h("span", { style: S.bal(Boolean(balance && balance.ok)) }, balanceLabel) : null),
				// Only the body dims when the provider is off, so the switch and the
				// name stay readable and the toggle stays the obvious action.
				h("div", {
					style: {
						display: "flex", flexDirection: "column", gap: "8px",
						opacity: p.enabled ? 1 : 0.45,
						transition: "opacity .15s ease",
					},
				},
					h("div", { style: S.url, title: p.baseURL }, p.baseURL),
					h("div", { style: S.line },
						h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
							p.keyPresent ? p.keyMasked : "未配置 Key")),
					h("div", { style: { display: "flex", gap: "6px", minWidth: 0, alignItems: "baseline" } },
						h("span", { style: { ...S.hint, flexShrink: 0 } }, "默认模型"),
						h("span", {
							style: {
								...S.mono, minWidth: 0, color: "#c6cede",
								overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
							},
						}, p.defaultModel || "未设置")),
					h("div", { style: S.buttonGrid(4) },
						h("button", { className: "ahb", style: S.btn, disabled: !p.keyPresent || !p.enabled, onClick: () => onTest(p) }, "测试"),
						h("button", { className: "ahb", style: S.btn, disabled: !p.enabled, onClick: () => onBalance(p) }, "查余额"),
						h("button", { className: "ahb", style: S.btn, disabled: !p.enabled, onClick: () => onModels(p) }, "模型"),
						h("button", { className: "ahb", style: S.btn, disabled: !p.enabled, onClick: () => onRequest(p) }, "请求")),
					h("div", { style: S.buttonGrid(3) },
						h("button", { className: "ahb", style: S.btn, onClick: () => onKey(p) }, "改 Key"),
						h("button", {
							className: "ahb",
							style: p.isDefault ? { ...S.btnPrimary, opacity: 1 } : S.btn,
							disabled: !p.enabled,
							onClick: () => onDefault(p),
						}, "默认"),
						h("button", {
							className: "ahb",
							style: { ...S.btn, borderColor: "rgba(242,85,90,.4)", color: "#ffb3b5" },
							onClick: () => onRemove(p),
						}, "移除"))));
		}

		function SkillRow({ skill, onToggle, onView, onRemove }) {
			return h("div", { style: { ...S.card(!skill.enabled), padding: "10px 12px" } },
				h("div", { style: { ...S.row, justifyContent: "space-between" } },
					h("div", { style: S.row },
						h("span", { style: { ...S.name, fontSize: "13.5px" } }, skill.name),
						!skill.enabled ? h("span", { style: S.tag }, "已停用") : null),
					h(Switch, { on: skill.enabled, onChange: (v) => onToggle(skill, v) })),
				h("div", { style: { ...S.hint, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } },
					skill.description || "（无描述）"),
				h("div", { style: S.hint }, skill.files + " 个文件 · " + fmtBytes(skill.bytes)),
				h("div", { style: { display: "flex", gap: "8px" } },
					h("button", { className: "ahb", style: S.btn, onClick: () => onView(skill) }, "查看"),
					h("button", { className: "ahb", style: S.btn, onClick: () => onRemove(skill) }, "删除")));
		}

		// ------------------------------------------------------------- dialogs
		const DIALOG = {
			backdrop: { position: "fixed", inset: 0, zIndex: 70, background: "rgba(6,8,12,.62)" },
			panel: {
				position: "fixed", zIndex: 71, top: "12vh", left: "50%", transform: "translateX(-50%)",
				width: "min(640px, 92vw)", maxHeight: "70vh", display: "flex", flexDirection: "column",
				background: "#171a21", border: "1px solid #2b3344", borderRadius: "12px",
				boxShadow: "0 24px 80px rgba(0,0,0,.6)", color: "#e7eaf1",
				font: "13px/1.5 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
			},
			head: {
				display: "flex", alignItems: "center", gap: "8px", padding: "12px 14px",
				borderBottom: "1px solid #262b36", fontSize: "13.5px", fontWeight: 600,
			},
			body: { padding: "12px 14px", overflow: "auto", flex: 1 },
			foot: {
				display: "flex", justifyContent: "flex-end", gap: "8px",
				padding: "10px 14px", borderTop: "1px solid #262b36",
			},
			row: (on) => ({
				display: "flex", alignItems: "center", gap: "10px", padding: "6px 8px",
				borderRadius: "8px", background: on ? "rgba(79,140,255,.08)" : "transparent",
				cursor: "pointer",
			}),
			id: { fontFamily: MONO, fontSize: "12px", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			input: {
				width: "100%", boxSizing: "border-box", background: "#10131a", color: "#e7eaf1",
				border: "1px solid #2b3344", borderRadius: "8px", padding: "8px 10px",
				font: "12.5px/1.4 " + MONO,
			},
		};

		function Dialog({ title, children, footer, onClose }) {
			return h(React.Fragment, null,
				h("div", { style: DIALOG.backdrop, onClick: onClose }),
				h("div", { style: DIALOG.panel },
					h("div", { style: DIALOG.head }, title, h("span", { style: { flex: 1 } }),
						h("button", { className: "ahb", style: S.btn, onClick: onClose }, "关闭")),
					h("div", { style: DIALOG.body }, children),
					footer ? h("div", { style: DIALOG.foot }, footer) : null));
		}

		function ModelDialog({ provider, base, onClose, onSaved, onNotice }) {
			const [models, setModels] = useState(null);
			const [picked, setPicked] = useState(null);
			const [def, setDef] = useState(provider.defaultModel || "");
			const [error, setError] = useState("");
			const [loading, setLoading] = useState(false);

			const load = useCallback(async (refresh) => {
				setLoading(true);
				setError("");
				try {
					const result = await call(base, "/api/models?id=" + encodeURIComponent(provider.id) + (refresh ? "&refresh=1" : ""));
					const list = (result.list || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), "en", { numeric: true }));
					setModels(list);
					const allowed = provider.selectedModels;
					setPicked(new Set(allowed ? allowed.filter((id) => list.some((m) => m.id === id)) : list.map((m) => m.id)));
					if (result.error) setError(String(result.error));
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
					setModels([]);
				} finally {
					setLoading(false);
				}
			}, [base, provider]);

			useEffect(() => { load(false); }, [load]);

			const toggle = (id) => {
				setPicked((current) => {
					const next = new Set(current);
					if (next.has(id)) {
						next.delete(id);
						if (def === id) setDef("");
					} else next.add(id);
					return next;
				});
			};
			const chooseDefault = (id) => {
				setPicked((current) => new Set(current).add(id));
				setDef(id);
			};

			const save = async () => {
				const selected = [...(picked || [])];
				if (selected.length && !def) { setError("请选一个默认模型"); return; }
				const result = await call(base, "/api/models", { id: provider.id, selected, defaultModel: def });
				if (result && result.error) { setError(String(result.error)); return; }
				onNotice(provider.name + "：已保存 " + selected.length + " 个模型");
				onSaved(result);
				onClose();
			};

			const body = models === null
				? h("div", { style: S.hint }, loading ? "加载中…" : "没有模型")
				: models.length === 0
					? h("div", { style: S.hint }, "没有拿到模型列表")
					: models.map((m) => h("div", { key: m.id, style: DIALOG.row((picked || new Set()).has(m.id)) },
						h("input", {
							type: "checkbox", checked: (picked || new Set()).has(m.id),
							onChange: () => toggle(m.id),
							style: { accentColor: "#4f8cff", width: "15px", height: "15px", cursor: "pointer" },
						}),
						h("span", { style: DIALOG.id, onClick: () => toggle(m.id) }, m.id),
						h("span", { style: S.hint }, m.contextWindow ? "ctx " + m.contextWindow : ""),
						h("label", { style: { ...S.hint, display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" } },
							h("input", {
								type: "radio", name: "api-hub-def", checked: def === m.id,
								onChange: () => chooseDefault(m.id),
								style: { accentColor: "#4f8cff", cursor: "pointer" },
							}),
							"默认")));

			return h(Dialog, {
				title: "选择模型 · " + provider.name,
				onClose,
				footer: h(React.Fragment, null,
					h("button", { className: "ahb", style: S.btn, onClick: () => load(true) }, "重新拉取"),
					h("button", { className: "ahb", style: S.btn, onClick: () => setPicked(new Set((models || []).map((m) => m.id))) }, "全选"),
					h("button", { className: "ahb", style: S.btn, onClick: () => { setPicked(new Set()); setDef(""); } }, "清空"),
					h("button", { className: "ahb", style: S.btnPrimary, onClick: save }, "保存")),
			},
				error ? h("div", { style: { ...S.hint, color: "#ff8f93", marginBottom: "8px" } }, error) : null,
				body);
		}

		function KeyDialog({ provider, base, onClose, onSaved, onNotice }) {
			const [value, setValue] = useState("");
			const [error, setError] = useState("");
			const save = async () => {
				const key = value.trim();
				if (!key) { setError("Key 不能为空"); return; }
				const result = await call(base, "/api/key", { id: provider.id, key });
				if (result && result.error) { setError(String(result.error)); return; }
				onNotice(provider.name + " 密钥已更新");
				onSaved(result);
				onClose();
			};
			return h(Dialog, {
				title: "修改密钥 · " + provider.name,
				onClose,
				footer: h(React.Fragment, null,
					h("button", { className: "ahb", style: S.btn, onClick: onClose }, "取消"),
					h("button", { className: "ahb", style: S.btnPrimary, onClick: save }, "保存")),
			},
				h("div", { style: { ...S.hint, marginBottom: "8px" } }, "写入位置：" + provider.keySource),
				h("input", {
					type: "password", value, placeholder: "sk-...", autoComplete: "new-password",
					onChange: (e) => setValue(e.target.value), style: DIALOG.input,
				}),
				error ? h("div", { style: { ...S.hint, color: "#ff8f93", marginTop: "8px" } }, error) : null);
		}

		function AddProviderDialog({ base, onClose, onSaved, onNotice }) {
			const [name, setName] = useState("");
			const [kind, setKind] = useState("llm");
			const [baseURL, setBaseURL] = useState("");
			const [key, setKey] = useState("");
			const [models, setModels] = useState(null);
			const [picked, setPicked] = useState(new Set());
			const [def, setDef] = useState("");
			const [testPath, setTestPath] = useState("/models");
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);

			const probe = async () => {
				setError("");
				if (!/^https?:\/\//i.test(baseURL.trim())) { setError("地址要以 http:// 或 https:// 开头"); return; }
				if (!key.trim()) { setError("请先填 Key"); return; }
				setBusy(true);
				try {
					const result = await call(base, "/api/probe", { baseURL: baseURL.trim(), key: key.trim() });
					if (!result.ok) {
						const tried = (result.tried || []).map((t) => t.path + " → " + (t.status || t.error)).join("，");
						setError("没探测到模型列表。试过：" + (tried || "无"));
						setModels(null);
						return;
					}
					const list = (result.models || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), "en", { numeric: true }));
					setModels(list);
					setTestPath(result.path || "/models");
					setPicked(new Set(list.map((m) => m.id)));
					setDef(list[0] ? list[0].id : "");
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setBusy(false);
				}
			};

			const save = async () => {
				if (!models || models.length === 0) { setError("先检索模型"); return; }
				if (!def) { setError("请选一个默认模型"); return; }
				setBusy(true);
				try {
					const result = await call(base, "/api/providers/add", {
						name: name.trim(), baseURL: baseURL.trim(), key: key.trim(), kind,
						models, selected: [...picked], defaultModel: def, testPath,
					});
					if (result && result.error) { setError(String(result.error)); return; }
					onNotice((name.trim() || baseURL.trim()) + " 已添加");
					onSaved(result);
					onClose();
				} finally {
					setBusy(false);
				}
			};

			const field = (label, input) => h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px" } },
				h("span", { style: S.hint }, label), input);

			const list = models === null
				? null
				: models.length === 0
					? h("div", { style: S.hint }, "没有拿到模型列表")
					: models.map((m) => h("div", { key: m.id, style: DIALOG.row(picked.has(m.id)) },
						h("input", {
							type: "checkbox", checked: picked.has(m.id),
							onChange: () => setPicked((cur) => {
								const next = new Set(cur);
								if (next.has(m.id)) { next.delete(m.id); if (def === m.id) setDef(""); } else next.add(m.id);
								return next;
							}),
							style: { accentColor: "#4f8cff", width: "15px", height: "15px", cursor: "pointer" },
						}),
						h("span", { style: DIALOG.id }, m.id),
						h("span", { style: S.hint }, m.contextWindow ? "ctx " + m.contextWindow : ""),
						h("label", { style: { ...S.hint, display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" } },
							h("input", {
								type: "radio", name: "api-hub-add-def", checked: def === m.id,
								onChange: () => { setDef(m.id); setPicked((cur) => new Set(cur).add(m.id)); },
								style: { accentColor: "#4f8cff", cursor: "pointer" },
							}),
							"默认")));

			return h(Dialog, {
				title: "添加接口",
				onClose,
				footer: h(React.Fragment, null,
					h("button", { className: "ahb", style: S.btn, disabled: busy, onClick: probe }, busy ? "处理中…" : models ? "重新检索" : "检索模型"),
					h("button", { className: "ahb", style: S.btnPrimary, disabled: busy || models === null, onClick: save }, "添加")),
			},
				field("名称", h("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "留空则用域名", style: DIALOG.input })),
				h("div", { style: { display: "flex", gap: "8px" } },
					h("div", { style: { flex: 1 } }, field("类型", h("select", {
						value: kind, onChange: (e) => setKind(e.target.value),
						style: { ...DIALOG.input, fontFamily: "inherit" },
					}, h("option", { value: "llm" }, "文本"), h("option", { value: "image" }, "图片")))),
					h("div", { style: { flex: 2 } }, field("Base URL", h("input", {
						value: baseURL, onChange: (e) => setBaseURL(e.target.value), placeholder: "https://api.example.com/v1", style: DIALOG.input,
					})))),
				field("API Key", h("input", {
					type: "password", value: key, onChange: (e) => setKey(e.target.value),
					placeholder: "sk-...", autoComplete: "new-password", style: DIALOG.input,
				})),
				error ? h("div", { style: { ...S.hint, color: "#ff8f93", margin: "6px 0" } }, error) : null,
				list ? h("div", { style: { ...S.hint, margin: "10px 0 4px" } }, "从 " + testPath + " 找到 " + models.length + " 个模型") : null,
				list);
		}

		function RequestDialog({ provider, base, onClose, onNotice }) {
			const [method, setMethod] = useState("GET");
			const [path, setPath] = useState("/models");
			const [body, setBody] = useState("");
			const [result, setResult] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");

			const send = async () => {
				setError("");
				if (body.trim()) {
					try { JSON.parse(body); } catch { setError("请求体不是合法 JSON"); return; }
				}
				setBusy(true);
				try {
					const res = await call(base, "/api/request", {
						id: provider.id, method, path: path.trim() || "/models", body: body.trim() || undefined,
					});
					setResult(res);
					if (res && res.error) setError(String(res.error));
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setBusy(false);
				}
			};

			return h(Dialog, {
				title: "请求 · " + provider.name,
				onClose,
				footer: h(React.Fragment, null,
					h("button", { className: "ahb", style: S.btn, disabled: busy, onClick: send }, busy ? "发送中…" : "发送"),
					h("button", { className: "ahb", style: S.btn, onClick: onClose }, "关闭")),
			},
				h("div", { style: { display: "flex", gap: "8px", marginBottom: "8px" } },
					h("select", { value: method, onChange: (e) => setMethod(e.target.value), style: { ...DIALOG.input, width: "110px", fontFamily: "inherit" } },
						h("option", null, "GET"), h("option", null, "POST")),
					h("input", { value: path, onChange: (e) => setPath(e.target.value), placeholder: "/models", style: DIALOG.input })),
				h("div", { style: { ...S.hint, marginBottom: "4px" } }, "请求体（JSON，GET 可留空）"),
				h("textarea", {
					value: body, onChange: (e) => setBody(e.target.value), rows: 5,
					placeholder: '{"model":"...","input":"hi"}',
					style: { ...DIALOG.input, resize: "vertical", minHeight: "84px" },
				}),
				error ? h("div", { style: { ...S.hint, color: "#ff8f93", marginTop: "6px" } }, error) : null,
				result ? h(React.Fragment, null,
					h("div", { style: { ...S.hint, marginTop: "8px" } },
						"HTTP " + result.status + " · " + result.ms + "ms · " + (result.url || "")),
					h("pre", {
						style: {
							margin: "6px 0 0", padding: "10px", background: "#10131a", border: "1px solid #262b36",
							borderRadius: "8px", maxHeight: "220px", overflow: "auto", whiteSpace: "pre-wrap",
							wordBreak: "break-word", fontFamily: MONO, fontSize: "11.5px", color: "#c6cede",
						},
					}, result.body || result.error || "")) : null);
		}

		function SkillViewDialog({ skill, base, onClose }) {
			const [content, setContent] = useState(null);
			const [error, setError] = useState("");
			useEffect(() => {
				let alive = true;
				call(base, "/api/skills/read?id=" + encodeURIComponent(skill.id) + (skill.enabled ? "" : "&off=1"))
					.then((result) => { if (alive) { if (result.error) setError(String(result.error)); else setContent(result.content || ""); } })
					.catch((e) => { if (alive) setError(String(e && e.message ? e.message : e)); });
				return () => { alive = false; };
			}, [base, skill]);
			return h(Dialog, {
				title: "SKILL.md · " + skill.name,
				onClose,
				footer: h("button", { className: "ahb", style: S.btn, onClick: onClose }, "关闭"),
			},
				error ? h("div", { style: { ...S.hint, color: "#ff8f93" } }, error) : null,
				content === null
					? h("div", { style: S.hint }, "读取中…")
					: h("pre", {
						style: {
							margin: 0, padding: "10px", background: "#10131a", border: "1px solid #262b36",
							borderRadius: "8px", maxHeight: "48vh", overflow: "auto", whiteSpace: "pre-wrap",
							wordBreak: "break-word", fontFamily: MONO, fontSize: "11.5px", color: "#c6cede",
						},
					}, content));
		}

		function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }) {
			return h(Dialog, {
				title,
				onClose: onCancel,
				footer: h(React.Fragment, null,
					h("button", { className: "ahb", style: S.btn, onClick: onCancel }, "取消"),
					h("button", { className: "ahb",
						style: { ...S.btnPrimary, ...(danger ? { background: "rgba(242,85,90,.16)", borderColor: "rgba(242,85,90,.5)", color: "#ffc2c4" } : null) },
						onClick: onConfirm,
					}, confirmLabel || "确认")),
			}, h("div", { style: { fontSize: "13px", lineHeight: 1.7 } }, message));
		}

		function ApiHubPanel({ base, onNotice }) {
			const [tab, setTab] = useState("providers");
			const [state, setState] = useState(null);
			const [skills, setSkills] = useState([]);
			const [balances, setBalances] = useState({});
			const [error, setError] = useState("");
			const [dialog, setDialog] = useState(null);
			const [dragId, setDragId] = useState(null);
			const [overId, setOverId] = useState(null);
			const [edge, setEdge] = useState(null);
			const [skillView, setSkillView] = useState(null);
			const [skillDelete, setSkillDelete] = useState(null);
			const [providerDelete, setProviderDelete] = useState(null);

			const load = useCallback(async () => {
				try {
					setState(await call(base, "/api/state"));
					setError("");
				} catch (e) { setError(String(e && e.message ? e.message : e)); }
			}, [base]);

			const loadSkills = useCallback(async () => {
				try {
					const next = await call(base, "/api/skills");
					setSkills(next.skills || []);
				} catch (e) { setError(String(e && e.message ? e.message : e)); }
			}, [base]);

			useEffect(() => { load(); loadSkills(); }, [load, loadSkills]);

			const providers = state ? state.providers : [];
			const defaults = state ? state.defaults : {};

			const refreshBalance = useCallback(async (p) => {
				setBalances((b) => ({ ...b, [p.id]: null }));
				let result;
				try {
					result = await call(base, "/api/balance?id=" + encodeURIComponent(p.id));
				} catch (e) {
					result = { ok: false, error: String(e) };
				}
				setBalances((b) => ({ ...b, [p.id]: result }));
			}, [base]);

			useEffect(() => {
				for (const p of providers) {
					if (balances[p.id] === undefined) refreshBalance(p);
				}
			}, [providers, balances, refreshBalance]);

			const toggleProvider = useCallback(async (p, enabled) => {
				const next = await call(base, "/api/enabled", { id: p.id, enabled });
				if (next && next.error) return setError(next.error);
				setState(next);
				onNotice(p.name + (enabled ? " 已启用" : " 已停用"));
			}, [base, onNotice]);

			const testProvider = useCallback(async (p) => {
				const result = await call(base, "/api/test", { id: p.id });
				onNotice(result.ok
					? p.name + " · HTTP " + result.status + " · " + result.ms + "ms"
					: p.name + " 测试失败：" + (result.error || result.status));
			}, [base, onNotice]);

			const makeDefault = useCallback(async (p) => {
				const next = await call(base, "/api/default", p.isDefault
					? { kind: p.kind, id: null }
					: { kind: p.kind, id: p.id });
				if (next && next.error) return setError(next.error);
				setState(next);
				onNotice(p.name + (p.isDefault ? " 已取消默认" : " 已设为默认"));
			}, [base, onNotice]);

			const toggleSkill = useCallback(async (skill, enabled) => {
				const next = await call(base, "/api/skills/toggle", { id: skill.id, enabled });
				if (next && next.error) return setError(next.error);
				setSkills(next.skills || []);
				onNotice(skill.name + (enabled ? " 已启用" : " 已停用"));
			}, [base, onNotice]);

			const reorder = useCallback(async (fromId, toId, edge) => {
				const ids = providers.map((p) => p.id).filter((id) => id !== fromId);
				const at = ids.indexOf(toId);
				if (at === -1) return;
				ids.splice(at + (edge === "after" ? 1 : 0), 0, fromId);
				const next = await call(base, "/api/providers/reorder", { order: ids });
				if (next && next.error) return setError(String(next.error));
				setState(next);
				onNotice("顺序已保存");
			}, [base, onNotice, providers]);

			const drag = {
				draggingId: dragId,
				overId,
				edge,
				onStart: (id) => { setDragId(id); setOverId(null); },
				onOver: (id, where) => {
					if (dragId === null || id === dragId) { setOverId(null); return; }
					setOverId(id); setEdge(where);
				},
				onEnd: () => { setDragId(null); setOverId(null); setEdge(null); },
				onDrop: (id) => {
					const from = dragId;
					const where = edge;
					setDragId(null); setOverId(null); setEdge(null);
					if (from && from !== id) reorder(from, id, where);
				},
			};

			const removeProvider = useCallback(async (p) => {
				const next = await call(base, "/api/providers/remove", { id: p.id });
				if (next && next.error) return setError(next.error);
				setProviderDelete(null);
				setState(next);
				onNotice(p.name + " 已移除" + (next.keyFileRemoved ? "（含 Key 文件）" : ""));
			}, [base, onNotice]);

			const removeSkill = useCallback(async (skill) => {
				const next = await call(base, "/api/skills/remove", { id: skill.id, off: !skill.enabled });
				if (next && next.error) return setError(next.error);
				setSkills(next.skills || []);
				setSkillDelete(null);
				onNotice(skill.name + " 已删除");
			}, [base, onNotice]);

			const head = h("div", { style: { ...S.bar, gap: "10px" } },
				h("div", { style: { display: "flex", gap: "4px", background: "#171a21", border: "1px solid #262b36", borderRadius: "9px", padding: "3px" } },
					h("button", { className: "ahb", style: S.tab(tab === "providers"), onClick: () => setTab("providers") }, "接口"),
					h("button", { className: "ahb", style: S.tab(tab === "skills"), onClick: () => setTab("skills") },
						"技能 " + (skills.length ? skills.filter((s) => s.enabled).length + "/" + skills.length : ""))),
				h("span", { style: { flex: 1 } }),
				h("span", { style: { color: "#7f8798" } },
					"默认文本 " + (defaults.llm || "—") + "　默认图片 " + (defaults.image || "—")),
				h("button", { className: "ahb", style: S.btnPrimary, onClick: () => setDialog({ type: "add" }) }, "＋ 添加接口"),
				h("button", { className: "ahb", style: S.btn, onClick: () => { load(); loadSkills(); } }, "刷新"));

			const body = tab === "providers"
				? h("div", { style: S.grid },
					providers.length === 0
						? h("div", { style: S.hint }, state ? "没有服务商" : "加载中…")
						: providers.map((p) => h(ProviderCard, {
							key: p.id, provider: p, balances,
							onTest: testProvider, onToggle: toggleProvider,
							onDefault: makeDefault, onBalance: refreshBalance,
							onModels: (provider) => setDialog({ type: "models", provider }),
							onKey: (provider) => setDialog({ type: "key", provider }),
							onRequest: (provider) => setDialog({ type: "request", provider }),
							onRemove: (provider) => setProviderDelete(provider),
							drag,
						})))
				: h("div", { style: S.grid },
					skills.length === 0
						? h("div", { style: S.hint }, "没有技能")
						: skills.map((s) => h(SkillRow, {
							key: s.id, skill: s, onToggle: toggleSkill,
							onView: (skill) => setSkillView(skill),
							onRemove: (skill) => setSkillDelete(skill),
						})));

			return h(React.Fragment, null,
				head,
				error ? h("div", { style: { ...S.hint, color: "#ff8f93", padding: "6px 14px" } }, error) : null,
				h("div", { style: S.body }, body),
				dialog && dialog.type === "models"
					? h(ModelDialog, {
						provider: dialog.provider, base,
						onClose: () => setDialog(null),
						onSaved: (next) => { if (next && next.providers) setState(next); else load(); },
						onNotice,
					})
					: null,
				dialog && dialog.type === "key"
					? h(KeyDialog, {
						provider: dialog.provider, base,
						onClose: () => setDialog(null),
						onSaved: (next) => { if (next && next.providers) setState(next); else load(); },
						onNotice,
					})
					: null,
				dialog && dialog.type === "request"
					? h(RequestDialog, { provider: dialog.provider, base, onClose: () => setDialog(null), onNotice })
					: null,
				dialog && dialog.type === "add"
					? h(AddProviderDialog, {
						base,
						onClose: () => setDialog(null),
						onSaved: (next) => { if (next && next.providers) setState(next); else load(); },
						onNotice,
					})
					: null,
				skillView
					? h(SkillViewDialog, { skill: skillView, base, onClose: () => setSkillView(null) })
					: null,
				skillDelete
					? h(ConfirmDialog, {
						title: "删除技能 · " + skillDelete.name,
						message: "会删除整个目录（含 scripts / assets），不可恢复。只是想暂时不用的话，用左边的开关停用即可。",
						confirmLabel: "确认删除",
						danger: true,
						onCancel: () => setSkillDelete(null),
						onConfirm: () => removeSkill(skillDelete),
					})
					: null,
				providerDelete
					? h(ConfirmDialog, {
						title: "移除接口 · " + providerDelete.name,
						message: providerDelete.keyManaged
							? "它的 Key 文件在 ~/.dsh/api-hub/keys/ 下，会随移除一起删除。"
							: "它的 Key 存在 " + providerDelete.keySource + "，面板不会动那个文件。",
						confirmLabel: "确认移除",
						danger: true,
						onCancel: () => setProviderDelete(null),
						onConfirm: () => removeProvider(providerDelete),
					})
					: null);
		}

		// Solid monochrome mark: every shape inherits currentColor, so the icon
		// follows the surrounding text colour instead of carrying its own accent.
		function HubIcon({ size = 18 }) {
			return h("svg", {
				viewBox: "0 0 24 24", width: size, height: size,
				fill: "none", "aria-hidden": "true",
			},
				h("g", { stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", fill: "none" },
					h("path", { d: "M10.4 10.7 6.3 7.6" }),
					h("path", { d: "M13.6 10.7 17.7 7.6" }),
					h("path", { d: "M12 14.7v3.5" })),
				h("g", { fill: "currentColor", stroke: "none" },
					h("circle", { cx: 4.8, cy: 6, r: 1.9 }),
					h("circle", { cx: 19.2, cy: 6, r: 1.9 }),
					h("circle", { cx: 12, cy: 20, r: 1.9 }),
					h("circle", { cx: 12, cy: 12, r: 2.9 })));
		}

		function ApiHubPageHeader() {
			return h("div", { style: { display: "flex", alignItems: "center", gap: "10px", margin: "2px 0 14px" } },
				h("span", { style: { display: "inline-flex" } }, h(HubIcon, { size: 22 })),
				h("div", null,
					h("div", { style: { fontSize: "15px", fontWeight: 650, color: "#e7eaf1", lineHeight: 1.2 } }, "API Hub"),
					h("div", { style: S.hint }, "本地接口与技能管理")));
		}

		function ApiHubSettingsPage() {
			const [base, setBase] = useState("");
			const [status, setStatus] = useState("checking");
			const [notice, setNotice] = useState("");

			useEffect(() => {
				let alive = true;
				resolvePanelBase().then((found) => {
					if (!alive) return;
					setBase(found);
					setStatus(found ? "up" : "down");
				});
				return () => { alive = false; };
			}, []);

			useEffect(() => {
				if (!notice) return undefined;
				const timer = setTimeout(() => setNotice(""), 2600);
				return () => clearTimeout(timer);
			}, [notice]);

			if (status === "checking") return h("div", { style: S.hint }, "正在连接面板服务…");
			if (!base) return h("div", { style: S.hint }, "找不到面板服务。已尝试：" + CANDIDATES.join("　·　"));

			return h("div", { style: { position: "relative", minHeight: "420px" } },
				h(ApiHubPageHeader),
				h(ApiHubPanel, { base, onNotice: setNotice }),
				notice
					? h("div", {
						style: {
							position: "absolute", left: "50%", bottom: "12px", transform: "translateX(-50%)",
							background: "#232a36", border: "1px solid #333d4f", borderRadius: "10px",
							padding: "8px 14px", fontSize: "12.5px", color: "#e7eaf1",
						},
					}, notice)
					: null);
		}

		function apply(ctx) {
			// Each seat is registered independently and defensively: a slot whose
			// contract differs must not take the other seats (or the plugin) down.
			const seat = (name, register) => {
				try {
					ctx.slots.inject(name, () => {
						try {
							return register();
						} catch (error) {
							console.warn("[api-hub] seat " + name + " failed:", error && error.message ? error.message : error);
							return undefined;
						}
					});
				} catch (error) {
					console.warn("[api-hub] seat " + name + " unavailable:", error && error.message ? error.message : error);
				}
			};

			// The settings nav paints a hard-coded glyph per section id and falls back
			// to the gear for every third-party section, with no way to override it.
			// Rather than ship a duplicate entry wearing the wrong icon, the panel
			// lives only in the sidebar, where `sidebar.panellist` takes a component.

			// Sidebar seat: `sidebar.panellist` takes a component as the glyph, which
			// is how dshmarket shows its own logo, and `main` renders the page.
			seat("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: "api-hub",
				order: 2,
				label: () => "API Hub",
			}, (owner = {}) => h(HubIcon, { size: owner.size || 16 })));

			seat("main", () => ctx.slots.register({
				name: "main",
				key: "api-hub",
				inject: () => ({}),
			}, ApiHubSettingsPage));
		}

		exports.apply = apply;
		exports.inject = inject;
		// Test hooks: render checks mount these directly with fake data.
		exports.__components = { ApiHubPanel, ProviderCard, SkillRow, Switch, Dialog, ModelDialog, KeyDialog, AddProviderDialog, RequestDialog, SkillViewDialog, ConfirmDialog, ApiHubSettingsPage, HubIcon, ApiHubPageHeader };
		return module.exports;
	},
});
