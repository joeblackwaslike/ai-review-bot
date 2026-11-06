import type {
	ReactionEvidence,
	ReplayFixture,
	Round,
	ThreadEvidence,
} from "./types.js";

export interface FrozenFixture {
	owner: string;
	repo: string;
	pull: number;
	provider: ReplayFixture["provider"];
	author: string;
	rounds: Round[];
	threads: ThreadEvidence[];
	reactions: ReactionEvidence[];
	excluded: { unknownTimestamp: number; later: number };
}

/**
 * The fixture as it stood when round `roundIndex` was submitted. Items stamped after that
 * time are dropped and counted in `excluded.later`; items whose timestamp does not parse
 * are dropped and counted in `excluded.unknownTimestamp`. Replies edited after the cutoff
 * are dropped too. The cutoff round keeps its metadata but not its claims, and threads
 * rooted on a claim of that round or later are dropped. Threads carry no resolution time,
 * so `isResolved` and `isOutdated` are always recomputed as false rather than guessed.
 */
export function freezeFixture(
	fixture: ReplayFixture,
	roundIndex: number,
): FrozenFixture {
	const at = fixture.rounds.find((r) => r.index === roundIndex);
	if (!at) throw new Error(`no round with index ${roundIndex}`);
	const cutoff = Date.parse(at.submittedAt);
	if (Number.isNaN(cutoff))
		throw new Error(`round ${roundIndex} has an unparseable submittedAt`);
	const excluded = { unknownTimestamp: 0, later: 0 };

	const visible = (timestamp: string | null): boolean => {
		if (timestamp === null) return true;
		const t = Date.parse(timestamp);
		if (Number.isNaN(t)) {
			excluded.unknownTimestamp++;
			return false;
		}
		if (t > cutoff) {
			excluded.later++;
			return false;
		}
		return true;
	};

	const rounds: Round[] = [];
	for (const r of fixture.rounds) {
		if (r.index > roundIndex) {
			excluded.later++;
			continue;
		}
		const { trace: _trace, ...rest } = r;
		rounds.push(r.index === roundIndex ? { ...rest, claims: [] } : rest);
	}

	const hiddenRoots = new Set(
		fixture.rounds
			.filter((r) => r.index >= roundIndex)
			.flatMap((r) => r.claims.map((c) => c.commentId)),
	);

	return {
		owner: fixture.owner,
		repo: fixture.repo,
		pull: fixture.pull,
		provider: fixture.provider,
		author: fixture.author,
		rounds,
		threads: fixture.threads
			.filter((t) => {
				if (!hiddenRoots.has(t.commentId)) return true;
				excluded.later++;
				return false;
			})
			.map((t) => ({
				...t,
				isResolved: false,
				isOutdated: false,
				resolvedBy: null,
				replies: t.replies.filter(
					(r) => visible(r.createdAt) && visible(r.editedAt),
				),
			})),
		reactions: fixture.reactions.filter((r) => visible(r.createdAt)),
		excluded,
	};
}
