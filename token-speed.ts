/**
 * pi-token-speed-status
 *
 * A pi footer status extension showing token throughput:
 *   ⚡ TPS 24.3 tok/s 18.2 tok/s (10s)
 *
 * - first value: tokens in the last ~2s (true real-time throughput)
 * - (10s) value: tokens generated in the last 10s (stable average)
 * - color-coded with the pi-token-speed palette (red <15, orange <30,
 *   green <45, cyan ≥45 tok/s)
 * - turn total when a turn ends: "⚡ TPS ✓ 4321 tok / 38.2s = 113.1 tok/s (turn)"
 * - context compaction: "⚡ compacting…" while it runs, then
 *   "⚡ compact ✓ 1234 tok / 25.3s = 48.8 tok/s"
 * - the footer is never blanked — the last known values stay visible across
 *   tool pauses, compaction, and session rebinds
 *
 * Install: pi install npm:pi-token-speed-status
 */

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionStartEvent,
	ThemeColor,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

// Streaming content blocks as observed in message_update events. The SDK's
// public Content union models complete blocks (text | thinking | toolCall);
// delta variants (text_delta, thinking_delta, toolcall_delta) are emitted
// during streaming but are not part of that union, so they are typed here.
interface StreamBlock {
	type: string;
	name?: string;
	/** string for text/thinking deltas; partial args object for toolcall deltas. */
	delta?: any;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const REAL_WINDOW_MS = 2_000;
export const MIN_REAL_SPAN_MS = 500; // avoid dividing by a tiny span after burst flushes
export const RECENT_WINDOW_MS = 10_000;
export const MIN_RECENT_SPAN_MS = 1_000;
export const UPDATE_INTERVAL_MS = 100; // footer render throttle (snappy but bounded)
export const COMPACTION_THRESHOLD = 256; // bound event-array growth

// Speed tiers + truecolor palette from pi-token-speed (15/30/45, hex colors)
export const SLOW_HEX = "#ff4444";
export const MEDIUM_HEX = "#ffaa00";
export const FAST_HEX = "#00ff88";
export const BLAZING_HEX = "#44ddff";

/** Wrap text in an 8-bit truecolor SGR sequence derived from a #rrggbb hex. */
export const hexToRgb = (hex: string): [number, number, number] =>
	[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** Color a token-rate value using the pi-token-speed palette. */
export const colorize = (text: string, tps: number): string => {
	const hex = tps < 15 ? SLOW_HEX : tps < 30 ? MEDIUM_HEX : tps < 45 ? FAST_HEX : BLAZING_HEX;
	const [r, g, b] = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
};

// ---------------------------------------------------------------------------
// Sliding window
// ---------------------------------------------------------------------------

export interface TokEvent {
	time: number;
	tokens: number;
}

/**
 * Sliding time window over token-production events.
 *
 * - `getTps(now)` averages tokens over the window, clamped to `minSpanMs`.
 * - If every token arrived in a single timestamped burst (e.g. after a stall),
 *   the span is extended back to the previous event so the flush isn't
 *   reported as infinitely fast (same heuristic as pi-token-speed).
 * - Events beyond `COMPACTION_THRESHOLD` are pruned once they leave the window.
 */
export class Window {
	events: TokEvent[] = [];
	private head = 0;

	constructor(
		private readonly windowMs: number,
		private readonly minSpanMs: number,
	) {}

	record(tokens: number, now = Date.now()): void {
		if (tokens <= 0) return;
		this.events.push({ time: now, tokens });
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const formatRate = (text: string): string => `${text} tok/s`;

/** Dim "⚡" + dim "TPS" prefix plus the two colorized rates. */
export function formatLine(
	fg: (color: ThemeColor, text: string) => string,
	tpsNow: number,
	tpsAvg: number,
): string {
	return (
		`${fg("accent", "⚡")} ${fg("dim", "TPS")} ` +
		`${colorize(formatRate(tpsNow.toFixed(1)), tpsNow)} ` +
		`${colorize(formatRate(tpsAvg.toFixed(1)), tpsAvg)}${fg("dim", " (10s)")}`
	);
}

export const PLACEHOLDER_LINE = (fg: (color: ThemeColor, text: string) => string): string =>
	`${fg("accent", "⚡")} ${fg("dim", "TPS — — tok/s — tok/s (10s)")}`;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Best-effort output-token count for a streaming assistant message. */
function streamTokens(message: any, lastReported: number): { tokens: number; next: number } {
	let tokens = 0;
	let next = lastReported;
	const usage = message?.content?.[0]?.usage;
	if (usage && typeof usage.output === "number") {
		if (usage.output > lastReported) {
			tokens += usage.output - lastReported;
			next = usage.output;
		}
	} else if (typeof message?.content?.[0]?.text === "string") {
		tokens += message.content[0].text.length / 4; // rough estimate when no usage is reported
	}
	return { tokens, next };
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
	let compactStart = 0;

	const render = (forced = false) => {
		if (!ctx) return;
		const fg = ctx.ui.theme.fg.bind(ctx.ui.theme);
		if (!streaming) {
			// Keep the last known values visible (tool pause, compaction,
			// session rebind) instead of blanking the footer.
			ctx.ui.setStatus("token-speed", lastLine ?? PLACEHOLDER_LINE(fg));
			return;
		}
		// A message_start arrives before its first generated token. Do not
		// replace the useful last line with a misleading 0.0/0.0 reading.
		if (real.events.length === 0 && recent.events.length === 0) {
			ctx.ui.setStatus("token-speed", lastLine ?? PLACEHOLDER_LINE(fg));
			return;
		}
		const now = Date.now();
		if (!forced && now - lastRender < UPDATE_INTERVAL_MS) return;
		lastRender = now;

		const text = formatLine(fg, real.getTps(now), recent.getTps(now));
		lastLine = text;
		ctx.ui.setStatus("token-speed", text);
	};

	const stopStreaming = (forced = false) => {
		streaming = false;
		paused = false;
		recent.reset(); // next turn starts a clean 10s average
		render(forced);
	};

	// A new assistant message (or stream re-start on the same message) begins a
	// fresh generation segment.
	pi.on("message_start", (event: MessageStartEvent, c: ExtensionContext) => {
		ctx = c;
		if (event.message?.role === "assistant") {
			if (!streaming) {
				streaming = true;
				paused = false;
				turnStart = Date.now();
				lastRender = 0; // first render of a new stream must not be throttled
				recent.reset(); // new request: start the 10s average fresh
			}
			lastReported = event.message.usage?.output ?? 0;
			render(true);
		}
	});

	pi.on("message_update", (event: MessageUpdateEvent, c: ExtensionContext) => {
		ctx = c;
		if (paused || !streaming) return;
		if (event.message?.role !== "assistant") return;

		let { tokens, next } = streamTokens(event.message, lastReported ?? 0);
		lastReported = next;

		// Text, thinking, and tool-call args (bash commands, file writes, ...) —
		// all are generated output; delta blocks aren't in the SDK's Content union.
		for (const block of (event.message?.content ?? []) as StreamBlock[]) {
			if (block.type === "text_delta" || block.type === "thinking_delta") {
				tokens += block.delta.length / 4;
			} else if (block.type === "toolcall_delta" && block.delta?.args != null) {
				tokens += JSON.stringify(block.delta.args).length / 4;
			}
		}

		if (tokens > 0) {
			real.record(tokens);
			recent.record(tokens);
			render();
		}
	});

	pi.on("message_end", (event: MessageEndEvent, c: ExtensionContext) => {
		ctx = c;
		if (event.message?.role === "assistant") {
			// The stream for this message is done; the turn continues until
			// agent_end (there may be more assistant messages after tools).
			lastReported = undefined;
			render(true);
		}
	});

	pi.on("tool_result", (_event: ToolResultEvent, c: ExtensionContext) => {
		ctx = c;
		// Model is idle while the tool runs — pause both windows.
		streaming = false;
		paused = true;
		render(true);
	});

	pi.on("session_start", (event: SessionStartEvent, c: ExtensionContext) => {
		ctx = c;
		// On startup and on rebind (/new, /resume, compaction) render the
		// placeholder / last values so the footer is never blank.
		lastRender = 0;
		render(true);
	});

	pi.on("session_shutdown", (_event: unknown, c: ExtensionContext) => {
		ctx = c;
		ctx.ui.setStatus("token-speed", undefined);
	});

	// Context compaction runs as an internal LLM call (no per-token message
	// events), so live TPS isn't possible — but we show an indicator while it
	// runs and its overall speed when it finishes.
	pi.on("session_before_compact", (_event: SessionBeforeCompactEvent, c: ExtensionContext) => {
		ctx = c;
		streaming = false;
		paused = true;
		compactStart = Date.now();
		recent.reset();
		ctx.ui.setStatus("token-speed", `${ctx.ui.theme.fg("accent", "⚡")} ${ctx.ui.theme.fg("dim", "compacting…")}`);
	});

	pi.on("session_compact", (event: SessionCompactEvent, c: ExtensionContext) => {
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
			colorize(formatRate(tps.toFixed(1)), tps);
		ctx.ui.setStatus("token-speed", lastLine);
	});

	pi.on("session_compact_failed", (_event: SessionCompactFailedEvent, c: ExtensionContext) => {
		ctx = c;
		paused = false;
		compactStart = 0;
		render(true); // back to placeholder / last values
	});

	pi.on("agent_end", (event: AgentEndEvent, c: ExtensionContext) => {
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
