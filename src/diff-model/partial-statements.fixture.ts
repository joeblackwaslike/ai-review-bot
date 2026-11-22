type Case = [
	name: string,
	base: string[],
	head: string[],
	claimed: number,
	ext: string,
];

const c = (
	name: string,
	rows: string,
	tail: string,
	claimed = 1,
	ext = "ts",
): Case => {
	const lines = rows.split("|");
	const head = [...lines.slice(0, -1), tail];
	return [
		name,
		lines.map((r) => `-${r}`),
		head.map((r) => `+${r}`),
		claimed,
		ext,
	];
};

/** Statements cut short by the claimed span, whose next line differs between base and head. */
export const partialStatements: Case[] = [
	c(
		"an open call",
		"callSomethingLong(|  argumentOneLongName,|argumentTwo);",
		"argumentThree);",
		2,
	),
	c(
		"a declaration ending in a comma",
		"export const alphaValueLongName = 1,|  b = 2;",
		"  b = 3;",
	),
	c(
		"a line ending in a comparison",
		"const isOverQuotaLimit = userCount >|quota.max;",
		"0;",
	),
	c(
		"an operator before a comment",
		"const resultAlphaBeta = alphaBeta + // x;|  gamma;",
		"  delta;",
	),
	c(
		"an open Python call",
		"result = compute_total_for_order(|    alpha_value,|    beta_value)",
		"    gamma_value)",
		2,
		"py",
	),
	c(
		"a Python line then a deeper line",
		"total_amount_for_user = compute_amount(account)|    nested_line",
		"    other_line",
		1,
		"py",
	),
	c(
		"a statement then an as clause",
		"const modeSetting = readSettingValue(config)|  as const;",
		"  satisfies Mode;",
	),
	c(
		"a statement then a parenthesis",
		"const handlerRef = makeHandlerRef(config)|(extraCall)()",
		"(otherCall)()",
	),
	c(
		"a control header",
		"if (isUserAuthorized(currentUser))|  return grantAccess();",
		"  return denyAccess();",
	),
	c(
		"a flush control header",
		"for (const pendingItem of pendingWorkItems)|handleItem(pendingItem);",
		"dropItem(pendingItem);",
	),
	c(
		"an open template literal",
		"const messageTemplateText = `hello $" + "{userName}|and more`;",
		"and less`;",
	),
	c(
		"an open Python string",
		'message_text_for_user = """hello there friend|more text"""',
		'other text"""',
		1,
		"py",
	),
	c(
		"a decorator",
		"@Component({ selector: 'app-root' })|export class AppComponent {}",
		"export class OtherComponent {}",
	),
	c(
		"a Rust attribute",
		"#[derive(Debug, Clone, PartialEq, Eq)]|struct AlphaThing {}",
		"struct BetaThing {}",
		1,
		"rs",
	),
	c(
		"a lone Markdown fence",
		"```ts|const exampleValue = loadConfig(path);|```",
		"~~~",
		2,
		"md",
	),
];
