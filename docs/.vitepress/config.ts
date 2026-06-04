import { defineConfig } from "vitepress";

export default defineConfig({
	title: "ai-review-bot",
	description:
		"Parallel AI code reviews powered by Claude and Codex. Comment /ai-review on any pull request.",
	base: "/ai-review-bot/",
	themeConfig: {
		nav: [
			{ text: "Quick Start", link: "/quick-start" },
			{ text: "How it works", link: "/how-it-works" },
			{ text: "Configuration", link: "/configuration" },
			{ text: "CLI & npm", link: "/cli-and-npm" },
			{
				text: "GitHub",
				link: "https://github.com/joeblackwaslike/ai-review-bot",
			},
		],
		sidebar: [
			{
				text: "Guide",
				items: [
					{ text: "Quick Start", link: "/quick-start" },
					{ text: "How it works", link: "/how-it-works" },
					{ text: "Configuration", link: "/configuration" },
					{ text: "CLI & npm", link: "/cli-and-npm" },
				],
			},
			{
				text: "Reference",
				collapsed: true,
				items: [
					{
						text: "Code Review Skills Research",
						link: "/code-review-skills-research",
					},
					{
						text: "GitHub Review Features",
						link: "/github-code-review-features-bots-should-leverage",
					},
					{
						text: "Post-mortem: OpenSSL PKCS#1",
						link: "/post-mortem-openssl-pkcs1",
					},
				],
			},
		],
		socialLinks: [
			{
				icon: "github",
				link: "https://github.com/joeblackwaslike/ai-review-bot",
			},
		],
		footer: {
			message: "Released under the MIT License.",
			copyright: "Copyright © 2025 Joe Black",
		},
	},
	head: [["meta", { name: "og:type", content: "website" }]],
});
