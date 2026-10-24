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
		// Where the panel service lives. Two situations:
		//   - Electron shell: the page origin is not http(s), so the host injects
		//     the server origin and every call is cross-origin to loopback.
		//   - Browser (web mode, including remote access): same-origin is both
		//     reachable and CORS-free, while an injected 127.0.0.1 would point at
		//     the viewer's own machine. Same-origin therefore wins there.
		const rawInjected = typeof window !== "undefined" && window.__API_HUB_ORIGIN__
			? String(window.__API_HUB_ORIGIN__).replace(/\/+$/, "")
			: "";
		// getOrigin() can report a wildcard bind address; 0.0.0.0 and [::] are not
		// dialable from a page, so map them onto loopback.
		const normalizeOrigin = (value) => value
			.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, "$1127.0.0.1")
			.replace(/^(https?:\/\/)\[::\](?=[:/]|$)/i, "$1[::1]");
		const injected = rawInjected ? normalizeOrigin(rawInjected) : "";
		const httpOrigin = location.protocol === "http:" || location.protocol === "https:";
		const CANDIDATES = [];
		const addCandidate = (value) => {
			if (value && !CANDIDATES.includes(value)) CANDIDATES.push(value);
		};
		if (httpOrigin) addCandidate(location.origin + "/api-hub");
		if (injected) addCandidate(injected + "/api-hub");
		addCandidate("/api-hub");

		// Each probe reports why it failed, so the panel can tell a missing route
		// (404/401 from the host) apart from a blocked cross-origin call.
		const probeReasons = [];

		function describeFailure(base, outcome) {
			if (outcome.status) return base + " → HTTP " + outcome.status;
			return base + " → " + outcome.error;
		}

		async function probeHealth(base) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 1500);
			try {
				const response = await fetch(base + "/api/health", { signal: controller.signal });
				clearTimeout(timer);
				if (response.ok) return true;
				probeReasons.push(describeFailure(base, { status: response.status }));
				return false;
			} catch (error) {
				clearTimeout(timer);
				const timedOut = error && error.name === "AbortError";
				probeReasons.push(describeFailure(base, {
					error: timedOut ? "超时" : "连接被拒绝或被浏览器拦截（CORS / 私有网络）",
				}));
				return false;
			}
		}

		async function resolvePanelBase() {
			probeReasons.length = 0;
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
		// DSH paints black-on-black with hairlines and white buttons; the panel
		// follows that instead of inventing a second accent colour of its own.
		const T = {
			ink: "#f2f4f7", inkSoft: "#b3b9c4", inkDim: "#868d99", inkFaint: "#6a7180",
			surface: "#131519", surfaceUp: "#1c1f25", surfaceDown: "#0d0f12",
			line: "rgba(255,255,255,.08)", lineStrong: "rgba(255,255,255,.16)",
			accent: "#d6dbe4", accentInk: "#eef1f6",
			accentLine: "rgba(255,255,255,.22)", accentSoft: "rgba(255,255,255,.06)",
			ok: "#3ecf78", okSoft: "rgba(62,207,120,.12)",
			danger: "#ff6f74", dangerSoft: "rgba(255,111,116,.1)",
			font: "-apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
		};
		const S = {
			bar: {
				display: "flex", alignItems: "center", gap: "10px", padding: "10px 22px",
				borderBottom: "1px solid " + T.line, color: T.inkDim, fontSize: "12px",
				flexWrap: "wrap",
			},
			segmented: {
				display: "flex", gap: "18px", alignItems: "center",
				borderBottom: "1px solid " + T.line, paddingBottom: "2px",
			},
			btn: {
				background: "rgba(255,255,255,.07)", color: T.ink, border: "1px solid " + T.line,
				borderRadius: "8px", padding: "5px 12px", cursor: "pointer",
				font: "500 12.5px/1.5 " + T.font, whiteSpace: "nowrap",
			},
			btnPrimary: {
				background: "#e9ecf1", color: "#111418",
				border: "1px solid #e9ecf1", borderRadius: "8px",
				padding: "5px 12px", cursor: "pointer",
				font: "600 12.5px/1.5 " + T.font, whiteSpace: "nowrap",
			},
			btnDanger: {
				background: "transparent", color: "#ff9a9d", border: "1px solid rgba(255,111,116,.3)",
				borderRadius: "8px", padding: "5px 12px", cursor: "pointer",
				font: "500 12.5px/1.5 " + T.font, whiteSpace: "nowrap",
			},
			tab: (active) => ({
				background: "transparent", border: "none",
				borderBottom: "2px solid " + (active ? T.ink : "transparent"),
				color: active ? T.ink : T.inkDim,
				padding: "6px 1px 7px", marginBottom: "-1px", borderRadius: 0, cursor: "pointer",
				font: (active ? "600 " : "500 ") + "13px/1.5 " + T.font,
				boxShadow: "none",
			}),
			body: { flex: 1, overflow: "auto", padding: "16px 22px 26px" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "14px" },
			card: (off) => ({
				background: T.surface,
				border: "1px solid " + T.line, borderRadius: "12px",
				padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px",
				opacity: off ? 0.6 : 1, transition: "opacity .16s ease",
			}),
			row: { display: "flex", alignItems: "center", gap: "8px" },
			name: {
				fontSize: "14px", fontWeight: 600, letterSpacing: ".1px", minWidth: 0,
				color: T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			tag: {
				fontSize: "11px", padding: "1px 7px", borderRadius: "6px",
				background: "rgba(255,255,255,.03)", border: "1px solid " + T.line,
				color: T.inkSoft, whiteSpace: "nowrap", flexShrink: 0, lineHeight: "16px",
			},
			// Capability chips stay monochrome like the rest of DSH; only the ones
			// that carry a decision (default, invalid name) get weight.
			tagFor: (label) => {
				const strong = label === "默认" || label === "视觉";
				return {
					fontSize: "11px", padding: "1px 7px", borderRadius: "6px",
					background: strong ? "rgba(255,255,255,.07)" : "rgba(255,255,255,.03)",
					border: "1px solid " + (strong ? T.lineStrong : T.line),
					color: strong ? T.ink : T.inkSoft,
					whiteSpace: "nowrap", flexShrink: 0, lineHeight: "16px",
				};
			},
			metaRow: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
			url: {
				fontFamily: MONO, fontSize: "11.5px", color: T.inkDim,
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			buttonGrid: (columns) => ({
				display: "grid", gridTemplateColumns: "repeat(" + columns + ", minmax(0, 1fr))", gap: "8px",
			}),
			dot: (on) => ({
				width: "8px", height: "8px", borderRadius: "50%",
				background: on ? T.ok : "#3a4150",
				boxShadow: on ? "0 0 0 3px rgba(64,201,119,.16)" : "none",
				transition: "background .15s ease",
			}),
			mono: { fontFamily: MONO, fontSize: "11.5px", color: "#c3cbdd" },
			line: {
				display: "flex", alignItems: "center", gap: "8px", padding: "7px 11px",
				background: T.surfaceDown, border: "1px solid " + T.line, borderRadius: "9px",
				fontFamily: MONO, fontSize: "11.5px", color: "#c9d1e2",
			},
			bal: (ok) => ({
				fontFamily: MONO, fontSize: "11.5px",
				padding: "2px 8px", borderRadius: "999px", whiteSpace: "nowrap",
				border: "1px solid " + (ok ? "rgba(64,201,119,.38)" : T.line),
				background: ok ? T.okSoft : "none",
				color: ok ? "#8fe0b2" : T.inkFaint,
			}),
			hint: { fontSize: "11.5px", color: T.inkDim },
		};
		const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
		const symbol = (currency) => (currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency ? currency + " " : "");

		// Buttons share one class so hover/press feedback comes from CSS instead of
		// inline styles (inline styles cannot express :hover / :active).
		const UI_CSS = [
			".ahb { font-family: inherit; transition: transform .06s ease, filter .12s ease, box-shadow .12s ease; }",
			".ahb:hover:not(:disabled) { filter: brightness(1.1); }",
			".ahb:active:not(:disabled) { transform: translateY(1px) scale(.985); box-shadow: inset 0 2px 6px rgba(0,0,0,.45); }",
			".ahb:disabled { opacity: .42; cursor: default; }",
			".ahb:focus-visible { outline: 2px solid rgba(255,255,255,.42); outline-offset: 2px; }",
			// Cards lift a hair on hover so a wall of them still says which one the
			// pointer is on; the border is inline-styled, hence !important.
			".ahcard { transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease; }",
			".ahcard:hover { border-color: rgba(255,255,255,.17) !important; }",
			".ahkey { transition: border-color .16s ease, color .16s ease, background .16s ease; }",
			".ahkey:hover { border-color: rgba(255,255,255,.24) !important; color: #f2f4f7 !important; background: #14171c !important; }",
			".ahfield:focus { border-color: rgba(255,255,255,.5) !important; box-shadow: 0 0 0 3px rgba(255,255,255,.09); outline: none; }",
			".ahscroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.14) transparent; }",
			".ahscroll::-webkit-scrollbar { width: 10px; height: 10px; }",
			".ahscroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 8px; border: 3px solid transparent; background-clip: padding-box; }",
			".ahscroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.2); background-clip: padding-box; }",
			".ahscroll::-webkit-scrollbar-track { background: transparent; }",
			".ahtoast { animation: ah-toast-in .18s ease-out; }",
			"@keyframes ah-toast-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }",
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
						borderRadius: "50%", background: on ? "#40c977" : "#aeb7c8",
						transform: on ? "translateX(15px)" : "none", transition: "transform .15s, background .15s",
					},
				}));
		}

		// An empty panel should say what is missing and what to do next, instead of
		// printing one grey word in the top-left corner of the grid.
		function EmptyState({ title, hint, action }) {
			return h("div", {
				style: {
					gridColumn: "1 / -1", display: "flex", flexDirection: "column",
					alignItems: "center", justifyContent: "center", gap: "7px",
					padding: "40px 20px", borderRadius: "14px",
					border: "1px dashed rgba(255,255,255,.1)",
					background: "rgba(255,255,255,.015)", textAlign: "center",
				},
			},
				h("div", { style: { fontSize: "13.5px", fontWeight: 600, color: T.inkSoft } }, title),
				hint ? h("div", { style: { ...S.hint, maxWidth: "400px", lineHeight: 1.75 } }, hint) : null,
				action || null);
		}

		function ProviderCard({ provider, balances, onTest, onToggle, onDefault, onBalance, onModels, onKeySave, onRequest, onRename, onRemove, drag, edge }) {
			const p = provider;
			const dragging = drag && drag.draggingId === p.id;
			const [renaming, setRenaming] = useState(false);
			const [draft, setDraft] = useState("");
			const [nameError, setNameError] = useState("");
			const balance = balances[p.id];
			const balanceLabel = balance === undefined
				? null
				: balance === null
					? "…"
					: balance.ok
						? symbol(balance.currency) + Number(balance.amount).toFixed(2)
						: "—";
			const startRename = () => {
				setDraft(p.name);
				setNameError("");
				setRenaming(true);
			};
			const stopRename = () => {
				setRenaming(false);
				setNameError("");
			};
			const commitRename = async () => {
				const next = String(draft).replace(/\s+/g, " ").trim();
				if (!next || next === p.name) return stopRename();
				// The server is the judge; keep the box open with its reason so the
				// typed name is never silently thrown away.
				const problem = await onRename(p, next);
				if (problem) return setNameError(problem);
				stopRename();
			};
			// The key is one paste away, so it is edited in place: double-click the
			// masked line, paste, Enter. A refused key keeps the box open with the
			// server's words (a `.toml`/`.env` source cannot be rewritten from here).
			const [keyEditing, setKeyEditing] = useState(false);
			const [keyDraft, setKeyDraft] = useState("");
			const [keyError, setKeyError] = useState("");
			const [keySaving, setKeySaving] = useState(false);
			const startKeyEdit = () => {
				setKeyDraft("");
				setKeyError("");
				setKeyEditing(true);
			};
			const stopKeyEdit = () => {
				setKeyEditing(false);
				setKeyError("");
			};
			const commitKey = async () => {
				const next = String(keyDraft).trim();
				if (!next) return stopKeyEdit();
				setKeySaving(true);
				const problem = await onKeySave(p, next);
				setKeySaving(false);
				if (problem) return setKeyError(problem);
				stopKeyEdit();
			};
			return h("div", {
				className: "ahcard",
				style: {
					...S.card(false),
					...(p.enabled ? null : { borderColor: "rgba(255,255,255,.05)" }),
					...(dragging ? { opacity: 0.35 } : null),
					// `edge` marks where the dragged card will land: the target card and
					// the neighbour whose edge faces that gap both light up, so the gap
					// itself reads as the drop position.
					...(edge === "left" ? { boxShadow: "inset 2px 0 0 #e9ecf1" } : null),
					...(edge === "right" ? { boxShadow: "inset -2px 0 0 #e9ecf1" } : null),
				},
				draggable: Boolean(drag) && !renaming && !keyEditing,
				onDragStart: drag ? (e) => {
					if (renaming || keyEditing) { e.preventDefault(); return; }
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
					// Horizontal position decides the side; the grid flows left to right,
					// so a card's left half means "insert before it" and vice versa.
					drag.onOver(p.id, e.clientX > rect.left + rect.width / 2 ? "right" : "left");
				} : undefined,
				onDrop: drag ? (e) => {
					e.preventDefault();
					drag.onDrop(p.id);
				} : undefined,
			},
				h("div", { style: { ...S.row, justifyContent: "space-between", gap: "10px" } },
					renaming
						? h("input", {
							value: draft,
							autoFocus: true,
							draggable: false,
							spellCheck: false,
							"aria-label": "接口名称",
							style: {
								flex: 1, minWidth: 0, boxSizing: "border-box",
								background: "#101319", color: "#e9edf5",
								border: "1px solid " + (nameError ? "#ff6f74" : "rgba(255,255,255,.5)"),
								borderRadius: "8px", padding: "3px 8px",
								font: "600 13.5px/1.4 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
							},
							onChange: (e) => { setDraft(e.target.value); setNameError(""); },
							onKeyDown: (e) => {
								if (e.key === "Enter") { e.preventDefault(); commitRename(); } else if (e.key === "Escape") { e.preventDefault(); stopRename(); }
								e.stopPropagation();
							},
							onBlur: () => { if (!nameError) commitRename(); },
							onMouseDown: (e) => e.stopPropagation(),
							onDragStart: (e) => e.preventDefault(),
						})
						: h("span", { style: S.name, title: "双击改名", onDoubleClick: startRename }, p.name),
					h("div", { style: { ...S.row, gap: "10px", flexShrink: 0 } },
						h("span", { style: S.dot(p.keyPresent) }),
						h(Switch, { on: p.enabled, title: p.enabled ? "已启用" : "已停用", onChange: (v) => onToggle(p, v) }))),
				nameError ? h("div", { style: { color: "#ffa2a5", fontSize: "12px" } }, nameError) : null,
				h("div", { style: S.metaRow },
					// One chip per capability, so "视觉" reads as its own fact instead of
					// being folded into a single "文本 · 视觉" string.
					...String(p.tag || p.kind || "文本").split(" · ").map((label, i) => h("span", {
						key: "t" + i,
						style: S.tagFor(label),
						title: label === "视觉"
							? (p.vision?.tested ? (p.vision.ok ? "已实测：这个接口的默认模型能读图" : "实测不支持读图：" + (p.vision.note || "")) : "按模型名推断，未实测")
							: undefined,
					}, label)),
					p.isDefault ? h("span", { style: S.tagFor("默认") }, "默认") : null,
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
					keyEditing
						? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 } },
							h("input", {
								type: "text",
								value: keyDraft,
								autoFocus: true,
								draggable: false,
								spellCheck: false,
								autoComplete: "off",
								placeholder: "粘贴新的 Key，回车保存",
								"aria-label": "接口 Key",
								style: {
									display: "flex", alignItems: "center", padding: "6px 10px",
									background: "#101319", color: "#e9edf5", outline: "none",
									border: "1px solid " + (keyError ? "#ff6f74" : "rgba(255,255,255,.5)"),
									borderRadius: "8px",
									fontFamily: MONO, fontSize: "11.5px",
									opacity: keySaving ? 0.6 : 1,
								},
								onChange: (e) => { setKeyDraft(e.target.value); setKeyError(""); },
								onKeyDown: (e) => {
									if (e.key === "Enter") { e.preventDefault(); if (!keySaving) commitKey(); }
									else if (e.key === "Escape") { e.preventDefault(); stopKeyEdit(); }
									e.stopPropagation();
								},
								onBlur: () => { if (!keySaving && !keyError) stopKeyEdit(); },
								onMouseDown: (e) => e.stopPropagation(),
								onDragStart: (e) => e.preventDefault(),
							}),
							h("span", { style: { ...S.hint, color: keyError ? "#ffa2a5" : "#7c8598" } },
								keyError || (keySaving ? "正在保存…" : "回车保存 · Esc 取消")))
						: h("div", {
							className: "ahkey",
							style: { ...S.line, cursor: "text" },
							title: "双击改 Key",
							onDoubleClick: startKeyEdit,
						},
							h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
								p.keyPresent ? p.keyMasked : "未配置 Key——双击填写")),
					h("div", { style: { display: "flex", gap: "6px", minWidth: 0, alignItems: "baseline" } },
						h("span", { style: { ...S.hint, flexShrink: 0 } }, "默认模型"),
						h("span", {
							style: {
								...S.mono, minWidth: 0, color: "#cdd5e6",
								overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
							},
						}, p.defaultModel || "未设置")),
					h("div", { style: S.buttonGrid(4) },
						h("button", { className: "ahb", style: S.btn, disabled: !p.keyPresent || !p.enabled, onClick: () => onTest(p) }, "测试"),
						h("button", { className: "ahb", style: S.btn, disabled: !p.enabled, onClick: () => onBalance(p) }, "查余额"),
						h("button", { className: "ahb", style: S.btn, disabled: !p.enabled, onClick: () => onModels(p) }, "模型"),
						h("button", { className: "ahb", style: S.btn, disabled: !p.enabled, onClick: () => onRequest(p) }, "请求")),
					h("div", { style: S.buttonGrid(2) },
						h("button", {
							className: "ahb",
							style: p.isDefault ? { ...S.btnPrimary, opacity: 1 } : S.btn,
							disabled: !p.enabled,
							onClick: () => onDefault(p),
						}, "默认"),
						h("button", {
							className: "ahb",
							style: S.btnDanger,
							onClick: () => onRemove(p),
						}, "移除"))));
		}

		function SkillRow({ skill, onToggle, onView, onRename, onTags, onRemove, drag, edge }) {
			const [renaming, setRenaming] = useState(false);
			const [draft, setDraft] = useState("");
			const [nameError, setNameError] = useState("");
			const dragging = drag && drag.draggingId === skill.id;
			const startRename = () => { setDraft(skill.name); setNameError(""); setRenaming(true); };
			const stopRename = () => { setRenaming(false); setNameError(""); };
			const commitRename = async () => {
				const next = String(draft).replace(/\s+/g, " ").trim();
				if (!next || next === skill.name) return stopRename();
				const problem = await onRename(skill, next);
				if (problem) return setNameError(problem);
				stopRename();
			};
			return h("div", {
				className: "ahcard",
				style: {
					...S.card(!skill.enabled), padding: "11px 13px", gap: "8px",
					...(dragging ? { opacity: 0.35 } : null),
					...(edge === "left" ? { boxShadow: "inset 2px 0 0 #e9ecf1" } : null),
					...(edge === "right" ? { boxShadow: "inset -2px 0 0 #e9ecf1" } : null),
				},
				draggable: Boolean(drag) && !renaming,
				onDragStart: drag ? (e) => {
					if (renaming) { e.preventDefault(); return; }
					try {
						e.dataTransfer.effectAllowed = "move";
						e.dataTransfer.setData("text/plain", skill.id);
					} catch { /* older engines */ }
					drag.onStart(skill.id);
				} : undefined,
				onDragEnd: drag ? () => drag.onEnd() : undefined,
				onDragOver: drag ? (e) => {
					e.preventDefault();
					const rect = e.currentTarget.getBoundingClientRect();
					drag.onOver(skill.id, e.clientX > rect.left + rect.width / 2 ? "right" : "left");
				} : undefined,
				onDrop: drag ? (e) => {
					e.preventDefault();
					drag.onDrop(skill.id);
				} : undefined,
			},
				h("div", { style: { ...S.row, justifyContent: "space-between" } },
					h("div", { style: { ...S.row, minWidth: 0 } },
						renaming
							? h("input", {
								value: draft,
								autoFocus: true,
								spellCheck: false,
								"aria-label": "技能名称",
								style: {
									flex: 1, minWidth: 0, boxSizing: "border-box",
									background: "#101319", color: "#e9edf5",
									border: "1px solid " + (nameError ? "#ff6f74" : "rgba(255,255,255,.5)"),
									borderRadius: "8px", padding: "3px 8px",
									font: "600 13.5px/1.4 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
								},
								onChange: (e) => { setDraft(e.target.value); setNameError(""); },
								onKeyDown: (e) => {
									if (e.key === "Enter") { e.preventDefault(); commitRename(); } else if (e.key === "Escape") { e.preventDefault(); stopRename(); }
									e.stopPropagation();
								},
								onBlur: () => { if (!nameError) commitRename(); },
							})
							: h("span", {
								style: { ...S.name, fontSize: "13.5px", overflow: "hidden", textOverflow: "ellipsis" },
								title: "双击改名",
								onDoubleClick: startRename,
							}, skill.name),
						skill.scope && skill.scope !== "global"
							? h("span", {
								style: { ...S.tag, flexShrink: 0 },
								title: skill.scope === "project" ? "项目目录里的技能（" + skill.root + "）" : "~/.agents 下与其它工具共用的技能",
							}, skill.scope === "project" ? "项目" : "agents")
							: null,
						!skill.dshValidName
							? h("span", {
								style: { ...S.tag, flexShrink: 0, color: "#ffa2a5", borderColor: "rgba(255,111,116,.42)", background: "rgba(255,111,116,.1)" },
								title: "DSH 只加载 name 匹配 ^[a-z0-9]+(-[a-z0-9]+)*$ 的技能",
							}, "名字不合规")
							: null,
						!skill.enabled ? h("span", { style: { ...S.tag, flexShrink: 0 } }, "已停用") : null),
					skill.managed === false
						? h("span", { style: { ...S.hint, flexShrink: 0 }, title: "这个技能不在 ~/.dsh/skills 里，面板只读不改动" }, "只读")
						: h(Switch, { on: skill.enabled, onChange: (v) => onToggle(skill, v) })),
				nameError ? h("div", { style: { color: "#ffa2a5", fontSize: "12px" } }, nameError) : null,
				!skill.dshValidName
					? h("div", { style: { color: "#ffa2a5", fontSize: "12px" } },
						"这个名字 DSH 不会加载——改成小写字母、数字和连字符，例如 my-skill")
					: null,
				h("div", { style: { ...S.hint, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } },
					skill.description || "（无描述）"),
				(skill.tags && skill.tags.length)
					? h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
						...skill.tags.map((tag) => h("span", {
							key: "g" + tag,
							style: S.tagFor("文本"),
						}, tag)))
					: null,
				h("div", { style: S.hint }, skill.files + " 个文件 · " + fmtBytes(skill.bytes)),
				h("div", { style: { display: "flex", gap: "8px" } },
					h("button", { className: "ahb", style: S.btn, onClick: () => onView(skill) }, "查看"),
					h("button", { className: "ahb", style: S.btn, onClick: () => onTags(skill) }, skill.tags && skill.tags.length ? "标签 ·" + skill.tags.length : "标签"),
					skill.managed === false
						? null
						: h("button", { className: "ahb", style: S.btnDanger, onClick: () => onRemove(skill) }, "删除")));
		}

		/** Tags are picked, not typed, once the tag exists — but the first one has
		 *  to be typed, so the box doubles as a create field. */
		function TagDialog({ skill, allTags, onSave, onClose }) {
			const [tags, setTags] = useState((skill.tags || []).slice());
			const [draft, setDraft] = useState("");
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);

			const add = (raw) => {
				const value = String(raw).replace(/\s+/g, " ").trim().slice(0, 16);
				if (!value) return;
				if (tags.includes(value)) { setDraft(""); return; }
				if (tags.length >= 12) { setError("最多 12 个标签"); return; }
				setTags([...tags, value]);
				setDraft("");
				setError("");
			};
			const remove = (tag) => setTags(tags.filter((x) => x !== tag));

			const save = async () => {
				if (busy) return;
				setBusy(true);
				const problem = await onSave(skill, tags);
				setBusy(false);
				if (problem) return setError(problem);
				onClose();
			};

			const unused = allTags.filter((tag) => !tags.includes(tag));

			return h(Dialog, {
				title: "标签 · " + skill.name,
				onClose,
				footer: h(React.Fragment, null,
					h("button", { className: "ahb", style: S.btn, onClick: onClose }, "取消"),
					h("button", { className: "ahb", style: S.btnPrimary, disabled: busy, onClick: save }, busy ? "保存中…" : "保存")),
			},
				h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
					h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", minHeight: "26px" } },
						tags.length
							? tags.map((tag) => h("span", {
								key: tag,
								style: { ...S.tag, color: T.ink, borderColor: T.lineStrong, background: "rgba(255,255,255,.06)", display: "inline-flex", gap: "6px", alignItems: "center" },
							}, tag,
								h("span", { style: { cursor: "pointer", color: "#aeb7c8" }, onClick: () => remove(tag), title: "移除" }, "×")))
							: h("span", { style: S.hint }, "还没有标签")),
					h("div", { style: { display: "flex", gap: "8px" } },
						h("input", {
							value: draft,
							placeholder: "新标签，回车添加（例如：写作、图像）",
							style: DIALOG.input,
							onChange: (e) => { setDraft(e.target.value); setError(""); },
							onKeyDown: (e) => {
								if (e.key === "Enter") { e.preventDefault(); add(draft); }
								e.stopPropagation();
							},
						}),
						h("button", { className: "ahb", style: S.btn, onClick: () => add(draft) }, "添加")),
					unused.length
						? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
							h("div", { style: S.hint }, "已有的标签，点一下加入："),
							h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
								...unused.slice(0, 40).map((tag) => h("span", {
									key: "s" + tag,
									style: { ...S.tag, cursor: "pointer" },
									onClick: () => add(tag),
								}, tag))))
						: null,
					error ? h("div", { style: { ...S.hint, color: "#ff9a9d" } }, error) : null));
		}

		// ------------------------------------------------------------- dialogs
		const DIALOG = {
			backdrop: {
				position: "fixed", inset: 0, zIndex: 70, background: "rgba(6,8,12,.6)",
				backdropFilter: "blur(2px)",
			},
			panel: {
				position: "fixed", zIndex: 71, top: "12vh", left: "50%", transform: "translateX(-50%)",
				width: "min(640px, 92vw)", maxHeight: "70vh", display: "flex", flexDirection: "column",
				background: "#14171c",
				border: "1px solid rgba(255,255,255,.12)", borderRadius: "16px",
				boxShadow: "0 28px 90px rgba(0,0,0,.62), 0 1px 0 rgba(255,255,255,.05) inset", color: "#e9edf5",
				font: "13px/1.5 " + T.font, overflow: "hidden",
			},
			head: {
				display: "flex", alignItems: "center", gap: "8px", padding: "13px 16px",
				borderBottom: "1px solid rgba(255,255,255,.07)", fontSize: "14px", fontWeight: 650,
			},
			body: { padding: "14px 16px", overflow: "auto", flex: 1 },
			foot: {
				display: "flex", justifyContent: "flex-end", gap: "8px",
				padding: "11px 16px", borderTop: "1px solid rgba(255,255,255,.07)",
				background: "rgba(0,0,0,.16)",
			},
			row: (on) => ({
				display: "flex", alignItems: "center", gap: "10px", padding: "6px 8px",
				borderRadius: "9px", background: on ? "rgba(255,255,255,.07)" : "transparent",
				cursor: "pointer", transition: "background .12s ease",
			}),
			id: { fontFamily: MONO, fontSize: "12px", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			input: {
				width: "100%", boxSizing: "border-box", background: "#101319", color: "#e9edf5",
				border: "1px solid rgba(255,255,255,.12)", borderRadius: "9px", padding: "8px 10px",
				font: "12.5px/1.4 " + MONO,
			},
		};

		// The server tags every model it returns; these are just the labels for it.
		const TYPE_LABEL = { llm: "文本", vision: "视觉", image: "图片", video: "视频", audio: "语音", embedding: "向量" };
		const TYPE_ORDER = ["llm", "vision", "image", "video", "audio", "embedding"];
		const typesLabel = (types) => {
			const set = new Set(types);
			const parts = [];
			if (set.has("llm")) parts.push("文本");
			if (set.has("vision")) parts.push("视觉");
			if (set.has("image")) parts.push("图片");
			if (set.has("video")) parts.push("视频");
			if (set.has("audio")) parts.push("语音");
			if (set.has("embedding")) parts.push("向量");
			return (parts.length ? parts : ["文本"]).join(" · ");
		};
		const modelTypeText = (m) => (m.types && m.types.length ? m.types : (m.type ? [m.type] : []))
			.map((t) => TYPE_LABEL[t] || t).join(" · ");
		const MODEL_CHIP = {
			fontSize: "11px", color: "#aeb7c8", border: "1px solid rgba(255,255,255,.12)",
			borderRadius: "999px", padding: "0 6px", whiteSpace: "nowrap",
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
			const [kindInfo, setKindInfo] = useState(null);

			const load = useCallback(async (refresh) => {
				setLoading(true);
				setError("");
				try {
					const result = await call(base, "/api/models?id=" + encodeURIComponent(provider.id) + (refresh ? "&refresh=1" : ""));
					const list = (result.list || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), "en", { numeric: true }));
					setModels(list);
					const allowed = provider.selectedModels;
					setPicked(new Set(allowed ? allowed.filter((id) => list.some((m) => m.id === id)) : list.map((m) => m.id)));
					if (result.kind) setKindInfo(result.kind);
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

			// Live over the ticked models, so unticking the image models really does
			// turn a 文本 · 图片 provider back into a 文本 one.
			const pickedTypes = (() => {
				const seen = new Set();
				for (const m of models || []) {
					if (!picked || !picked.has(m.id)) continue;
					for (const t of (m.types || (m.type ? [m.type] : []))) seen.add(t);
				}
				return TYPE_ORDER.filter((t) => seen.has(t));
			})();
			const kindLine = models && models.length
				? h("div", { style: { ...S.hint, marginBottom: "8px" } },
					"类型：" + (pickedTypes.length ? typesLabel(pickedTypes) : (kindInfo && kindInfo.label) || "文本")
					+ " · 按已选模型判断")
				: null;

			const body = models === null
				? h("div", { style: S.hint }, loading ? "加载中…" : "没有模型")
				: models.length === 0
					? h("div", { style: S.hint }, "没有拿到模型列表")
					: models.map((m) => h("div", { key: m.id, style: DIALOG.row((picked || new Set()).has(m.id)) },
						h("input", {
							type: "checkbox", checked: (picked || new Set()).has(m.id),
							onChange: () => toggle(m.id),
							style: { accentColor: "#c3c9d4", width: "15px", height: "15px", cursor: "pointer" },
						}),
						h("span", { style: DIALOG.id, onClick: () => toggle(m.id) }, m.id),
						m.type ? h("span", { style: MODEL_CHIP }, modelTypeText(m)) : null,
						h("span", { style: S.hint }, m.contextWindow ? "ctx " + m.contextWindow : ""),
						h("label", { style: { ...S.hint, display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" } },
							h("input", {
								type: "radio", name: "api-hub-def", checked: def === m.id,
								onChange: () => chooseDefault(m.id),
								style: { accentColor: "#c3c9d4", cursor: "pointer" },
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
				error ? h("div", { style: { ...S.hint, color: "#ff9a9d", marginBottom: "8px" } }, error) : null,
				kindLine,
				body);
		}

		function AddProviderDialog({ base, onClose, onSaved, onNotice }) {
			const [name, setName] = useState("");
			const [guess, setGuess] = useState(null);
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
					setGuess(result.kind || null);
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
						name: name.trim(), baseURL: baseURL.trim(), key: key.trim(),
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

			// Not a setting: the tag is whatever the ticked models are, so it follows
			// the checkboxes and adds up multimodal models (文本 · 视觉).
			const pickedTypes = (() => {
				const seen = new Set();
				for (const m of models || []) {
					if (!picked.has(m.id)) continue;
					for (const t of (m.types || (m.type ? [m.type] : []))) seen.add(t);
				}
				return TYPE_ORDER.filter((t) => seen.has(t));
			})();
			const pickedCounts = TYPE_ORDER.map((t) => [
				t,
				(models || []).filter((m) => picked.has(m.id) && (m.types || [m.type]).includes(t)).length,
			]).filter(([, n]) => n > 0);
			const typeText = pickedTypes.length ? typesLabel(pickedTypes) : (guess ? guess.label : "勾选模型后显示");
			const typeReason = pickedCounts.length
				? "按已选 " + picked.size + " 个模型 · " + pickedCounts.map(([t, n]) => n + " 个" + TYPE_LABEL[t] + "模型").join("，")
				: "勾选模型后自动显示";

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
							style: { accentColor: "#c3c9d4", width: "15px", height: "15px", cursor: "pointer" },
						}),
						h("span", { style: DIALOG.id }, m.id),
						m.type ? h("span", { style: MODEL_CHIP }, modelTypeText(m)) : null,
						h("span", { style: S.hint }, m.contextWindow ? "ctx " + m.contextWindow : ""),
						h("label", { style: { ...S.hint, display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" } },
							h("input", {
								type: "radio", name: "api-hub-add-def", checked: def === m.id,
								onChange: () => { setDef(m.id); setPicked((cur) => new Set(cur).add(m.id)); },
								style: { accentColor: "#c3c9d4", cursor: "pointer" },
							}),
							"默认")));

			const toolbar = models && models.length
				? h("div", { style: { display: "flex", alignItems: "center", gap: "8px", margin: "10px 0 4px", flexWrap: "wrap" } },
					h("span", { style: { ...S.hint, flex: 1 } }, "从 " + testPath + " 找到 " + models.length + " 个模型 · 已选 " + picked.size),
					h("button", { className: "ahb", style: S.btn, onClick: () => setPicked(new Set(models.map((m) => m.id))) }, "全选"),
					h("button", { className: "ahb", style: S.btn, onClick: () => { setPicked(new Set()); setDef(""); } }, "取消全选"))
				: null;

			return h(Dialog, {
				title: "添加接口",
				onClose,
				footer: h(React.Fragment, null,
					h("button", { className: "ahb", style: S.btn, disabled: busy, onClick: probe }, busy ? "处理中…" : models ? "重新检索" : "检索模型"),
					h("button", { className: "ahb", style: S.btnPrimary, disabled: busy || models === null, onClick: save }, "添加")),
			},
				field("名称", h("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "留空则用域名", style: DIALOG.input })),
				h("div", { style: { display: "flex", gap: "8px" } },
					h("div", { style: { flex: 1.4 } }, h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px" } },
						h("span", { style: S.hint }, "类型"),
						h("div", { style: { display: "flex", alignItems: "center", gap: "8px", minHeight: "30px" } },
							h("span", { style: { color: pickedTypes.length ? T.ink : T.inkFaint, fontSize: "12.5px" } }, typeText),
							h("span", { style: { ...S.hint, fontSize: "11px" } }, typeReason)))),
					h("div", { style: { flex: 2 } }, field("Base URL", h("input", {
						value: baseURL, onChange: (e) => setBaseURL(e.target.value), placeholder: "https://api.example.com/v1", style: DIALOG.input,
					})))),
				field("API Key", h("input", {
					type: "password", value: key, onChange: (e) => setKey(e.target.value),
					placeholder: "sk-...", autoComplete: "new-password", style: DIALOG.input,
				})),
				error ? h("div", { style: { ...S.hint, color: "#ff9a9d", margin: "6px 0" } }, error) : null,
				toolbar,
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
				error ? h("div", { style: { ...S.hint, color: "#ff9a9d", marginTop: "6px" } }, error) : null,
				result ? h(React.Fragment, null,
					h("div", { style: { ...S.hint, marginTop: "8px" } },
						"HTTP " + result.status + " · " + result.ms + "ms · " + (result.url || "")),
					h("pre", {
						style: {
							margin: "6px 0 0", padding: "10px", background: "#101319", border: "1px solid rgba(255,255,255,.07)",
							borderRadius: "8px", maxHeight: "220px", overflow: "auto", whiteSpace: "pre-wrap",
							wordBreak: "break-word", fontFamily: MONO, fontSize: "11.5px", color: "#c9d1e2",
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
				error ? h("div", { style: { ...S.hint, color: "#ff9a9d" } }, error) : null,
				content === null
					? h("div", { style: S.hint }, "读取中…")
					: h("pre", {
						style: {
							margin: 0, padding: "10px", background: "#101319", border: "1px solid rgba(255,255,255,.07)",
							borderRadius: "8px", maxHeight: "48vh", overflow: "auto", whiteSpace: "pre-wrap",
							wordBreak: "break-word", fontFamily: MONO, fontSize: "11.5px", color: "#c9d1e2",
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
						style: { ...S.btnPrimary, ...(danger ? { background: "rgba(242,85,90,.16)", borderColor: "rgba(242,85,90,.5)", color: "#ffb9bc" } : null) },
						onClick: onConfirm,
					}, confirmLabel || "确认")),
			}, h("div", { style: { fontSize: "13px", lineHeight: 1.7 } }, message));
		}

		const D = {
			findRow: {
				display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px",
				border: "1px solid " + T.line, borderRadius: "9px", background: "#16191f",
			},
			findName: {
				fontSize: "13px", fontWeight: 600, color: "#e9edf5",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			findMeta: {
				fontSize: "11.5px", color: "#aeb7c8", marginTop: "2px",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			findDone: { fontSize: "11.5px", color: "#7fd8a0", flexShrink: 0 },
			sectionTitle: { fontSize: "11.5px", fontWeight: 600, color: "#7c8598", marginTop: "4px" },
			input: {
				background: "#141821", border: "1px solid rgba(255,255,255,.12)", borderRadius: "7px",
				color: "#e9edf5", padding: "5px 8px", fontSize: "12px", outline: "none",
			},
		};

		// Automatic scanning stays inside DSH's own folder; everything else is a
		// manual import. Folded by default, and the toggle says what expanding is
		// for, so nobody has to guess why the row is there.
		function ScanScopeBlock({ data, form, setForm, onAdd, onRemove }) {
			const [open, setOpen] = useState(false);
			const isFile = form.type === "file";
			const custom = (data.sources.files || []).length + (data.sources.skillDirs || []).length;
			return h("div", {
				style: { borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: "8px" },
			},
				h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					h("span", { style: { ...D.sectionTitle, marginTop: 0 } }, "扫描范围"),
					h("span", {
						style: {
							...S.hint, flex: 1, minWidth: 0, overflow: "hidden",
							textOverflow: "ellipsis", whiteSpace: "nowrap",
						},
						title: "自动扫描：" + (data.scopes.auto || []).join("　"),
					}, "自动扫描 " + (data.scopes.auto || []).join("　")
						+ (custom ? "　·　已手动导入 " + custom + " 处" : "")),
					h("button", {
						className: "ahb",
						style: { ...S.btn, padding: "3px 9px", fontSize: "11.5px" },
						title: "把 DSH 目录之外的接口或技能导入进来",
						onClick: () => setOpen(!open),
					}, open ? "收起" : "手动导入")),
				open ? h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" } },
					h("div", { style: { ...S.hint, lineHeight: 1.8, whiteSpace: "pre-line" } }, scanScopeText(data.scopes)),
					h("div", { style: { ...S.hint, fontSize: "11.5px", lineHeight: 1.7 } },
						"手动导入：接口或技能放在 DSH 目录之外（D 盘、别的工具目录）时，在这里加一条路径或目录。Key 仍留在原文件，不会被复制。"),
					custom
						? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
							data.sources.files.map((entry) => h("div", {
								key: "sf:" + entry.path,
								style: { display: "flex", alignItems: "center", gap: "8px" },
							},
								h("span", {
									style: { ...S.hint, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								}, "配置文件　" + entry.path + "　" + (entry.preset?.name || "") + "　" + entry.jsonPath.join(".")),
								h("button", { className: "ahb", style: S.btn, onClick: () => onRemove("file", entry.path) }, "移除"))),
							data.sources.skillDirs.map((dir) => h("div", {
								key: "sd:" + dir,
								style: { display: "flex", alignItems: "center", gap: "8px" },
							},
								h("span", {
									style: { ...S.hint, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								}, "技能目录　" + dir),
								h("button", { className: "ahb", style: S.btn, onClick: () => onRemove("skills", dir) }, "移除"))))
						: null,
					h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" } },
						h("select", {
							style: { ...D.input, width: "110px" },
							value: form.type,
							onChange: (e) => setForm({ ...form, type: e.target.value }),
						},
							h("option", { value: "file" }, "配置文件"),
							h("option", { value: "skills" }, "技能目录")),
						h("input", {
							style: { ...D.input, flex: 1, minWidth: "200px" },
							placeholder: isFile ? "配置文件完整路径，如 D:\\apps\\relay\\config.toml" : "技能目录，如 D:\\skills",
							value: form.path,
							onChange: (e) => setForm({ ...form, path: e.target.value }),
						}),
						isFile ? h("input", {
							style: { ...D.input, width: "150px" },
							placeholder: "字段路径",
							title: "这个文件里存 Key 的字段名，例如 apiKey、api_key、auth.token",
							value: form.jsonPath,
							onChange: (e) => setForm({ ...form, jsonPath: e.target.value }),
						}) : null,
						isFile ? h("input", {
							style: { ...D.input, flex: 1, minWidth: "180px" },
							placeholder: "Base URL（文件里自带地址可留空）",
							value: form.baseURL,
							onChange: (e) => setForm({ ...form, baseURL: e.target.value }),
						}) : null,
						isFile ? h("input", {
							style: { ...D.input, width: "120px" },
							placeholder: "名称（可选）",
							value: form.name,
							onChange: (e) => setForm({ ...form, name: e.target.value }),
						}) : null,
						h("button", { className: "ahb", style: S.btnPrimary, disabled: !form.path.trim(), onClick: onAdd }, "添加")))
					: null);
		}

		// Finds what is already on the machine: API keys in the DSH credential
		// store or the environment, and skills belonging to other agent tools.
		// Nothing is imported until the row's button is pressed.
		// Where a found skill came from, so a row does not look like it was already
		// in DSH just because the folder exists somewhere else on the machine.
		const SKILL_SOURCE_LABEL = {
			codex: "Codex", claude: "Claude", agents: "Agents", cursor: "Cursor",
			continue: "Continue", ccswitch: "CC Switch", custom: "手动添加的目录",
		};

		// The 自动扫描 block names the paths the backend really reads, so moving
		// DSH_HOME or adding a skill root shows up here instead of leaving a stale
		// `~/.dsh` sentence behind.
		function scanScopeText(scopes) {
			const s = scopes || {};
			const dshHome = s.dshHome || "~/.dsh";
			const credentials = s.credentials || dshHome + "/.credentials.yaml";
			const managedSkills = s.managedSkills || dshHome + "/skills";
			const sep = s.sep || "/";
			const lines = [
				"自动扫描　DSH 自己的目录",
				"　凭据库　" + credentials + " 的 refs"
					+ (s.credentialService === false ? "（凭据服务未接入：改动直接写文件，需重启 DSH 生效）" : ""),
				"　环境变量　*_API_KEY / *_KEY",
				"　配置文件　" + dshHome + " 下的 JSON / TOML / .env，识别 apiKey / api_key / *_API_KEY / token 字段",
				"　技能　" + managedSkills + "、" + "<项目>" + sep + ".dsh" + sep + "skills、"
					+ (s.agentsHome || "~/.agents") + sep + "skills，单文件技能 <名字>.md 也算",
			];
			return lines.join("\n");
		}

		function DiscoverDialog({ base, onClose, onNotice, onImported, onSkills }) {
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState("");
			const [urls, setUrls] = useState({});
			const [form, setForm] = useState({ type: "file", path: "", jsonPath: "apiKey", baseURL: "", name: "" });

			const load = useCallback(async () => {
				try {
					setData(await call(base, "/api/discover"));
					setError("");
				} catch (e) {
					setError(String(e));
				}
			}, [base]);

			useEffect(() => { load(); }, [load]);

			const [checks, setChecks] = useState({});

			// Every candidate is really called before it can be imported: the button
			// stays dead until the API answers, so a dead address never reaches the list.
			const candidates = () => {
				if (!data) return [];
				const out = [];
				for (const item of data.credentials) {
					const tag = "c:" + item.ref;
					out.push({
						tag, label: item.preset?.name || item.ref,
						desc: { source: "credential", key: item.ref },
						url: String(urls[item.ref] ?? item.preset?.baseURL ?? "").trim(),
					});
				}
				for (const item of data.envKeys) {
					const tag = "e:" + item.name;
					out.push({
						tag, label: item.preset?.name || item.name,
						desc: { source: "env", key: item.name },
						url: String(urls[item.name] ?? item.preset?.baseURL ?? "").trim(),
					});
				}
				for (const item of data.files) {
					const tag = "f:" + item.path;
					out.push({
						tag, label: item.preset?.name || "手动添加的位置",
						desc: { source: "file", path: item.absolutePath },
						url: String(urls[item.absolutePath] ?? item.preset?.baseURL ?? "").trim(),
					});
				}
				for (const item of data.auto || []) {
					const tag = "auto:" + item.path + "#" + item.jsonPath.join(".");
					out.push({
						tag,
						label: item.name || item.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || "配置文件接口",
						desc: { source: "file", path: item.path, jsonPath: item.jsonPath },
						url: String(urls[tag] ?? item.baseURL ?? "").trim(),
					});
				}
				return out;
			};

			const verifyNow = async (tag, desc, url) => {
				if (!/^https?:\/\//i.test(url)) {
					setChecks((c) => ({ ...c, [tag]: { state: "nourl", url } }));
					return;
				}
				setChecks((c) => ({ ...c, [tag]: { state: "checking", url } }));
				let next = null;
				try { next = await call(base, "/api/discover/verify", { ...desc, baseURL: url }); } catch (e) {
					setChecks((c) => ({ ...c, [tag]: { state: "fail", url, error: String(e && e.message ? e.message : e) } }));
					return;
				}
				setChecks((c) => ({
					...c,
					[tag]: next && next.ok
						? { state: "ok", url, models: (next.models || []).length }
						: { state: "fail", url, error: (next && next.error) || "调不通" },
				}));
			};

			// Re-verify on open and whenever a Base URL is edited (debounced).
			useEffect(() => {
				if (!data) return undefined;
				const timer = setTimeout(() => {
					for (const item of candidates()) {
						const prev = checks[item.tag];
						if (prev && prev.state === "checking") continue;
						if (prev && prev.url && prev.url === item.url) continue;
						if (!item.url && prev && prev.state === "nourl") continue;
						verifyNow(item.tag, item.desc, item.url);
					}
				}, 400);
				return () => clearTimeout(timer);
			}, [data, urls, checks]);

			const rowState = (tag, url) => {
				if (!url) return { kind: "nourl" };
				const c = checks[tag];
				if (!c || c.state === "checking" || c.url !== url) return { kind: "checking" };
				if (c.state === "ok") {
					return { kind: "ok", text: c.models ? "可调通 · " + c.models + " 个模型" : "可调通" };
				}
				return { kind: "fail", text: "调不通", error: c.error };
			};

			const chip = (st) => {
				const tone = st.kind === "ok" ? "53,196,107" : st.kind === "fail" ? "242,85,90" : "255,255,255";
				const alpha = st.kind === "ok" || st.kind === "fail" ? 0.35 : 0.1;
				return h("span", {
					style: {
						fontSize: "11px", padding: "2px 7px", borderRadius: "999px", flexShrink: 0,
						color: st.kind === "ok" ? "#7ee2a8" : st.kind === "fail" ? "#ff9a9d" : "#aeb7c8",
						background: "rgba(" + tone + ",.14)", border: "1px solid rgba(" + tone + "," + alpha + ")",
						whiteSpace: "nowrap",
					},
				}, st.kind === "checking" ? "检测中…" : st.kind === "nourl" ? "缺 Base URL" : st.text);
			};

			const doImport = async (tag, desc, url, label) => {
				setError("");
				setBusy(tag);
				try {
					const next = await call(base, "/api/discover/import", { ...desc, baseURL: url });
					if (next && next.error) {
						setError(next.error);
						setChecks((c) => ({ ...c, [tag]: { state: "fail", url, error: next.error } }));
						return;
					}
					onImported(next);
					onNotice(label + " 已导入");
					await load();
				} finally {
					setBusy("");
				}
			};

			const renderRow = (opts) => {
				const st = rowState(opts.tag, opts.url);
				const ok = st.kind === "ok";
				return h("div", { key: opts.tag, style: D.findRow },
					h("div", { style: { flex: 1, minWidth: 0 } },
						h("div", { style: D.findName }, opts.title),
						h("div", { style: D.findMeta }, opts.meta),
						opts.note ? h("div", { style: { ...S.hint, fontSize: "11px" } }, opts.note) : null,
						st.kind === "fail" && st.error ? h("div", { style: { fontSize: "11px", color: "#ff9a9d", marginTop: "2px" } }, st.error) : null),
					h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 } },
						opts.onUrl ? h("input", {
							style: { ...D.input, width: opts.width || "220px" },
							placeholder: "Base URL",
							value: opts.url,
							onChange: (e) => opts.onUrl(e.target.value),
						}) : null,
						chip(st),
						h("button", {
							className: "ahb",
							style: ok ? S.btnPrimary : { ...S.btn, opacity: 0.45 },
							disabled: busy === opts.tag || !ok,
							onClick: () => doImport(opts.tag, opts.desc, opts.url, opts.label),
						}, busy === opts.tag ? "导入中…" : "导入"),
						st.kind === "fail" ? h("button", {
							className: "ahb",
							style: { ...S.btn, padding: "3px 8px", fontSize: "11px" },
							onClick: () => verifyNow(opts.tag, opts.desc, opts.url),
						}, "重试") : null));
			};

			const importSkill = async (skill) => {
				setError("");
				setBusy("skill:" + skill.id);
				try {
					const next = await call(base, "/api/skills/import", { from: skill.path, id: skill.id });
					if (next && next.error) { setError(next.error); return; }
					onSkills(next.skills || []);
					onNotice(skill.name + " 已复制到 DSH 技能目录");
					await load();
				} finally {
					setBusy("");
				}
			};

			const rows = [];
			if (data) {
				const keyed = [];
				for (const item of data.credentials) {
					const tag = "c:" + item.ref;
					keyed.push(renderRow({
						tag, label: item.preset?.name || item.ref,
						title: item.preset?.name || item.ref,
						meta: "凭据库 refs." + item.ref + " · " + item.masked,
						desc: { source: "credential", key: item.ref },
						url: String(urls[item.ref] ?? item.preset?.baseURL ?? "").trim(),
						onUrl: item.preset ? null : (v) => setUrls((u) => ({ ...u, [item.ref]: v })),
					}));
				}
				for (const item of data.envKeys) {
					keyed.push(renderRow({
						tag: "e:" + item.name, label: item.preset?.name || item.name,
						title: item.preset?.name || item.name,
						meta: "环境变量 " + item.name + " · " + item.masked,
						desc: { source: "env", key: item.name },
						url: String(urls[item.name] ?? item.preset?.baseURL ?? "").trim(),
						onUrl: item.preset ? null : (v) => setUrls((u) => ({ ...u, [item.name]: v })),
					}));
				}
				for (const item of data.files) {
					// Only locations the user added by hand; default folders are covered
					// by the generic scan below.
					keyed.push(renderRow({
						tag: "f:" + item.path, label: item.preset?.name || "手动添加的位置",
						title: item.preset?.name || "手动添加的位置",
						meta: item.path + " · " + item.masked,
						desc: { source: "file", path: item.absolutePath },
						url: String(urls[item.absolutePath] ?? item.preset?.baseURL ?? "").trim(),
						onUrl: item.preset ? null : (v) => setUrls((u) => ({ ...u, [item.absolutePath]: v })),
					}));
				}

				const autoRows = (data.auto || []).map((item) => {
					const tag = "auto:" + item.path + "#" + item.jsonPath.join(".");
					return renderRow({
						tag, width: "200px",
						label: item.name || item.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || "配置文件接口",
						title: item.name || item.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || "配置文件",
						meta: item.path + " · " + item.jsonPath.join(".") + " · " + item.masked,
						note: item.hint ? "按名字或路径推断：" + item.hint.name : null,
						desc: { source: "file", path: item.path, jsonPath: item.jsonPath },
						url: String(urls[tag] ?? item.baseURL ?? "").trim(),
						onUrl: (v) => setUrls((u) => ({ ...u, [tag]: v })),
					});
				});

				const skillRows = data.skills.map((skill) => h("div", { key: "s:" + skill.id, style: D.findRow },
					h("div", { style: { flex: 1, minWidth: 0 } },
						h("div", { style: D.findName }, skill.name),
						h("div", { style: D.findMeta },
							(SKILL_SOURCE_LABEL[skill.source] || skill.source) + " · "
							+ skill.files + " 个文件 · " + fmtBytes(skill.bytes) + " · " + skill.description.slice(0, 70))),
					h("button", {
						className: "ahb", style: S.btn,
						disabled: busy === "skill:" + skill.id,
						onClick: () => importSkill(skill),
					}, busy === "skill:" + skill.id ? "复制中…" : "复制到 DSH")));

				if (keyed.length) {
					rows.push(h("div", { key: "h:keys", style: D.sectionTitle }, "接口　" + keyed.length + " 个"));
					rows.push(...keyed);
				}
				if (autoRows.length) {
					rows.push(h("div", { key: "h:auto", style: D.sectionTitle }, "其它配置文件　" + autoRows.length + " 个"));
					rows.push(...autoRows);
				}
				if (skillRows.length) {
					rows.push(h("div", { key: "h:skills", style: D.sectionTitle }, "技能　" + skillRows.length + " 个"));
					rows.push(...skillRows);
				}
				if (data.skillsSkipped) {
					rows.push(h("div", { key: "h:skills-skip", style: { ...S.hint, fontSize: "11.5px" } },
						"另有 " + data.skillsSkipped + " 个目录的 SKILL.md 缺少 name / description，DSH 加载不了，已跳过。"));
				}
			}

			const empty = data && !rows.length;

			const addSource = async () => {
				setError("");
				const next = await call(base, "/api/discover/sources", form);
				if (next && next.error) { setError(next.error); return; }
				setData(next);
				setForm({ ...form, path: "", baseURL: "", name: "" });
				onNotice("扫描位置已添加");
			};

			const removeSource = async (type, path) => {
				setError("");
				const next = await call(base, "/api/discover/sources/remove", { type, path });
				if (next && next.error) { setError(next.error); return; }
				setData(next);
				onNotice("扫描位置已移除");
			};

			return h(Dialog, { title: "检索本机", onClose },
				h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
					h("div", { style: S.hint }, "只列出本机已有、但面板里还没有的接口和技能。默认只扫 DSH 自己的目录（~/.dsh）；每一行都会真的调一次这个接口，调通了「导入」才可点——地址或 Key 不对的进不来。"),
					!data && !error ? h("div", { style: S.hint }, "正在扫描…") : null,
					error ? h("div", { style: { ...S.hint, color: "#ff9a9d" } }, error) : null,
					empty ? h("div", { style: S.hint }, "没有发现新的接口或技能——DSH 自己的目录里都已经在面板里了。放在别处的，可以在下面手动添加扫描位置。") : null,
					rows.length ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, rows) : null,
					data ? h(ScanScopeBlock, { data, form, setForm, onAdd: addSource, onRemove: removeSource }) : null));
		}

		// DSH itself can only call a model it knows about, and it learns new ones
		// from its own settings section. This bar is that bridge: what the panel
		// would hand over, what it cannot, and one button that writes it.
		function DshRouteBar({ plan, note, error, busy, onSync }) {
			if (!plan) return null;
			const routes = plan.routes || [];
			const skipped = plan.skipped || [];
			const models = routes.reduce((sum, route) => sum + route.models.length, 0);
			const ready = routes.length > 0;
			const detail = skipped.length
				? "没接：" + skipped.map((s) => s.name + "（" + s.why + "）").join("　")
				: "";
			const state = error
				? { text: error, color: "#ff9a9d" }
				: note
					? { text: note, color: "#7fd38f" }
					: detail
						? { text: detail, color: "#7c8598" }
						: null;
			return h("div", {
				style: {
					display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
					padding: "8px 12px", background: "rgba(255,255,255,.03)",
					border: "1px solid " + T.line, borderRadius: "10px",
				},
			},
				h("span", { style: S.tagFor("文本") }, "DSH 模型"),
				h("span", { style: { color: "#d6dded", fontSize: "12.5px", fontWeight: 500 } },
					ready
						? routes.length + " 个接口 · " + models + " 个模型可以进 DSH 的模型选择器"
						: "还没有能接进来的对话接口"),
				state ? h("span", {
					style: {
						flex: 1, minWidth: 0, fontSize: "11.5px", color: state.color,
						overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
					},
					title: state.text,
				}, state.text) : h("span", { style: { flex: 1 } }),
				plan.settings
					? h("button", {
						className: "ahb",
						style: { ...S.btnPrimary, opacity: ready ? 1 : .45 },
						disabled: busy || !ready,
						title: ready ? "把上面这些接口写进 DSH 的模型路由，之后在对话里就能选到它们" : "先启用一个对话接口、探测一次模型列表",
						onClick: onSync,
					}, busy ? "接入中…" : "接入 DSH")
					: h("span", { style: S.hint }, "重启 DSH 后可接入"))
		}

		function ApiHubPanel({ base, onNotice }) {
			const [tab, setTab] = useState("providers");
			const [state, setState] = useState(null);
			const [skills, setSkills] = useState([]);
			const [balances, setBalances] = useState({});
			const [error, setError] = useState("");
			const [dialog, setDialog] = useState(null);
			const [discoverOpen, setDiscoverOpen] = useState(false);
			const [dragId, setDragId] = useState(null);
			const [overId, setOverId] = useState(null);
			const [side, setSide] = useState(null);
			const [skillDragId, setSkillDragId] = useState(null);
			const [skillOverId, setSkillOverId] = useState(null);
			const [skillSide, setSkillSide] = useState(null);
			const [skillView, setSkillView] = useState(null);
			const [skillDelete, setSkillDelete] = useState(null);
			const [skillTags, setSkillTags] = useState([]);
			const [tagFilter, setTagFilter] = useState(null);
			const [tagDialog, setTagDialog] = useState(null);
			const [providerDelete, setProviderDelete] = useState(null);
			const [plan, setPlan] = useState(null);
			const [syncNote, setSyncNote] = useState("");
			const [syncError, setSyncError] = useState("");
			const [syncing, setSyncing] = useState(false);

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
					setSkillTags(next.tags || []);
				} catch (e) { setError(String(e && e.message ? e.message : e)); }
			}, [base]);

			useEffect(() => { load(); loadSkills(); }, [load, loadSkills]);

			const loadPlan = useCallback(async () => {
				try {
					const next = await call(base, "/api/dsh/plan");
					setPlan(next && !next.error ? next : null);
				} catch { setPlan(null); }
			}, [base]);

			useEffect(() => { loadPlan(); }, [loadPlan]);

			const syncRoutes = useCallback(async () => {
				setSyncing(true);
				setSyncError("");
				setSyncNote("");
				try {
					const next = await call(base, "/api/dsh/sync", {});
					if (next && next.error) setSyncError(String(next.error));
					else setSyncNote("已接入 " + next.routes + " 个接口的 " + next.models + " 个模型；到 DSH 设置 → 模型里启用它们");
				} catch (e) {
					setSyncError(String(e && e.message ? e.message : e));
				} finally {
					setSyncing(false);
					loadPlan();
				}
			}, [base, loadPlan]);

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

			const renameProvider = useCallback(async (p, name) => {
				let next;
				try {
					next = await call(base, "/api/providers/rename", { id: p.id, name });
				} catch (e) {
					return String(e && e.message ? e.message : e);
				}
				if (next && next.error) return String(next.error);
				setState(next);
				onNotice("已改名为 " + name);
				return "";
			}, [base, onNotice]);

			// Keys are edited inside the card now, so the same rule as renaming
			// applies: any refusal comes back as text the card can show, instead of
			// a dialog that has already closed over the reason.
			const saveKey = useCallback(async (p, key) => {
				let next;
				try {
					next = await call(base, "/api/key", { id: p.id, key });
				} catch (e) {
					return String(e && e.message ? e.message : e);
				}
				if (next && next.error) return String(next.error);
				setState(next);
				onNotice(p.name + " 的 Key 已更新");
				return "";
			}, [base, onNotice]);

			const toggleSkill = useCallback(async (skill, enabled) => {
				const next = await call(base, "/api/skills/toggle", { id: skill.id, enabled });
				if (next && next.error) return setError(next.error);
				setSkills(next.skills || []);
				onNotice(skill.name + (enabled ? " 已启用" : " 已停用"));
			}, [base, onNotice]);

			const reorder = useCallback(async (fromId, toId, where) => {
				const ids = providers.map((p) => p.id).filter((id) => id !== fromId);
				const at = ids.indexOf(toId);
				if (at === -1) return;
				ids.splice(at + (where === "right" ? 1 : 0), 0, fromId);
				const next = await call(base, "/api/providers/reorder", { order: ids });
				if (next && next.error) return setError(String(next.error));
				setState(next);
				onNotice("顺序已保存");
			}, [base, onNotice, providers]);

			const drag = {
				draggingId: dragId,
				overId,
				side,
				onStart: (id) => { setDragId(id); setOverId(null); },
				onOver: (id, where) => {
					if (dragId === null || id === dragId) { setOverId(null); return; }
					setOverId(id); setSide(where);
				},
				onEnd: () => { setDragId(null); setOverId(null); setSide(null); },
				onDrop: (id) => {
					const from = dragId;
					const where = side;
					setDragId(null); setOverId(null); setSide(null);
					if (from && from !== id) reorder(from, id, where);
				},
			};

			// Skills move the same way providers do. The move is computed on the full
			// list, so dragging inside a tag filter still lands where the gap looked
			// like it was instead of only reshuffling the visible subset.
			const reorderSkills = useCallback(async (fromId, toId, where) => {
				const ids = skills.map((s) => s.id).filter((id) => id !== fromId);
				const at = ids.indexOf(toId);
				if (at === -1) return;
				ids.splice(at + (where === "right" ? 1 : 0), 0, fromId);
				const next = await call(base, "/api/skills/reorder", { order: ids });
				if (next && next.error) return setError(String(next.error));
				setSkills(next.skills || []);
				onNotice("技能顺序已保存");
			}, [base, onNotice, skills]);

			const skillDrag = {
				draggingId: skillDragId,
				overId: skillOverId,
				side: skillSide,
				onStart: (id) => { setSkillDragId(id); setSkillOverId(null); },
				onOver: (id, where) => {
					if (skillDragId === null || id === skillDragId) { setSkillOverId(null); return; }
					setSkillOverId(id); setSkillSide(where);
				},
				onEnd: () => { setSkillDragId(null); setSkillOverId(null); setSkillSide(null); },
				onDrop: (id) => {
					const from = skillDragId;
					const where = skillSide;
					setSkillDragId(null); setSkillOverId(null); setSkillSide(null);
					if (from && from !== id) reorderSkills(from, id, where);
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
				setSkillTags(next.tags || []);
				setSkillDelete(null);
				onNotice(skill.name + " 已删除");
			}, [base, onNotice]);

			const renameSkill = useCallback(async (skill, name) => {
				let next;
				try {
					next = await call(base, "/api/skills/rename", { id: skill.id, name });
				} catch (e) {
					return String(e && e.message ? e.message : e);
				}
				if (next && next.error) return String(next.error);
				setSkills(next.skills || []);
				setSkillTags(next.tags || []);
				onNotice("已改名为 " + name);
				return "";
			}, [base, onNotice]);

			const saveSkillTags = useCallback(async (skill, tags) => {
				let next;
				try {
					next = await call(base, "/api/skills/tags", { id: skill.id, tags });
				} catch (e) {
					return String(e && e.message ? e.message : e);
				}
				if (next && next.error) return String(next.error);
				setSkills(next.skills || []);
				setSkillTags(next.tags || []);
				onNotice(skill.name + " 的标签已保存");
				return "";
			}, [base, onNotice]);

			const head = h("div", { style: { ...S.bar, gap: "10px" } },
				h("div", { style: S.segmented },
					h("button", { className: "ahb", style: S.tab(tab === "providers"), onClick: () => setTab("providers") },
					"接口 " + (providers.length ? providers.filter((p) => p.enabled).length + "/" + providers.length : "")),
					h("button", { className: "ahb", style: S.tab(tab === "skills"), onClick: () => setTab("skills") },
						"技能 " + (skills.length ? skills.filter((s) => s.enabled).length + "/" + skills.length : ""))),
				h("span", { style: { flex: 1 } }),
				h("span", { style: { color: "#7c8598" } },
					"默认文本 " + (defaults.llm || "—") + "　默认图片 " + (defaults.image || "—")),
				h("button", { className: "ahb", style: S.btn, onClick: () => setDiscoverOpen(true) }, "检索"),
				h("button", { className: "ahb", style: S.btnPrimary, onClick: () => setDialog({ type: "add" }) }, "＋ 添加接口"),
				h("button", { className: "ahb", style: S.btn, onClick: () => { load(); loadSkills(); } }, "刷新"));

			// A card lights up when it is the drop target, or when its edge faces the
			// gap the dragged card would slide into. Both sides of the gap show, so
			// the insertion point reads as a real slot rather than a floating hint.
			const overIndex = providers.findIndex((x) => x.id === overId);
			const edgeFor = (index) => {
				if (!dragId || overIndex < 0 || providers[index].id === dragId) return null;
				if (index === overIndex) return side;
				if (side === "left" && index === overIndex - 1) return "right";
				if (side === "right" && index === overIndex + 1) return "left";
				return null;
			};

			const visibleSkills = tagFilter === null
				? skills
				: tagFilter === "__none__"
					? skills.filter((s) => !(s.tags || []).length)
					: skills.filter((s) => (s.tags || []).includes(tagFilter));
			const skillOverIndex = visibleSkills.findIndex((x) => x.id === skillOverId);
			const skillEdgeFor = (index) => {
				if (!skillDragId || skillOverIndex < 0 || visibleSkills[index].id === skillDragId) return null;
				if (index === skillOverIndex) return skillSide;
				if (skillSide === "left" && index === skillOverIndex - 1) return "right";
				if (skillSide === "right" && index === skillOverIndex + 1) return "left";
				return null;
			};

			const body = tab === "providers"
				? h("div", { style: S.grid },
					providers.length === 0
						? (state
							? h(EmptyState, {
								title: "还没有接口",
								hint: "点右上角「＋ 添加接口」，或者用「检索」把本机已有的接口和 Key 扫进来。",
								action: h("button", {
									className: "ahb",
									style: { ...S.btnPrimary, marginTop: "4px" },
									onClick: () => setDialog({ type: "add" }),
								}, "＋ 添加接口"),
							})
							: h(EmptyState, { title: "加载中…" }))
						: providers.map((p, index) => h(ProviderCard, {
							key: p.id, provider: p, balances,
							onTest: testProvider, onToggle: toggleProvider,
							onDefault: makeDefault, onBalance: refreshBalance,
							onModels: (provider) => setDialog({ type: "models", provider }),
							onKeySave: saveKey,
							onRequest: (provider) => setDialog({ type: "request", provider }),
							onRename: renameProvider,
							onRemove: (provider) => setProviderDelete(provider),
							drag, edge: edgeFor(index),
						})))
				: h(React.Fragment, null,
					h("div", { style: { ...S.hint, padding: "0 22px 8px" } },
						"列出 DSH 会加载的全部技能：~/.dsh/skills、~/.agents/skills，以及项目里的 .dsh/skills。面板只移动 ~/.dsh/skills 里的那几个。"),
					h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", padding: "0 22px 10px", alignItems: "center" } },
						...(() => {
							const counts = new Map();
							let untagged = 0;
							for (const s of skills) {
								const list = s.tags || [];
								if (!list.length) untagged += 1;
								for (const tag of list) counts.set(tag, (counts.get(tag) || 0) + 1);
							}
							const chip = (key, label, active, onClick) => h("span", {
								key,
								style: { ...S.tag, cursor: "pointer", padding: "2px 8px", fontSize: "12px", borderRadius: "6px", ...(active ? { color: "#111418", background: "#e9ecf1", borderColor: "#e9ecf1" } : null) },
								onClick,
							}, label);
							return [
								chip("all", "全部 " + skills.length, tagFilter === null, () => setTagFilter(null)),
								skillTags.map((tag) => chip("t:" + tag, tag + " " + (counts.get(tag) || 0), tagFilter === tag, () => setTagFilter(tagFilter === tag ? null : tag))),
								untagged ? chip("none", "未分类 " + untagged, tagFilter === "__none__", () => setTagFilter(tagFilter === "__none__" ? null : "__none__")) : null,
								skillTags.length ? null : h("span", { key: "hint", style: S.hint }, "给技能打上标签，就能在这里按标签筛选"),
							];
						})()),
					h("div", { style: S.grid },
						(() => {
							if (!skills.length) {
								return h(EmptyState, {
									title: "还没有技能",
									hint: "把技能放进 ~/.dsh/skills（或 ~/.agents/skills），或者用「检索」导入 —— 刷新后它们会出现在这里。",
								});
							}
							if (!visibleSkills.length) return h(EmptyState, { title: "这个标签下没有技能" });
							return visibleSkills.map((s, index) => h(SkillRow, {
								key: s.id, skill: s, onToggle: toggleSkill,
								onView: (skill) => setSkillView(skill),
								onRename: renameSkill,
								onTags: (skill) => setTagDialog(skill),
								onRemove: (skill) => setSkillDelete(skill),
								drag: skillDrag, edge: skillEdgeFor(index),
							}));
						})()));

			return h(React.Fragment, null,
				head,
				h("div", { style: { padding: "10px 22px 12px" } },
					h(DshRouteBar, { plan, note: syncNote, error: syncError, busy: syncing, onSync: syncRoutes })),
				error ? h("div", { style: { ...S.hint, color: "#ff9a9d", padding: "6px 14px" } }, error) : null,
				h("div", { className: "ahscroll", style: S.body }, body),
				dialog && dialog.type === "models"
					? h(ModelDialog, {
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
				discoverOpen
					? h(DiscoverDialog, {
						base,
						onClose: () => setDiscoverOpen(false),
						onNotice,
						onImported: (next) => { if (next && next.providers) setState(next); },
						onSkills: (list) => { setSkills(list); loadSkills(); },
					})
					: null,
				skillView
					? h(SkillViewDialog, { skill: skillView, base, onClose: () => setSkillView(null) })
					: null,
				tagDialog
					? h(TagDialog, {
						skill: skills.find((s) => s.id === tagDialog.id) || tagDialog,
						allTags: skillTags,
						onSave: saveSkillTags,
						onClose: () => setTagDialog(null),
					})
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
			// DSH's own page headers are a title and a subtitle over a hairline —
			// no icon plate, no gradient. Match that and let the cards carry depth.
			return h("div", {
				style: {
					margin: "0 0 14px", padding: "20px 22px 15px",
					borderBottom: "1px solid " + T.line,
				},
			},
				h("div", { style: { fontSize: "19px", fontWeight: 600, color: T.ink, letterSpacing: ".2px", lineHeight: 1.3 } }, "API Hub"),
				h("div", { style: { ...S.hint, marginTop: "2px", fontSize: "12.5px" } }, "本地接口与技能管理"));
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
			if (!base) {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
					h("div", { style: S.hint }, "连不上面板服务（页面协议 " + location.protocol + "）。DSH 的 /api-hub 路由没有响应，通常是插件宿主半侧没加载或版本不匹配。"),
					h("div", { style: { ...S.hint, fontFamily: MONO, fontSize: "11.5px", lineHeight: 1.7, whiteSpace: "pre-line" } },
						probeReasons.length ? probeReasons.join("\n") : CANDIDATES.join("\n")),
					h("div", { style: S.hint }, "排查：确认 profile 的 dsh.profile.bundles 含 dsh-api-hub，且安装的是 v0.3.4 或更新的包。"));
			}

			return h("div", { style: { position: "relative", minHeight: "420px" } },
				h(ApiHubPageHeader),
				h(ApiHubPanel, { base, onNotice: setNotice }),
				notice
					? h("div", {
						className: "ahtoast",
						style: {
							position: "absolute", left: "50%", bottom: "14px", transform: "translateX(-50%)",
							background: "rgba(32,39,53,.92)", border: "1px solid rgba(255,255,255,.12)",
							borderRadius: "12px", padding: "9px 16px", fontSize: "12.5px", color: "#e9edf5",
							boxShadow: "0 12px 32px rgba(0,0,0,.45)", backdropFilter: "blur(8px)",
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
		// Test hook: the candidate list depends on the page environment.
		exports.__baseCandidates = () => CANDIDATES.slice();
		exports.inject = inject;
		// Test hooks: render checks mount these directly with fake data.
		exports.__components = { ApiHubPanel, ProviderCard, SkillRow, Switch, Dialog, ModelDialog, AddProviderDialog, RequestDialog, SkillViewDialog, ConfirmDialog, ApiHubSettingsPage, HubIcon, ApiHubPageHeader, DiscoverDialog, ScanScopeBlock, TagDialog, DshRouteBar, EmptyState };
		return module.exports;
	},
});
