import { describe, expect, it, vi } from "vitest";
import extension, {
	BLAZING_HEX,
	FAST_HEX,
	MEDIUM_HEX,
	PLACEHOLDER_LINE,
	REAL_WINDOW_MS,
	RECENT_WINDOW_MS,
	SLOW_HEX,
	Window,
	colorize,
	formatLine,
	hexToRgb,
} from "../token-speed.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dim = (t: string) => t;
const fg = (_c: string, t: string) => t; // strip colors for assertions

function mockCtx() {
	const set = vi.fn();
	return {
		ui: { setStatus: set, theme: { fg, dim } },
		set,
	};
}

function mockPi() {
	const handlers = new Map<string, any[]>();
	const pi: any = {
		on: (name: string, fn: any) => {
			const l = handlers.get(name) ?? [];
			l.push(fn);
			handlers.set(name, l);
		},
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerProvider: vi.fn(),
		unregister: vi.fn(),
		fire: (name: string, event: any, ctx: any = mockCtx()) => {
			for (const fn of handlers.get(name) ?? []) fn(event, ctx);
		},
	};
	return pi;
}

const msg = (role: string, content: any[] = []) => ({ role, content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

// ---------------------------------------------------------------------------
// Pure logic: Window
// ---------------------------------------------------------------------------

describe("Window", () => {
	it("averages tokens over the window", () => {
		const w = new Window(1000, 100);
		w.record(100, 1_000);
		w.record(100, 1_500);
		// span = now - first event = 1000ms → 200 tok / 1s
		expect(w.getTps(2_000)).toBeCloseTo(200, 0);
	});

	it("drops events outside the window", () => {
		const w = new Window(1000, 100);
		w.record(100, 1_000); // outside (now - 1000 = 1500)
		w.record(50, 2_000); // inside
		// single event in window → burst rule extends the span back to the
		// dropped event: 50 tok / 1.5s
		expect(w.getTps(2_500)).toBeCloseTo(33.3, 1);
	});

	it("returns 0 when the window is empty", () => {
		const w = new Window(1000, 100);
		w.record(100, 1_000);
		expect(w.getTps(10_000)).toBe(0);
	});

	it("clamps to minSpanMs for single-event windows", () => {
		const w = new Window(REAL_WINDOW_MS, 500);
		w.record(100, 1_000);
		// 100 tok / max(1000-1000=0 → 500ms) = 200 tok/s
		expect(w.getTps(1_000)).toBeCloseTo(200, 0);
	});

	it("extends the span across the previous event for single-timestamp bursts", () => {
		const w = new Window(2000, 500);
		w.record(10, 1_000);
		w.record(10, 1_200); // same timestamp as the first → burst after stall
		// span = 1200 - 1000 = 200ms → clamped to 500 → (20*1000)/500 = 40
		expect(w.getTps(1_200)).toBeCloseTo(40, 0);
	});

	it("ignores non-positive tokens", () => {
		const w = new Window(1000, 100);
		w.record(0, 1_000);
		w.record(-5, 1_000);
		expect(w.events).toHaveLength(0);
	});

	it("prunes old events at the compaction threshold", () => {
		const w = new Window(1000, 100);
		for (let i = 0; i < 400; i++) {
			w.record(1, 1_000 + i * 10);
			w.getTps(1_000 + i * 10); // advances head → compaction can prune
		}
		expect(w.events.length).toBeLessThan(400); // pruned, not unbounded
		expect(w.getTps(5_000)).toBeGreaterThan(0);
	});

	it("reset clears state", () => {
		const w = new Window(1000, 100);
		w.record(100, 1_000);
		w.reset();
		expect(w.events).toHaveLength(0);
		expect(w.getTps(5_000)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Pure logic: color + formatting
// ---------------------------------------------------------------------------

describe("colorize", () => {
	it("uses the pi-token-speed truecolor palette and thresholds", () => {
		expect(hexToRgb(SLOW_HEX)).toEqual([255, 68, 68]);
		expect(hexToRgb(MEDIUM_HEX)).toEqual([255, 170, 0]);
		expect(hexToRgb(FAST_HEX)).toEqual([0, 255, 136]);
		expect(hexToRgb(BLAZING_HEX)).toEqual([68, 221, 255]);
		expect(colorize("x", 14.9)).toBe("\x1b[38;2;255;68;68mx\x1b[39m");
		expect(colorize("x", 15)).toBe("\x1b[38;2;255;170;0mx\x1b[39m");
		expect(colorize("x", 30)).toBe("\x1b[38;2;0;255;136mx\x1b[39m");
		expect(colorize("x", 45)).toBe("\x1b[38;2;68;221;255mx\x1b[39m");
	});
});

describe("formatLine", () => {
	it("renders both rates with labels", () => {
		expect(formatLine(fg, 24.31, 18.27)).toContain("⚡");
		expect(formatLine(fg, 24.31, 18.27)).toContain("24.3 tok/s");
		expect(formatLine(fg, 24.31, 18.27)).toContain("18.3 tok/s");
		expect(formatLine(fg, 24.31, 18.27)).toContain("(10s)");
	});

	it("placeholder is a valid dim line", () => {
		expect(PLACEHOLDER_LINE(fg)).toContain("— —");
	});
});

// ---------------------------------------------------------------------------
// Extension behavior
// ---------------------------------------------------------------------------

describe("extension", () => {
	const setup = () => {
		const pi = mockPi();
		const ctx = mockCtx();
		extension(pi);
		return { pi, ctx };
	};

	it("shows the placeholder before the first stream", () => {
		const { pi, ctx } = setup();
		pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const last = ctx.set.mock.calls.at(-1)![1] as string;
		expect(last).toContain("⚡");
		expect(last).toContain("— —");
	});

	it("does not show zero rates before the first token", () => {
		const { pi, ctx } = setup();
		pi.fire("message_start", { type: "message_start", message: msg("assistant") }, ctx);
		const line = ctx.set.mock.calls.at(-1)![1] as string;
		expect(line).toContain("— —");
		expect(line).not.toContain("0.0 tok/s");
	});
	it("streams live TPS for text deltas and never blanks", () => {
		const { pi, ctx } = setup();
		pi.fire("message_start", { type: "message_start", message: msg("assistant") }, ctx);
		for (let i = 0; i < 20; i++) {
			pi.fire(
				"message_update",
				{ type: "message_update", message: msg("assistant", [{ type: "text_delta", delta: "x".repeat(40) }]) },
				ctx,
			);
		}
		const line = ctx.set.mock.calls.at(-1)![1] as string;
		expect(line).toContain("tok/s");
		expect(line).not.toContain("— —");
	});

	it("counts all tool-call argument generation (bash, not just edit/write)", () => {
		const { pi, ctx } = setup();
		pi.fire("message_start", { type: "message_start", message: msg("assistant") }, ctx);
		pi.fire(
			"message_update",
			{
				type: "message_update",
				message: msg("assistant", [
					{ type: "toolcall_delta", name: "bash", delta: { args: { command: "ls -la very-long-command-here" } } },
				]),
			},
			ctx,
		);
		const line = ctx.set.mock.calls.at(-1)![1] as string;
		expect(line).toContain("tok/s"); // recorded → footer updated
	});

	it("pauses during tool execution and resumes on the next assistant message", () => {
		const { pi, ctx } = setup();
		pi.fire("message_start", { type: "message_start", message: msg("assistant") }, ctx);
		pi.fire("message_update", { type: "message_update", message: msg("assistant", [{ type: "text_delta", delta: "x".repeat(80) }]) }, ctx);
		const before = ctx.set.mock.calls.length;
		pi.fire("tool_result", { type: "tool_result" }, ctx);
		// no update while paused
		pi.fire("message_update", { type: "message_update", message: msg("assistant", [{ type: "text_delta", delta: "y".repeat(80) }]) }, ctx);
		expect(ctx.set.mock.calls.length).toBe(before + 1); // only the pause render
		// resume with a fresh assistant message
		pi.fire("message_start", { type: "message_start", message: msg("assistant") }, ctx);
		pi.fire("message_update", { type: "message_update", message: msg("assistant", [{ type: "text_delta", delta: "z".repeat(80) }]) }, ctx);
		expect(ctx.set.mock.calls.length).toBeGreaterThan(before + 1);
	});

	it("uses provider-reported cumulative usage as the token source", () => {
		const { pi, ctx } = setup();
		pi.fire("message_start", { type: "message_start", message: msg("assistant") }, ctx);
		pi.fire(
			"message_update",
			{
				type: "message_update",
				message: { ...msg("assistant", [{ type: "text_delta", delta: "hello" }]), usage: { input: 10, output: 42, cacheRead: 0, cacheWrite: 0 } },
			},
			ctx,
		);
		const line = ctx.set.mock.calls.at(-1)![1] as string;
		expect(line).toContain("tok/s");
	});

	it("renders the turn summary at agent_end", () => {
		const { pi, ctx } = setup();
		pi.fire("message_start", { type: "message_start", message: msg("assistant") }, ctx);
		pi.fire(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "assistant", usage: { input: 5, output: 4000, cacheRead: 0, cacheWrite: 0 } }] },
			ctx,
		);
		const line = ctx.set.mock.calls.at(-1)![1] as string;
		expect(line).toContain("✓");
		expect(line).toContain("(turn)");
		expect(line).toContain("4000 tok");
	});

	it("shows the compaction indicator, then the compaction speed", () => {
		const { pi, ctx } = setup();
		pi.fire("session_before_compact", { type: "session_before_compact" }, ctx);
		expect(ctx.set.mock.calls.at(-1)![1]).toContain("compacting…");
		pi.fire(
			"session_compact",
			{ type: "session_compact", compactionEntry: { summary: "x".repeat(8000), usage: { input: 100, output: 2048, cacheRead: 0, cacheWrite: 0 } }, fromExtension: false, reason: "manual", willRetry: false },
			ctx,
		);
		const line = ctx.set.mock.calls.at(-1)![1] as string;
		expect(line).toContain("compact");
		expect(line).toContain("2048 tok");
		expect(line).toContain("tok/s");
	});

	it("falls back to summary length when compaction usage is absent", () => {
		const { pi, ctx } = setup();
		pi.fire("session_before_compact", { type: "session_before_compact" }, ctx);
		pi.fire(
			"session_compact",
			{ type: "session_compact", compactionEntry: { summary: "x".repeat(8000) }, fromExtension: false, reason: "threshold", willRetry: false },
			ctx,
		);
		const line = ctx.set.mock.calls.at(-1)![1] as string;
		expect(line).toContain("2000 tok"); // 8000 chars / 4 = 2000 tok
	});

	it("restores the footer after a session rebind", () => {
		const { pi, ctx } = setup();
		pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		pi.fire("message_start", { type: "message_start", message: msg("assistant") }, ctx);
		pi.fire("message_update", { type: "message_update", message: msg("assistant", [{ type: "text_delta", delta: "x".repeat(160) }]) }, ctx);
		const { ctx: ctx2 } = setup();
		pi.fire("session_start", { type: "session_start", reason: "resume" }, ctx2);
		const line = ctx2.set.mock.calls.at(-1)![1] as string;
		expect(line).toContain("⚡");
		expect(line).not.toBe("");
	});

	it("clears the footer on session shutdown", () => {
		const { pi, ctx } = setup();
		pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		expect(ctx.set.mock.calls.at(-1)![1]).toBeUndefined();
	});
});
