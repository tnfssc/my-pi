import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Particle = {
	x: number;
	y: number;
	vx: number;
	vy: number;
	char: string;
	color: string;
};

const CHARS = ["✦", "✧", "✹", "✺", "✻", "✼", "◆", "◇", "●", "○", "▲", "■", "▰", "▱"];
const COLORS = ["31", "32", "33", "34", "35", "36", "91", "92", "93", "94", "95", "96"];
const BASE_WIDTH = 100;
const FRAME_MS = 35;
const FRAMES = 144;
const PARTICLE_COUNT = 180;
const BURST_PARTICLES = 90;
const MAX_PARTICLES = 720;

function ansi(code: string, value: string): string {
	return `\x1b[${code}m${value}\x1b[0m`;
}

function choice<T>(values: readonly T[]): T {
	return values[Math.floor(Math.random() * values.length)]!;
}

function createParticles(count: number, height: number, originX = BASE_WIDTH / 2, originY = Math.max(2, Math.floor(height * 0.72))): Particle[] {
	return Array.from({ length: count }, () => ({
		x: originX + (Math.random() - 0.5) * 10,
		y: originY + (Math.random() - 0.5) * 2,
		vx: (Math.random() - 0.5) * 3.4,
		vy: -Math.random() * 2.5 - 0.4,
		char: choice(CHARS),
		color: choice(COLORS),
	}));
}

function createBurst(count: number, height: number, originX: number, originY: number): Particle[] {
	return Array.from({ length: count }, () => {
		const angle = Math.random() * Math.PI * 2;
		const speed = 0.6 + Math.random() * 2.6;
		return {
			x: originX + (Math.random() - 0.5) * 4,
			y: originY + (Math.random() - 0.5) * 2,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed - Math.random() * 0.8,
			char: choice(CHARS),
			color: choice(COLORS),
		};
	});
}

function stepParticles(particles: Particle[]): void {
	for (const particle of particles) {
		particle.x += particle.vx;
		particle.y += particle.vy;
		particle.vy += 0.095;
		particle.vx *= 0.988;
		particle.vy *= 0.995;
	}
}

class ConfettiOverlay {
	private readonly height = Math.max(12, process.stdout.rows || 24);
	private particles = createParticles(PARTICLE_COUNT, this.height);
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private cachedKey = "";
	private cachedLines: string[] = [];

	constructor(
		private tui: { requestRender: () => void },
		private theme: Theme,
		private done: () => void,
	) {
		this.timer = setInterval(() => {
			this.frame++;
			this.maybeAddFireworkBurst();
			stepParticles(this.particles);
			this.invalidate();
			this.tui.requestRender();
			if (this.frame >= FRAMES) this.close();
		}, FRAME_MS);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") this.close();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const key = `${safeWidth}:${this.frame}`;
		if (key === this.cachedKey) return this.cachedLines;

		const cells = Array.from({ length: this.height }, () => Array.from({ length: safeWidth }, () => " "));

		for (const particle of this.particles) {
			const x = Math.round(particle.x * (safeWidth / BASE_WIDTH));
			const y = Math.round(particle.y);
			if (x >= 0 && x < safeWidth && y >= 0 && y < this.height) {
				cells[y]![x] = ansi(particle.color, particle.char);
			}
		}

		this.center(cells[0]!, this.theme.fg("accent", this.theme.bold(" /confetti ")));
		this.center(cells[this.height - 1]!, this.theme.fg("dim", "Esc/q close"));

		const lines = cells.map((row) => truncateToWidth(row.join(""), safeWidth, ""));
		this.cachedKey = key;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedKey = "";
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private center(row: string[], text: string): void {
		const start = Math.max(0, Math.floor((row.length - visibleWidth(text)) / 2));
		row.splice(start, 1, text);
	}

	private maybeAddFireworkBurst(): void {
		// Fireworks phase: multiple bursts before drag/gravity visibly slow everything.
		if (this.frame > 52) return;
		if (this.frame % 7 !== 0 && Math.random() > 0.18) return;

		const originX = 12 + Math.random() * 76;
		const originY = Math.max(3, Math.random() * this.height * 0.55);
		this.particles.push(...createBurst(BURST_PARTICLES, this.height, originX, originY));

		if (this.particles.length > MAX_PARTICLES) {
			this.particles.splice(0, this.particles.length - MAX_PARTICLES);
		}
	}

	private close(): void {
		this.dispose();
		this.done();
	}
}

export default function confettiExtension(pi: ExtensionAPI) {
	pi.registerCommand("confetti", {
		description: "Show terminal confetti",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ConfettiOverlay(tui, theme, () => done(undefined)), {
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					anchor: "center",
					margin: 0,
				},
			});
		},
	});
}
