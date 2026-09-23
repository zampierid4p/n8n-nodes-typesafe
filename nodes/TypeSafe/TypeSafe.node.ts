import type {
	IDataObject,
	INode,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

const CREDENTIAL = 'typeSafeApi';

/** TypeSafe asks callers to back off on these and retry; everything else is final. */
const RETRYABLE_STATUS_CODES = [429, 529];

/**
 * Ceiling on a single retry wait, and on the whole retry sequence for one item.
 * retry-after comes from the API or from any proxy in between, so it is a hint rather
 * than an instruction: a single large header would otherwise hold an n8n worker for as
 * long as it says. Each wait is capped, then trimmed to whatever budget is left, so a
 * retry can come sooner than retry-after asked; once the budget is spent the node stops.
 */
const MAX_RETRY_WAIT_MS = 15_000;
const RETRY_BUDGET_MS = 30_000;

/**
 * Transport failures worth retrying. These never reach the status-code check, because
 * `httpRequestWithAuthentication` throws rather than returning a response when the
 * socket times out or drops, so without this the retry loop is bypassed entirely and a
 * one-off network blip fails the item.
 *
 * Codes are compared exactly. n8n makes requests through axios, whose default code for a
 * timed-out request is ECONNABORTED rather than ETIMEDOUT, so both are listed.
 * ERR_CANCELED is deliberately absent: that is someone stopping the execution, and
 * retrying it would override them.
 */
const RETRYABLE_ERROR_CODES = new Set([
	'ECONNABORTED',
	'ETIMEDOUT',
	'ESOCKETTIMEDOUT',
	'ECONNRESET',
	'ECONNREFUSED',
	'EPIPE',
	'EAI_AGAIN',
	'ENOTFOUND',
	'ERR_NETWORK',
]);

/**
 * Fallback for failures that carry no usable code. Whole phrases rather than words: a
 * bare "timeout" or "network" also matches ordinary rejections that merely mention one.
 */
const RETRYABLE_MESSAGE_PHRASES = [
	'socket hang up',
	// axios: "timeout of 30000ms exceeded"
	'timeout of ',
];

/** Whether a thrown request error looks like a transport failure rather than a rejection. */
function isRetryableTransportError(error: unknown): boolean {
	if (error === null || typeof error !== 'object') return false;
	const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
	const cause =
		candidate.cause !== null && typeof candidate.cause === 'object'
			? (candidate.cause as { code?: unknown; message?: unknown })
			: undefined;

	const codes = [candidate.code, cause?.code].filter(
		(code): code is string => typeof code === 'string',
	);
	if (codes.some((code) => RETRYABLE_ERROR_CODES.has(code))) return true;

	const messages = [candidate.message, cause?.message]
		.filter((message): message is string => typeof message === 'string')
		.map((message) => message.toLowerCase());
	return RETRYABLE_MESSAGE_PHRASES.some((phrase) =>
		messages.some((message) => message.includes(phrase)),
	);
}

type QuestionType = 'choice' | 'noul' | 'score';

type Criteria = string[] | Record<string, string | null> | { true?: string; false?: string };

interface Question {
	type: QuestionType;
	instructions: unknown;
	criteria?: Criteria;
}

interface NoulAnswer {
	type: 'noul';
	noul: number;
}

interface ChoiceAnswer {
	type: 'choice';
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

interface ScoreAnswer {
	type: 'score';
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

interface SystemOneResponse {
	model: string;
	answers: Record<string, Answer>;
	usage: { input_tokens: number; output_tokens: number };
}

/** One entry of the node's "Questions" fixed collection. */
interface QuestionInput {
	id?: string;
	defineAsJson?: boolean;
	questionJson?: string | IDataObject;
	type?: QuestionType;
	instructions?: string;
	criteriaTrue?: string;
	criteriaFalse?: string;
	choiceCriteria?: string;
	scoreCriteria?: string;
}

function nonEmptyLines(value: string | undefined): string[] {
	return (value ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Parses "option = description" lines into the option/rubric map a Choice needs.
 * A line without "=" becomes an option with no extra detail (null).
 */
function parseChoiceCriteria(value: string | undefined): Record<string, string | null> {
	const criteria: Record<string, string | null> = {};
	for (const line of nonEmptyLines(value)) {
		const separator = line.indexOf('=');
		if (separator === -1) {
			criteria[line] = null;
			continue;
		}
		const option = line.slice(0, separator).trim();
		const description = line.slice(separator + 1).trim();
		if (option.length > 0) {
			criteria[option] = description.length > 0 ? description : null;
		}
	}
	return criteria;
}

const QUESTION_TYPES = ['noul', 'choice', 'score'];

/**
 * Why a question definition would be refused, or undefined when it is usable. One set of
 * rules for every way of defining questions -- the fields, one question as JSON, or the
 * whole map as JSON -- so a definition that reaches the API has been held to the same
 * standard whichever way it was written. The value checks on answers rely on it too: an
 * answer can only be tested against the options asked if the options were well formed.
 */
function questionProblem(question: unknown): string | undefined {
	if (question === null || typeof question !== 'object' || Array.isArray(question)) {
		return 'must be an object with "type" and "instructions"';
	}
	const { type, instructions, criteria } = question as {
		type?: unknown;
		instructions?: unknown;
		criteria?: unknown;
	};

	if (typeof type !== 'string' || !QUESTION_TYPES.includes(type)) {
		return `has type ${describeValue(type)}; use noul, choice or score`;
	}
	// The API takes a string, an object or an array here; only an absent or blank one is wrong.
	if (
		instructions === undefined ||
		instructions === null ||
		(typeof instructions === 'string' && instructions.trim().length === 0)
	) {
		return 'needs instructions';
	}

	const isPlainObject =
		criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria);

	if (type === 'choice' && (!isPlainObject || Object.keys(criteria as object).length < 2)) {
		return 'needs "criteria" as an object with at least two options';
	}
	if (type === 'score' && (!Array.isArray(criteria) || criteria.length < 2)) {
		return 'needs "criteria" as an array of at least two levels';
	}
	if (type === 'noul' && criteria !== undefined && !isPlainObject) {
		return 'has "criteria" that is not an object with "true" and/or "false"';
	}
	return undefined;
}

/** How a value is shown in an error: numbers as themselves, so NaN is not rendered as null. */
function describeValue(value: unknown): string {
	if (value === undefined) return 'missing';
	if (typeof value === 'number') return String(value);
	return JSON.stringify(value);
}

/**
 * Why an answer's value cannot be used for the question it answers, or undefined when it
 * can. Checking the declared type alone is not enough: {"type":"noul","noul":"0.9"} has the
 * right label and still puts a string into a downstream numeric comparison, where it
 * quietly evaluates false. A small tolerance absorbs floating-point error at the bounds.
 */
function answerValueProblem(question: Question, answer: Answer): string | undefined {
	const TOLERANCE = 1e-9;

	if (answer.type === 'noul') {
		const value: unknown = answer.noul;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			return `noul is ${describeValue(value)}, not a number`;
		}
		if (value < -TOLERANCE || value > 1 + TOLERANCE) return `noul is ${value}, outside 0 to 1`;
		return undefined;
	}

	if (answer.type === 'choice') {
		const value: unknown = answer.choice;
		if (typeof value !== 'string') return `choice is ${describeValue(value)}, not a string`;
		const criteria = question.criteria;
		if (criteria !== null && typeof criteria === 'object' && !Array.isArray(criteria)) {
			const options = Object.keys(criteria);
			if (options.length > 0 && !options.includes(value)) {
				return `choice "${value}" is not one of the options asked (${options.join(', ')})`;
			}
		}
		return undefined;
	}

	const value: unknown = answer.score;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return `score is ${describeValue(value)}, not a number`;
	}
	// A score is probability-weighted across the levels, so it can fall between two of
	// them but never outside the first and last.
	if (Array.isArray(question.criteria) && question.criteria.length > 0) {
		const top = question.criteria.length - 1;
		if (value < -TOLERANCE || value > top + TOLERANCE) {
			return `score is ${value}, outside the levels 0 to ${top}`;
		}
	}
	return undefined;
}

/**
 * The error to surface for an item. Validation failures and API rejections are already n8n
 * errors carrying their own message, so they pass through unchanged; anything else is
 * wrapped, because a raw error reaching the editor arrives without its HTTP context.
 */
function asNodeError(
	node: INode,
	error: unknown,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeApiError(node, error as JsonObject, { itemIndex });
}

/** The scalar a caller usually wants out of an answer. */
function answerValue(answer: Answer): number | string {
	if (answer.type === 'noul') return answer.noul;
	if (answer.type === 'choice') return answer.choice;
	return answer.score;
}

/**
 * n8n serialises this function into the outputs expression and evaluates it in
 * the editor as well as at runtime, so it must stay pure, self-contained, and
 * free of optional chaining or template literals that would not survive being
 * turned back into source.
 */
/**
 * How many questions a JSON definition holds, or 0 when it cannot be read. The runtime
 * twin of the JSON branch in configuredOutputs: both must reach the same count from the
 * same value, because one draws the outputs and the other fills them.
 */
function countJsonQuestions(value: unknown): number {
	try {
		const parsed = typeof value === 'string' ? JSON.parse(value) : value;
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? Object.keys(parsed).length
			: 0;
	} catch {
		return 0;
	}
}

const configuredOutputs = (parameters: IDataObject) => {
	const single = [{ type: 'main' }];
	if (parameters.outputMode !== 'perQuestion') return single;

	let ids: string[] = [];
	if (parameters.questionsSource === 'json') {
		let parsed: unknown = parameters.questionsJson;
		if (typeof parsed === 'string') {
			// An expression is only resolved when the node runs, so the editor cannot know
			// how many questions it will produce. One output, and a notice says why.
			if (parsed.charAt(0) === '=') return single;
			try {
				parsed = JSON.parse(parsed);
			} catch {
				return single;
			}
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return single;
		ids = Object.keys(parsed as object);
	} else {
		const collection = parameters.questions as IDataObject | undefined;
		const questions =
			collection && Array.isArray(collection.question)
				? (collection.question as IDataObject[])
				: [];
		ids = questions.map((question) => (typeof question.id === 'string' ? question.id.trim() : ''));
	}
	if (ids.length === 0) return single;

	return ids.map((id, index) => {
		const named = id.length > 0 && id.charAt(0) !== '=';
		return { type: 'main', displayName: named ? id : 'Question ' + (index + 1) };
	});
};

export class TypeSafe implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TypeSafe',
		name: 'typeSafe',
		icon: { light: 'file:typeSafe.svg', dark: 'file:typeSafe.dark.svg' },
		group: ['transform'],
		usableAsTool: true,
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Ask a TypeSafe System One model typed questions about your data',
		defaults: {
			name: 'TypeSafe',
		},
		inputs: [NodeConnectionTypes.Main],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
		outputs: `={{(${configuredOutputs})($parameter)}}`,
		credentials: [
			{
				name: CREDENTIAL,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Ask Questions',
						value: 'ask',
						description: 'Evaluate state against typed questions and return one answer each',
						action: 'Ask questions about state',
					},
				],
				default: 'ask',
			},
			{
				displayName: 'Output Mode',
				name: 'outputMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'One Output per Question',
						value: 'perQuestion',
						description:
							'One branch per question, so each judgment can drive its own logic. Still a single API call.',
					},
					{
						name: 'Single Output',
						value: 'single',
						description: 'One item carrying every answer, plus the model and token usage',
					},
				],
				default: 'single',
				description:
					'How the answers leave the node. Adding, removing or reordering questions shifts the branches, and n8n keeps connections by position, so check the wiring afterwards.',
			},
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: 'jev-latest',
				required: true,
				description:
					'Model that answers the questions. The list shows the aliases your account can use; set an expression to pin a versioned ID such as jev-1.13.0. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'State Type',
				name: 'stateType',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'JSON',
						value: 'json',
						description: 'Structured state, for chat logs, records or application state',
					},
					{
						name: 'Text',
						value: 'text',
						description: 'A single block of text',
					},
				],
				default: 'text',
				description: 'Shape of the state the questions are evaluated against',
			},
			{
				displayName: 'State',
				name: 'stateText',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '',
				required: true,
				displayOptions: {
					show: { stateType: ['text'] },
				},
				description: 'The content to evaluate',
			},
			{
				displayName: 'State (JSON)',
				name: 'stateJson',
				type: 'json',
				typeOptions: { rows: 8 },
				default: '{}',
				required: true,
				displayOptions: {
					show: { stateType: ['json'] },
				},
				description: 'The content to evaluate, as a JSON object or array',
			},
			{
				displayName: 'Questions Source',
				name: 'questionsSource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Fields',
						value: 'fields',
						description: 'Add each question with its own fields',
					},
					{
						name: 'JSON',
						value: 'json',
						description:
							'Describe every question in one JSON object, in the same shape as the API questions field',
					},
				],
				default: 'fields',
				description: 'How the questions are described',
			},
			{
				displayName: 'Questions',
				name: 'questions',
				placeholder: 'Add Question',
				type: 'fixedCollection',
				displayOptions: {
					show: { questionsSource: ['fields'] },
				},
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				default: {},
				description:
					'Questions to evaluate against the state. They are sent in one request and answered in parallel, so independent questions belong here rather than in separate nodes.',
				options: [
					{
						name: 'question',
						displayName: 'Question',
						// Alphabetical by displayName, which the n8n community scanner enforces
						// and will not let a disable comment override. Type therefore appears
						// after the criteria fields whose visibility it drives.
						values: [
							{
								displayName: 'Define as JSON',
								name: 'defineAsJson',
								type: 'boolean',
								default: false,
								description:
									'Whether to supply the whole question object as JSON, for structured instructions and criteria',
							},
							{
								displayName: 'ID',
								name: 'id',
								type: 'string',
								default: '',
								required: true,
								description:
									'Key this answer comes back under. It is not sent to the model, so put the full meaning in the instructions.',
							},
							{
								displayName: 'Instructions',
								name: 'instructions',
								type: 'string',
								typeOptions: { rows: 3 },
								default: '',
								displayOptions: {
									show: { defineAsJson: [false] },
								},
								description: 'The judgment the model should make',
							},
							{
								displayName: 'Levels',
								name: 'scoreCriteria',
								type: 'string',
								typeOptions: { rows: 5 },
								default: '',
								displayOptions: {
									show: { defineAsJson: [false], type: ['score'] },
								},
								placeholder: 'Calm',
								description:
									'One level per line, ordered from lowest to highest. Each level should describe a concrete situation. At least two levels are needed.',
							},
							{
								displayName: 'Means No',
								name: 'criteriaFalse',
								type: 'string',
								default: '',
								displayOptions: {
									show: { defineAsJson: [false], type: ['noul'] },
								},
								description: 'What a probability near 0 means',
							},
							{
								displayName: 'Means Yes',
								name: 'criteriaTrue',
								type: 'string',
								default: '',
								displayOptions: {
									show: { defineAsJson: [false], type: ['noul'] },
								},
								description: 'What a probability near 1 means',
							},
							{
								displayName: 'Options',
								name: 'choiceCriteria',
								type: 'string',
								typeOptions: { rows: 5 },
								default: '',
								displayOptions: {
									show: { defineAsJson: [false], type: ['choice'] },
								},
								placeholder: 'billing = Payments, invoicing, refunds',
								description:
									'One option per line, written as "option = description". The description is optional; omit it and just write the option. At least two options are needed.',
							},
							{
								displayName: 'Question (JSON)',
								name: 'questionJson',
								type: 'json',
								typeOptions: { rows: 6 },
								default: '{\n  "type": "noul",\n  "instructions": ""\n}',
								displayOptions: {
									show: { defineAsJson: [true] },
								},
								description:
									'The question object, with type, instructions and criteria as documented for the TypeSafe API',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								options: [
									{
										name: 'Choice',
										value: 'choice',
										description: 'Pick one option from a set you define',
									},
									{
										name: 'Noul',
										value: 'noul',
										description: 'Probability that a yes/no question is yes',
									},
									{
										name: 'Score',
										value: 'score',
										description: 'Rate the state against ordered levels you define',
									},
								],
								default: 'noul',
								displayOptions: {
									show: { defineAsJson: [false] },
								},
								description: 'What kind of answer this question returns',
							},
						],
					},
				],
			},
			{
				displayName: 'Questions (JSON)',
				name: 'questionsJson',
				type: 'json',
				typeOptions: { rows: 14 },
				default:
					'{\n  "is_urgent": {\n    "type": "noul",\n    "instructions": "Does this convey urgency?"\n  },\n  "department": {\n    "type": "choice",\n    "instructions": "Which team should handle this?",\n    "criteria": {\n      "billing": "Payments, invoicing, refunds",\n      "technical": "Bugs, outages, integrations",\n      "sales": null\n    }\n  },\n  "frustration": {\n    "type": "score",\n    "instructions": "How frustrated is the customer?",\n    "criteria": ["Calm", "Frustrated", "Very angry"]\n  }\n}',
				displayOptions: {
					show: { questionsSource: ['json'] },
				},
				description:
					'An object keyed by question ID, each value a question with "type", "instructions" and "criteria" as the TypeSafe API takes them, so questions can be pasted straight from its docs. Can also come from an expression, to ask different questions for each item.',
			},
			{
				displayName:
					'The questions come from an expression, so the node cannot know them until it runs: it uses a single output. Write the JSON in the node to get one output per question.',
				name: 'dynamicJsonNotice',
				type: 'notice',
				default: '',
				// n8n stops checking a show rule as soon as a watched field holds an expression,
				// and displays the parameter. So the JSON field goes last: the output mode and
				// the source are tested first, and the notice appears only when both match.
				displayOptions: {
					show: {
						outputMode: ['perQuestion'],
						questionsSource: ['json'],
						questionsJson: [{ _cnd: { startsWith: '=' } }],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 10 },
						default: 3,
						description:
							'How many times to retry when TypeSafe returns 429 Too Many Requests or 529 Overloaded, or when the request times out or the connection drops. Waits use the retry-after header when present, capped at 15s each, otherwise exponential backoff. Retrying also stops once 30s have been spent waiting on one item, whichever limit comes first.',
					},
					{
						displayName: 'Put Output in Field',
						name: 'outputField',
						type: 'string',
						default: '',
						description: 'Nest the result under this field instead of at the item root',
					},
					{
						displayName: 'Simplify',
						name: 'simplify',
						type: 'boolean',
						default: false,
						description:
							'Whether to return only the answer value per question. This drops the probabilities and confidence that decide whether a judgment is safe to act on.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials(CREDENTIAL);
				const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');

				const response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
					method: 'GET',
					url: `${baseUrl}/models`,
					json: true,
				})) as
					| { models?: Array<{ name: string; description?: string }> }
					| Array<{
							name: string;
							description?: string;
					  }>;

				const models = Array.isArray(response) ? response : (response.models ?? []);

				return models.map((model) => ({
					name: model.name,
					value: model.name,
					description: model.description,
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();

		// The node's shape is fixed by the parameters as they stand in the editor, so
		// the branch count comes from item 0 and stays put for every item.
		const outputMode = this.getNodeParameter('outputMode', 0, 'single') as string;
		const questionsSource = this.getNodeParameter('questionsSource', 0, 'fields') as string;

		// JSON written in the node fixes the questions. JSON from an expression is only known
		// once it runs and may differ per item, so its branches cannot be drawn in advance:
		// the editor shows one output with a notice, and the node runs as Single Output.
		const rawQuestionsJson =
			questionsSource === 'json'
				? this.getNodeParameter('questionsJson', 0, '', { rawExpressions: true })
				: undefined;
		const dynamicJson = typeof rawQuestionsJson === 'string' && rawQuestionsJson.charAt(0) === '=';

		// Must agree exactly with configuredOutputs, which draws the outputs from the same
		// parameters, or items would be sent to outputs that do not exist.
		let branchCount = 0;
		if (outputMode === 'perQuestion' && !dynamicJson) {
			branchCount =
				questionsSource === 'json'
					? countJsonQuestions(this.getNodeParameter('questionsJson', 0, ''))
					: (this.getNodeParameter('questions.question', 0, []) as QuestionInput[]).length;
		}
		const perQuestion = outputMode === 'perQuestion' && branchCount > 0;
		const returnData: INodeExecutionData[][] = perQuestion
			? Array.from({ length: branchCount }, () => [])
			: [[]];

		const credentials = await this.getCredentials(CREDENTIAL);
		const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const model = this.getNodeParameter('model', itemIndex) as string;
				const stateType = this.getNodeParameter('stateType', itemIndex) as 'json' | 'text';
				const questionInputs =
					questionsSource === 'json'
						? []
						: (this.getNodeParameter('questions.question', itemIndex, []) as QuestionInput[]);
				const options = this.getNodeParameter('options', itemIndex, {}) as {
					maxRetries?: number;
					outputField?: string;
					simplify?: boolean;
				};

				let state: unknown;
				if (stateType === 'text') {
					state = this.getNodeParameter('stateText', itemIndex) as string;
				} else {
					const rawState = this.getNodeParameter('stateJson', itemIndex) as string | IDataObject;
					try {
						state = typeof rawState === 'string' ? JSON.parse(rawState) : rawState;
					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							`State is not valid JSON: ${(error as Error).message}`,
							{ itemIndex },
						);
					}
				}

				// Every question is gathered as [id, definition] first, whichever way it was
				// written, and then held to one set of rules below.
				const definitions: Array<[string, unknown]> = [];

				if (questionsSource === 'json') {
					const rawJson = this.getNodeParameter('questionsJson', itemIndex, '') as unknown;
					let parsed: unknown;
					try {
						parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							`Questions (JSON) is not valid JSON: ${(error as Error).message}`,
							{ itemIndex },
						);
					}
					if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
						throw new NodeOperationError(
							this.getNode(),
							'Questions (JSON) must be an object keyed by question ID, like the questions field of the TypeSafe API',
							{ itemIndex },
						);
					}
					definitions.push(...Object.entries(parsed as Record<string, unknown>));
				} else {
					for (const input of questionInputs) {
						const id = input.id ?? '';

						if (input.defineAsJson === true) {
							try {
								definitions.push([
									id,
									typeof input.questionJson === 'string'
										? JSON.parse(input.questionJson)
										: input.questionJson,
								]);
							} catch (error) {
								throw new NodeOperationError(
									this.getNode(),
									`Question "${id.trim()}" is not valid JSON: ${(error as Error).message}`,
									{ itemIndex },
								);
							}
							continue;
						}

						// The field checks keep their own wording, which talks about the fields
						// someone filled in rather than the JSON they never saw.
						const instructions = (input.instructions ?? '').trim();
						if (instructions.length === 0) {
							throw new NodeOperationError(
								this.getNode(),
								`Question "${id.trim()}" needs instructions`,
								{ itemIndex },
							);
						}

						const type = input.type ?? 'noul';

						if (type === 'noul') {
							const question: Question = { type, instructions };
							const meansYes = (input.criteriaTrue ?? '').trim();
							const meansNo = (input.criteriaFalse ?? '').trim();
							if (meansYes.length > 0 || meansNo.length > 0) {
								question.criteria = {
									...(meansYes.length > 0 ? { true: meansYes } : {}),
									...(meansNo.length > 0 ? { false: meansNo } : {}),
								};
							}
							definitions.push([id, question]);
							continue;
						}

						if (type === 'choice') {
							const criteria = parseChoiceCriteria(input.choiceCriteria);
							if (Object.keys(criteria).length < 2) {
								throw new NodeOperationError(
									this.getNode(),
									`Choice question "${id.trim()}" needs at least two options`,
									{ itemIndex },
								);
							}
							definitions.push([id, { type, instructions, criteria }]);
							continue;
						}

						const levels = nonEmptyLines(input.scoreCriteria);
						if (levels.length < 2) {
							throw new NodeOperationError(
								this.getNode(),
								`Score question "${id.trim()}" needs at least two levels`,
								{ itemIndex },
							);
						}
						definitions.push([id, { type, instructions, criteria: levels }]);
					}
				}

				if (definitions.length === 0) {
					throw new NodeOperationError(this.getNode(), 'Add at least one question', {
						itemIndex,
					});
				}

				const questions: Record<string, Question> = {};
				// Question order, which is also branch order when there is one output per question.
				const questionIds: string[] = [];
				for (const [rawId, definition] of definitions) {
					const id = rawId.trim();
					if (id.length === 0) {
						throw new NodeOperationError(this.getNode(), 'Every question needs an ID', {
							itemIndex,
						});
					}
					if (questions[id] !== undefined) {
						throw new NodeOperationError(
							this.getNode(),
							`Duplicate question ID "${id}". Answers are keyed by ID, so each must be unique.`,
							{ itemIndex },
						);
					}
					const problem = questionProblem(definition);
					if (problem !== undefined) {
						throw new NodeOperationError(this.getNode(), `Question "${id}" ${problem}`, {
							itemIndex,
						});
					}
					questions[id] = definition as Question;
					questionIds.push(id);
				}

				const maxRetries = options.maxRetries ?? 3;
				let response: SystemOneResponse | undefined;
				let retryBudgetMs = RETRY_BUDGET_MS;

				/** Sleeps if the budget allows, and reports whether the retry may proceed. */
				const waitBeforeRetry = async (requestedMs: number): Promise<boolean> => {
					const waitMs = Math.min(requestedMs, MAX_RETRY_WAIT_MS, retryBudgetMs);
					if (waitMs <= 0) return false;
					retryBudgetMs -= waitMs;
					await sleep(waitMs);
					return true;
				};

				for (let attempt = 0; ; attempt++) {
					let httpResponse: { statusCode: number; headers: IDataObject; body: unknown };

					try {
						httpResponse = (await this.helpers.httpRequestWithAuthentication.call(
							this,
							CREDENTIAL,
							{
								method: 'POST',
								url: `${baseUrl}/systemone`,
								body: { state, model, questions },
								json: true,
								returnFullResponse: true,
								ignoreHttpStatusErrors: true,
							},
						)) as { statusCode: number; headers: IDataObject; body: unknown };
					} catch (error) {
						// A timed-out or dropped connection throws instead of returning a
						// status, so it has to be caught here to reach the same backoff as a
						// 429. Anything that is not a transport failure is a real rejection
						// and is rethrown untouched.
						if (attempt >= maxRetries || !isRetryableTransportError(error)) {
							throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
						}
						if (!(await waitBeforeRetry(2 ** attempt * 500))) {
							throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
						}
						continue;
					}

					if (httpResponse.statusCode >= 200 && httpResponse.statusCode < 300) {
						response = httpResponse.body as SystemOneResponse;
						break;
					}

					const isRetryable = RETRYABLE_STATUS_CODES.includes(httpResponse.statusCode);
					if (!isRetryable || attempt >= maxRetries) {
						throw new NodeApiError(this.getNode(), httpResponse.body as JsonObject, {
							httpCode: String(httpResponse.statusCode),
							itemIndex,
						});
					}

					const retryAfter = Number(httpResponse.headers?.['retry-after']);
					const requestedMs =
						Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500;

					// Out of budget means stop, and surface the response that caused it rather
					// than a generic timeout, so the cause is visible in the item.
					if (!(await waitBeforeRetry(requestedMs))) {
						throw new NodeApiError(this.getNode(), httpResponse.body as JsonObject, {
							httpCode: String(httpResponse.statusCode),
							itemIndex,
							// waitBeforeRetry only refuses once the budget is spent, so the cause is
							// the sum of the waits rather than any one retry-after, and the header
							// may be absent altogether when the waits came from backoff.
							message: `TypeSafe still answered ${httpResponse.statusCode} after ${attempt + 1} attempt(s), and the ${RETRY_BUDGET_MS / 1000}s retry budget for one item is spent${
								Number.isFinite(retryAfter) && retryAfter > 0
									? ` (last retry-after: ${retryAfter}s)`
									: ''
							}`,
						});
					}
				}

				const answers = response.answers ?? {};

				// Dispatching on the type the server declared would let a mismatched response
				// through as a silently wrong value: a noul answered as a choice reaches a
				// downstream numeric comparison as a string and quietly evaluates false. The
				// node knows what it asked, so a mismatch is an error rather than a value.
				for (const [id, answer] of Object.entries(answers)) {
					const asked = (questions[id] as { type?: string } | undefined)?.type;
					const got = (answer as { type?: string } | undefined)?.type;
					if (asked === undefined) {
						throw new NodeApiError(this.getNode(), answers as unknown as JsonObject, {
							itemIndex,
							message: `TypeSafe answered a question that was not asked: "${id}"`,
						});
					}
					if (got !== asked) {
						throw new NodeApiError(this.getNode(), answers as unknown as JsonObject, {
							itemIndex,
							message: `Question "${id}" was asked as a ${asked} but TypeSafe answered with type "${got ?? 'missing'}"`,
						});
					}
					const problem = answerValueProblem(questions[id], answer as Answer);
					if (problem !== undefined) {
						throw new NodeApiError(this.getNode(), answers as unknown as JsonObject, {
							itemIndex,
							message: `Question "${id}" came back without a usable value: ${problem}`,
						});
					}
				}
				const nest = (value: IDataObject): IDataObject =>
					options.outputField ? { [options.outputField]: value } : value;

				if (perQuestion) {
					// Branch n carries question n, matched by position rather than by id so
					// that an id built from an expression still lands on the right branch.
					for (let branch = 0; branch < branchCount; branch++) {
						const id = questionIds[branch];
						if (id === undefined) continue;

						const answer = answers[id];
						// A question with no answer leaves its branch empty, which stops the
						// downstream nodes on that branch rather than feeding them a blank.
						if (answer === undefined) continue;

						const branchPayload: IDataObject =
							options.simplify === true
								? { [id]: answerValue(answer) }
								: { questionId: id, ...(answer as unknown as IDataObject) };

						returnData[branch].push({
							json: nest(branchPayload),
							pairedItem: { item: itemIndex },
						});
					}
				} else {
					let payload: IDataObject;

					if (options.simplify === true) {
						payload = {};
						for (const [id, answer] of Object.entries(answers)) {
							payload[id] = answerValue(answer);
						}
					} else {
						payload = {
							model: response.model,
							answers: answers as unknown as IDataObject,
							usage: response.usage as unknown as IDataObject,
						};
					}

					returnData[0].push({ json: nest(payload), pairedItem: { item: itemIndex } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					// Same convention as the Switch node: failures leave by the first branch.
					returnData[0].push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw asNodeError(this.getNode(), error, itemIndex);
			}
		}

		return returnData;
	}
}
