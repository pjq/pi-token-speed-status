/**
 * Token Speed (real-time + 10-second average)
 *
 * Shows two throughput numbers in the footer while the assistant streams:
 *   ⚡ TPS 24.3 tok/s 18.2 tok/s (10s)
 *
 * - "now"  = tokens in the last ~2s (true real-time throughput)
 * - "10s"  = tokens generated in the last 10s (stable average; catches
 *            slowdowns that a short window smooths over)
 *
 * The 10s window resets per request so tool-execution gaps (bash, file
 * reads, ...) don't drag the average down. When the turn ends the footer
 * shows the turn total: "✓ 4321 tok / 38.2s = 113 tok/s (turn)".
 * During context compaction it shows "⚡ compacting…", then the
 * compaction's own speed ("⚡ compact ✓ 1234 tok / 25.3s = 48.8 tok/s").
 *
 * Install: pi install git:github.com/pjq/pi-token-speed-status
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REAL_WINDOW_MS = 2000;
const MIN_REAL_SPAN_MS = 500; // avoid dividing by a tiny span after burst flushes
const RECENT_WINDOW_MS = 10_000;
const MIN_RECENT_SPAN_MS = 1000;
const UPDATE_INTERVAL_MS = 100; // footer render throttle (pi-token-speed default: immediate; 100ms = snappy but bounded)
const COMPACTION_THRESHOLD = 256;

// Speed tiers + truecolor palette from pi-token-speed (15/30/45, hex colors)
const SLOW_HEX = "#ff4444";
const MEDIUM_HEX = "#ffaa00";
const FAST_HEX = "#00ff88";
const BLAZING_HEX = "#44ddff";

const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) =>
	parseInt(hex.slice(i, i + 2), 16),
) as [number, number, number];

const colorize = (text: string, tps: number): string => {
	const hex = tps < 15 ? SLOW_HEX : tps < 30 ? MEDIUM_HEX : tps < 45 ? FAST_HEX : BLAZING_HEX;
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
};

const TOKEN_GENERATION_TOOLS = new Set(["edit", "write"]);

interface TokEvent {
	time: number;
	tokens: number;
}

class Window {
	events: TokEvent[] = [];
	private head = 0;

	constructor(
		private readonly windowMs: number,
		private readonly minSpanMs: number,
	) {}

	record(tokens: number): void {
		if (tokens <= 0) return;
		this.events.push({ time: Date.now(), tokens });
		if (this.head >= COMPACTION_THRESHOLD) this.compact();
	}

	getTps(now: number): number {
		const start = now - this.windowMs;
		while (this.head < this.events.length && this.events[this.head].time < start) {
			this.head++;
		}
		if (this.head >= this.events.length) return 0;

		let tokens = 0;
		for (let i = this.head; i < this.events.length; i++) tokens += this.events[i].tokens;
		if (tokens === 0) return 0;

		// All tokens in one burst after a stall? Include the gap in the span.
		let spanStart = this.events[this.head].time;
		const allSame = this.events[this.head].time === this.events[this.events.length - 1].time;
		if (allSame && this.head > 0) spanStart = this.events[this.head - 1].time;

		return (1000 * tokens) / Math.max(now - spanStart, this.minSpanMs);
	}

	reset(): void {
		this.events.length = 0;
		this.head = 0;
	}

	private compact(): void {
		if (this.head === 0) return;
		this.events.splice(0, this.head);
		this.head = 0;
	}
}

export default function (pi: ExtensionAPI) {
	const real = new Window(REAL_WINDOW_MS, MIN_REAL_SPAN_MS);
	const recent = new Window(RECENT_WINDOW_MS, MIN_RECENT_SPAN_MS);

	let ctx: ExtensionContext | undefined;
	let streaming = false;
	let paused = false; // model idle while a tool runs
	let lastRender = 0;
	let lastReported: number | undefined;
	let lastLine: string | undefined; // last rendered values; footer is never blanked
	let turnStart = 0;

	const render = (forced = false) => {
		if (!ctx) return;
		const theme = ctx.ui.theme;
		if (!streaming) {
			// Keep the last known values visible (tool pause, compaction,
			// session rebind) instead of blanking the footer.
			const placeholder =
				lastLine ??
				`${theme.fg("accent", "⚡")} ${theme.fg("dim", "TPS — — tok/s — tok/s (10s)")}`;
			ctx.ui.setStatus("token-speed", placeholder);
			return;
		}
		const now = Date.now();
		if (!forced && now - lastRender < UPDATE_INTERVAL_MS) return;
		lastRender = now;

		const tpsNow = real.getTps(now);
		const tpsAvg = recent.getTps(now);
		const text =
			`${theme.fg("accent", "⚡")} ${theme.fg("dim", "TPS")} ` +
			`${colorize(`${tpsNow.toFixed(1)} tok/s`, tpsNow)} ` +
			`${colorize(`${tpsAvg.toFixed(1)} tok/s`, tpsAvg)}${theme.fg("dim", " (10s)")}`;
		lastLine = text;
		ctx.ui.setStatus("token-speed", text);
	};

	const stopStreaming = (forced = false) => {
		streaming = false;
		paused = false;
		recent.reset(); // next turn starts a clean 10s average
		render(forced);
	};

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		turnStart = Date.now();
		render(true); // restore the footer after a session replacement (compaction/resume)
	});

	pi.on("message_start", (event: any, c: ExtensionContext) => {
		ctx = c;
		if (event.message?.role === "user") {
			turnStart = Date.now();
			recent.reset(); // new request: start the 10s average fresh
		}
		if (event.message?.role === "assistant") {
			paused = false; // a tool finished, the model is generating again
		}
	});

	pi.on("message_update", (event: any, c: ExtensionContext) => {
		ctx = c;
		const ev = event.assistantMessageEvent;
		if (!ev || paused) return;
		const type = ev.type as string;

		if (type === "text_start" || type === "thinking_start" || type === "toolcall_start") {
			paused = false;
			if (!streaming) {
				streaming = true;
				recent.reset();
				lastRender = 0; // first delta of a new stream must paint immediately,
				// even if the previous render was <500ms ago (fast responses)
			}
			lastReported = undefined;
			return;
		}

		// Provider-reported cumulative output is authoritative when present;
		// fall back to a chars/4 estimate (local providers often omit it).
		let tokens = 0;
		if (type === "text_delta" || type === "thinking_delta") {
			const reported: number | undefined = ev.partial?.usage?.output;
			if (typeof reported === "number" && reported > 0) {
				tokens = reported - (lastReported ?? reported);
				lastReported = reported;
			} else if (typeof ev.delta === "string") {
				tokens = ev.delta.length / 4;
			}
		} else if (type === "toolcall_delta") {
			const call = ev.partial?.content?.[ev.contentIndex ?? 0];
			if (TOKEN_GENERATION_TOOLS.has(call?.name ?? "")) {
				tokens = typeof ev.delta === "string" ? ev.delta.length / 4 : 0;
			}
		}

		if (tokens > 0) {
			real.record(tokens);
			recent.record(tokens);
			render();
		}
	});

	pi.on("message_end", (event: any, c: ExtensionContext) => {
		ctx = c;
		if (event.message?.role === "assistant") render(true); // final values for this stream
	});

	pi.on("tool_result", (event: any, c: ExtensionContext) => {
		ctx = c;
		// Model is idle while the tool runs — pause both windows.
		streaming = false;
		paused = true;
		render(true);
	});

	let compactStart = 0;

	// Context compaction runs as an internal LLM call (no per-token message
	// events), so live TPS isn't possible — but we show an indicator while it
	// runs and its overall speed when it finishes.
	pi.on("session_before_compact", (_event: any, c: ExtensionContext) => {
		ctx = c;
		streaming = false;
		paused = true;
		compactStart = Date.now();
		recent.reset();
		ctx.ui.setStatus("token-speed", `${ctx.ui.theme.fg("accent", "⚡")} ${ctx.ui.theme.fg("dim", "compacting…")}`);
	});

	pi.on("session_compact", (event: any, c: ExtensionContext) => {
		ctx = c;
		paused = false;
		if (!compactStart) return;
		const secs = Math.max((Date.now() - compactStart) / 1000, 0.1);
		const entry = event.compactionEntry ?? {};
		const tok =
			typeof entry.usage?.output === "number" && entry.usage.output > 0
				? entry.usage.output
				: (entry.summary?.length ?? 0) / 4;
		const tps = tok / secs;
		lastLine =
			`${ctx.ui.theme.fg("accent", "⚡")} compact ${ctx.ui.theme.fg("success", "✓")} ` +
			`${ctx.ui.theme.fg("dim", `${Math.round(tok)} tok / ${secs.toFixed(1)}s = `)}` +
			colorize(`${tps.toFixed(1)} tok/s`, tps);
		ctx.ui.setStatus("token-speed", lastLine);
	});

	pi.on("session_compact_failed", (_event: any, c: ExtensionContext) => {
		ctx = c;
		paused = false;
		compactStart = 0;
		render(true); // back to placeholder / last values
	});

	pi.on("agent_end", (event: any, c: ExtensionContext) => {
		ctx = c;
		const total = (event.messages ?? []).reduce(
			(acc: number, m: any) => acc + (m.role === "assistant" ? (m.usage?.output ?? 0) : 0),
			0,
		);
		stopStreaming(true);
		if (total <= 0) return;
		const secs = Math.max((Date.now() - turnStart) / 1000, 0.1);
		const tps = total / secs;
		lastLine =
			`${ctx.ui.theme.fg("accent", "⚡")} ${ctx.ui.theme.fg("dim", "TPS")} ` +
			`${ctx.ui.theme.fg("success", "✓")} ${ctx.ui.theme.fg("dim", `${total} tok / ${secs.toFixed(1)}s = ${tps.toFixed(1)} tok/s (turn)`)}`;
		ctx.ui.setStatus("token-speed", lastLine);
	});
}
