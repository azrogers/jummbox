/** @format */

import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	build: {
		rollupOptions: {
			input: {
				main: resolve(__dirname, "index.html"),
				player: resolve(__dirname, "player/index.html")
			}
		}
	}
});
