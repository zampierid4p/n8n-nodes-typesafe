import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

const CREDENTIAL = 'typeSafeApi';

/** TypeSafe asks callers to back off on these and retry; everything else is final. */
const RETRYABLE_STATUS_CODES = [429, 529];

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

export class TypeSafe implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TypeSafe',
		name: 'typeSafe',
		icon: 'file:typeSafe.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Ask a TypeSafe System One model typed questions about your data',
		defaults: {
			name: 'TypeSafe',
		},
		inputs: ['main'],
		outputs: ['main'],
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
				displayName: 'Questions',
				name: 'questions',
				placeholder: 'Add Question',
				type: 'fixedCollection',
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
						// Kept in fill-in order rather than alphabetical: Type drives which
						// criteria fields below it are shown, so it has to come before them.
						// eslint-disable-next-line n8n-nodes-base/node-param-fixed-collection-type-unsorted-items
						values: [
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
								displayName: 'Define as JSON',
								name: 'defineAsJson',
								type: 'boolean',
								default: false,
								description:
									'Whether to supply the whole question object as JSON, for structured instructions and criteria',
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
						],
					},
				],
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
							'How many times to retry when TypeSafe returns 429 Too Many Requests or 529 Overloaded. Waits use the retry-after header when present, otherwise exponential backoff.',
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

				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					CREDENTIAL,
					{
						method: 'GET',
						url: `${baseUrl}/models`,
						json: true,
					},
				)) as { models?: Array<{ name: string; description?: string }> } | Array<{
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
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials(CREDENTIAL);
		const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const model = this.getNodeParameter('model', itemIndex) as string;
				const stateType = this.getNodeParameter('stateType', itemIndex) as 'json' | 'text';
				const questionInputs = this.getNodeParameter(
					'questions.question',
					itemIndex,
					[],
				) as QuestionInput[];
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

				if (questionInputs.length === 0) {
					throw new NodeOperationError(this.getNode(), 'Add at least one question', {
						itemIndex,
					});
				}

				const questions: Record<string, Question> = {};
				for (const input of questionInputs) {
					const id = (input.id ?? '').trim();
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

					if (input.defineAsJson === true) {
						let parsed: Question;
						try {
							parsed = (
								typeof input.questionJson === 'string'
									? JSON.parse(input.questionJson)
									: input.questionJson
							) as Question;
						} catch (error) {
							throw new NodeOperationError(
								this.getNode(),
								`Question "${id}" is not valid JSON: ${(error as Error).message}`,
								{ itemIndex },
							);
						}
						if (parsed?.type === undefined || parsed?.instructions === undefined) {
							throw new NodeOperationError(
								this.getNode(),
								`Question "${id}" needs both "type" and "instructions"`,
								{ itemIndex },
							);
						}
						questions[id] = parsed;
						continue;
					}

					const instructions = (input.instructions ?? '').trim();
					if (instructions.length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							`Question "${id}" needs instructions`,
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
						questions[id] = question;
						continue;
					}

					if (type === 'choice') {
						const criteria = parseChoiceCriteria(input.choiceCriteria);
						if (Object.keys(criteria).length < 2) {
							throw new NodeOperationError(
								this.getNode(),
								`Choice question "${id}" needs at least two options`,
								{ itemIndex },
							);
						}
						questions[id] = { type, instructions, criteria };
						continue;
					}

					const levels = nonEmptyLines(input.scoreCriteria);
					if (levels.length < 2) {
						throw new NodeOperationError(
							this.getNode(),
							`Score question "${id}" needs at least two levels`,
							{ itemIndex },
						);
					}
					questions[id] = { type, instructions, criteria: levels };
				}

				const maxRetries = options.maxRetries ?? 3;
				let response: SystemOneResponse | undefined;

				for (let attempt = 0; ; attempt++) {
					const httpResponse = (await this.helpers.httpRequestWithAuthentication.call(
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
					const waitMs =
						Number.isFinite(retryAfter) && retryAfter > 0
							? retryAfter * 1000
							: 2 ** attempt * 500;
					await sleep(waitMs);
				}

				const answers = response.answers ?? {};
				let payload: IDataObject;

				if (options.simplify === true) {
					payload = {};
					for (const [id, answer] of Object.entries(answers)) {
						if (answer.type === 'noul') {
							payload[id] = answer.noul;
						} else if (answer.type === 'choice') {
							payload[id] = answer.choice;
						} else {
							payload[id] = answer.score;
						}
					}
				} else {
					payload = {
						model: response.model,
						answers: answers as unknown as IDataObject,
						usage: response.usage as unknown as IDataObject,
					};
				}

				if (options.outputField) {
					payload = { [options.outputField]: payload };
				}

				returnData.push({ json: payload, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
