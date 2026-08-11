import type { Metadata } from "next";
import type { ReactNode } from "react";
import { auth, signOut } from "../auth";
import "./globals.css";

export const metadata: Metadata = {
	title: "Feedback Loop Dashboard",
	description: "Internal dashboard for the ai-review-bot feedback loop corpus",
};

// Named, module-scope server action instead of an inline closure in the JSX
// below — an inline `action={async () => { "use server"; ... }}` gets a fresh
// function reference on every render. `signOut` itself isn't directly usable
// as a form action: its options parameter isn't FormData-compatible.
async function handleSignOut() {
	"use server";
	await signOut();
}

// Default export, not named -- Next.js App Router requires it for
// layout.tsx's route component, overriding this repo's "no default exports"
// convention for this one file class (page.tsx/layout.tsx only).
export default async function RootLayout({
	children,
}: {
	children: ReactNode;
}) {
	const session = await auth();
	return (
		<html lang="en">
			<body>
				<header
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						padding: "1rem",
						borderBottom: "1px solid #ccc",
					}}
				>
					<strong>Feedback Loop Dashboard</strong>
					{session?.user && (
						<form action={handleSignOut}>
							<span style={{ marginRight: "1rem" }}>
								{session.user.name ?? session.user.email}
							</span>
							<button type="submit">Sign out</button>
						</form>
					)}
				</header>
				<main style={{ padding: "1rem" }}>{children}</main>
			</body>
		</html>
	);
}
