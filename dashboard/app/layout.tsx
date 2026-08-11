import type { Metadata } from "next";
import type { ReactNode } from "react";
import { auth, signOut } from "../auth";
import "./globals.css";

export const metadata: Metadata = {
	title: "Feedback Loop Dashboard",
	description: "Internal dashboard for the ai-review-bot feedback loop corpus",
};

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
						<form
							action={async () => {
								"use server";
								await signOut();
							}}
						>
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
