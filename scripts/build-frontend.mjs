// Bundles the React frontend with esbuild (no network required).
import { build, context } from "esbuild"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const outdir = path.join(root, "frontend/dist")
fs.mkdirSync(outdir, { recursive: true })
fs.copyFileSync(path.join(root, "frontend/index.html"), path.join(outdir, "index.html"))

// Copy static assets (hero animation frames, images, fonts) from frontend/public.
const publicDir = path.join(root, "frontend/public")
if (fs.existsSync(publicDir)) {
	fs.cpSync(publicDir, outdir, { recursive: true })
	console.log("copied frontend/public -> frontend/dist")
}

const options = {
	entryPoints: [path.join(root, "frontend/src/main.tsx")],
	bundle: true,
	format: "esm",
	target: ["es2022"],
	jsx: "automatic",
	sourcemap: true,
	minify: !process.argv.includes("--watch"),
	outdir,
	entryNames: "app",
	loader: { ".svg": "dataurl" },
	// Root-absolute url() references in CSS are served at runtime from
	// frontend/public (copied to dist above), so esbuild must not resolve them.
	external: ["/assets/*", "/frames/*", "/fonts/*"],
	logLevel: "info",
}

if (process.argv.includes("--watch")) {
	const ctx = await context(options)
	await ctx.watch()
	console.log("watching frontend...")
} else {
	await build(options)
	console.log(`frontend built -> ${path.relative(root, outdir)}`)
}
