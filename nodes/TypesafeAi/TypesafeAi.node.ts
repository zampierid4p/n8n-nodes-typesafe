import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

interface ChatCompletionResponse {
	id?: string;
	model?: string;
	usage?: IDataObject;
	choices?: Array<{
		message?: { content?: string | null };
		finish_reason?: string;
	}>;
}

/** Renders Ajv errors into a single line a model can act on. */
function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
	if (!errors?.length) return 'unknown validation error';
	return errors
		.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
		.join('; ');
}

export class TypesafeAi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Typesafe AI',
		name: 'typesafeAi',
		icon: 'file:typesafeAi.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Call an OpenAI-compatible model and validate its output against a JSON Schema',
		defaults: {
			name: 'Typesafe AI',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'typesafeAiApi',
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
						name: 'Structured Output',
						value: 'structuredOutput',
						description: 'Get a JSON Schema validated object back from the model',
						action: 'Get structured output from a model',
					},
				],
				default: 'structuredOutput',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'gpt-4o-mini',
				required: true,
				description: 'Model ID as exposed by the configured API',
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				description: 'The user message sent to the model',
			},
			{
				displayName: 'Schema Name',
				name: 'schemaName',
				type: 'string',
				default: 'output',
				required: true,
				description: 'Name reported to the API for this schema. Letters, digits and underscores only.',
			},
			{
				displayName: 'JSON Schema',
				name: 'jsonSchema',
				type: 'json',
				typeOptions: { rows: 10 },
				default:
					'{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" },\n    "sentiment": { "type": "string", "enum": ["positive", "neutral", "negative"] }\n  },\n  "required": ["title", "sentiment"],\n  "additionalProperties": false\n}',
				required: true,
				description: 'The schema the model output must satisfy',
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
						typeOptions: { minValue: 0, maxValue: 5 },
						default: 1,
						description:
							'How many times to re-ask the model when its output fails schema validation',
					},
					{
						displayName: 'Max Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 1024,
					},
					{
						displayName: 'Put Output In Field',
						name: 'outputField',
						type: 'string',
						default: '',
						description:
							'Nest the validated object under this field instead of returning it at the item root',
					},
					{
						displayName: 'Return Raw Response',
						name: 'returnRawResponse',
						type: 'boolean',
						default: false,
						description: 'Whether to also include the untouched API response under "_raw"',
					},
					{
						displayName: 'Strict Schema',
						name: 'strict',
						type: 'boolean',
						default: true,
						description:
							'Whether to ask the API to enforce the schema itself. Requires "additionalProperties": false and every property listed in "required".',
					},
					{
						displayName: 'System Prompt',
						name: 'systemPrompt',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 0,
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('typesafeAiApi');
		const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');

		const ajv = new Ajv({ allErrors: true, strict: false });
		addFormats(ajv);

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const model = this.getNodeParameter('model', itemIndex) as string;
				const prompt = this.getNodeParameter('prompt', itemIndex) as string;
				const schemaName = this.getNodeParameter('schemaName', itemIndex) as string;
				const rawSchema = this.getNodeParameter('jsonSchema', itemIndex) as string | IDataObject;
				const options = this.getNodeParameter('options', itemIndex, {}) as {
					maxRetries?: number;
					maxTokens?: number;
					outputField?: string;
					returnRawResponse?: boolean;
					strict?: boolean;
					systemPrompt?: string;
					temperature?: number;
				};

				let schema: IDataObject;
				try {
					schema =
						typeof rawSchema === 'string' ? (JSON.parse(rawSchema) as IDataObject) : rawSchema;
				} catch (error) {
					throw new NodeOperationError(
						this.getNode(),
						`JSON Schema is not valid JSON: ${(error as Error).message}`,
						{ itemIndex },
					);
				}

				let validate: ValidateFunction;
				try {
					validate = ajv.compile(schema);
				} catch (error) {
					throw new NodeOperationError(
						this.getNode(),
						`JSON Schema could not be compiled: ${(error as Error).message}`,
						{ itemIndex },
					);
				}

				const messages: ChatMessage[] = [];
				if (options.systemPrompt) {
					messages.push({ role: 'system', content: options.systemPrompt });
				}
				messages.push({ role: 'user', content: prompt });

				const maxAttempts = (options.maxRetries ?? 1) + 1;
				let validated: unknown;
				let response: ChatCompletionResponse | undefined;
				let lastError = '';

				for (let attempt = 0; attempt < maxAttempts; attempt++) {
					response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'typesafeAiApi',
						{
							method: 'POST',
							url: `${baseUrl}/chat/completions`,
							body: {
								model,
								messages,
								temperature: options.temperature ?? 0,
								max_tokens: options.maxTokens ?? 1024,
								response_format: {
									type: 'json_schema',
									json_schema: {
										name: schemaName,
										schema,
										strict: options.strict ?? true,
									},
								},
							},
							json: true,
						},
					)) as ChatCompletionResponse;

					const content = response.choices?.[0]?.message?.content;
					if (!content) {
						lastError = 'the model returned an empty message';
						continue;
					}

					let parsed: unknown;
					try {
						parsed = JSON.parse(content);
					} catch {
						lastError = 'the model returned content that is not valid JSON';
						messages.push({ role: 'assistant', content });
						messages.push({
							role: 'user',
							content: 'That was not valid JSON. Reply with JSON matching the schema only.',
						});
						continue;
					}

					if (validate(parsed)) {
						validated = parsed;
						break;
					}

					lastError = formatValidationErrors(validate.errors);
					messages.push({ role: 'assistant', content });
					messages.push({
						role: 'user',
						content: `That output failed schema validation: ${lastError}. Reply with corrected JSON matching the schema only.`,
					});
				}

				if (validated === undefined) {
					throw new NodeOperationError(
						this.getNode(),
						`Model output failed schema validation after ${maxAttempts} attempt(s): ${lastError}`,
						{ itemIndex },
					);
				}

				const payload: IDataObject = options.outputField
					? { [options.outputField]: validated as IDataObject }
					: (validated as IDataObject);

				if (options.returnRawResponse) {
					payload._raw = response as IDataObject;
				}

				returnData.push({
					json: payload,
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as JsonObject, { itemIndex });
			}
		}

		return [returnData];
	}
}
