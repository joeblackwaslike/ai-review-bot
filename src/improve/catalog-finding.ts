/** A posted finding as the corpus stores it. */
export interface CatalogFinding {
	id: number;
	owner: string;
	repo: string;
	pr: number;
	reviewer: string;
	commentId: number | null;
	path: string | null;
	line: number | null;
	title: string;
	skills: string[];
	postedAt: string;
}
