import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class TypesafeAiApi implements ICredentialType {
	name = 'typesafeAiApi';

	displayName = 'Typesafe AI API';

	documentationUrl = 'https://github.com/zampierid4p/n8n-nodes-typesafe-ai';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.openai.com/v1',
			required: true,
			description:
				'Base URL of any OpenAI-compatible Chat Completions API (OpenAI, Azure OpenAI, OpenRouter, Ollama, vLLM, ...)',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/models',
		},
	};
}
