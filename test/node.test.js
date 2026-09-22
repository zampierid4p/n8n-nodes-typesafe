/**
 * Drives the compiled node's execute() against a scripted HTTP helper.
 *
 * Uses node:test and node:assert only, so the package keeps its no-dependency rule.
 * Timers are faked, which lets the retry waits be asserted exactly without the suite
 * spending real seconds asleep.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { TypeSafe } = require('../dist/nodes/TypeSafe/TypeSafe.node.js');

const OK_BODY = {
	model: 'jev-1.13.0',
	answers: { verdict: { type: 'noul', noul: 0.9 } },
	usage: { input_tokens: 10, output_tokens: 0 },
};

const BASE_PARAMS = {
	operation: 'ask',
	outputMode: 'single',
	model: 'jev-latest',
	stateType: 'text',
	stateText: 'state',
	questions: {
		question: [
			{
				id: 'verdict',
				defineAsJson: false,
				type: 'noul',
				instructions: 'instructions',
				criteriaTrue: '',
				criteriaFalse: '',
			},
		],
	},
	options: { maxRetries: 3 },
};

/** A context whose HTTP helper walks a script, recording when each call happened. */
function makeContext(script, overrides = {}) {
	const params = { ...BASE_PARAMS, ...overrides };
	const calls = [];
	return {
		calls,
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'TypeSafe', type: 'n8n-nodes-typesafe.typeSafe', typeVersion: 1 }),
		getCredentials: async () => ({ apiKey: 'test', baseUrl: 'https://api.typesafe.ai/v1' }),
		continueOnFail: () => false,
		getNodeParameter: (name, _itemIndex, fallback) => {
			let node = params;
			for (const key of String(name).split('.')) {
				if (node === undefined || node === null) return fallback;
				node = node[key];
			}
			return node === undefined ? fallback : node;
		},
		helpers: {
			httpRequestWithAuthentication: async () => {
				const step = script[Math.min(calls.length, script.length - 1)];
				calls.push(Date.now());
				if (step.throws) {
					const error = new Error(step.throws.message ?? 'failed');
					if (step.throws.code) error.code = step.throws.code;
					throw error;
				}
				return {
					statusCode: step.status,
					headers: step.headers ?? {},
					body: step.body ?? { error: 'rejected' },
				};
			},
		},
	};
}

/** Lets every pending microtask and macrotask run. setImmediate stays real, so this
 * drains the continuation a faked timer just released before the clock moves again. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

const TICK_MS = 250;

/**
 * Runs execute() under fake timers, advancing the clock until it settles, and returns
 * the outcome together with the virtual gap before each HTTP attempt.
 *
 * Gaps are accurate to within one tick: the clock moves in fixed steps, so a wait that
 * ends mid-step is recorded at the end of that step. Assertions below allow for it.
 */
async function run(t, script, overrides) {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	const context = makeContext(script, overrides);
	let outcome;
	const pending = new TypeSafe().execute
		.call(context)
		.then((data) => ({ ok: true, data }))
		.catch((error) => ({ ok: false, error }))
		.then((result) => {
			outcome = result;
		});

	// Bounded so an unbounded wait fails the test rather than hanging the suite. This is
	// not hypothetical: before the cap, a retry-after of an hour pushed the settle point
	// past any reasonable horizon.
	const HORIZON_MS = 120_000;
	let elapsed = 0;
	while (outcome === undefined && elapsed < HORIZON_MS) {
		await drain();
		if (outcome !== undefined) break;
		t.mock.timers.tick(TICK_MS);
		elapsed += TICK_MS;
	}
	if (outcome === undefined) {
		return { ok: false, timedOut: true, attempts: context.calls.length, waits: [],
			error: new Error(`did not settle within ${HORIZON_MS}ms of virtual time`) };
	}
	await pending;

	const waits = context.calls.slice(1).map((at, i) => at - context.calls[i]);
	return { ...outcome, attempts: context.calls.length, waits };
}

test('returns the answers on the happy path', async (t) => {
	const result = await run(t, [{ status: 200, body: OK_BODY }]);
	assert.equal(result.ok, true);
	assert.equal(result.attempts, 1);
	assert.equal(result.data[0][0].json.answers.verdict.noul, 0.9);
});

test('retries a 429 and honours retry-after', async (t) => {
	const result = await run(t, [
		{ status: 429, headers: { 'retry-after': '2' } },
		{ status: 200, body: OK_BODY },
	]);
	assert.equal(result.ok, true);
	assert.equal(result.attempts, 2);
	assert.ok(
		result.waits[0] >= 2000 && result.waits[0] <= 2000 + TICK_MS,
		`a small retry-after should be obeyed as given, slept ${result.waits[0]}ms`,
	);
});

test('caps a single retry-after rather than sleeping for as long as it says', async (t) => {
	// Regression: a retry-after of one hour previously slept for the full hour, three
	// times over, holding the worker for three hours before succeeding.
	const result = await run(t, [
		{ status: 429, headers: { 'retry-after': '3600' } },
		{ status: 200, body: OK_BODY },
	]);
	assert.equal(result.ok, true);
	assert.equal(result.attempts, 2);
	assert.ok(
		result.waits[0] <= 15_000 + TICK_MS,
		`a single wait should be capped, slept ${result.waits[0]}ms`,
	);
	assert.ok(
		result.waits[0] < 3_600_000,
		'the requested hour should not be slept in full',
	);
});

test('gives up once the retry budget for one item is spent', async (t) => {
	const result = await run(t, [{ status: 429, headers: { 'retry-after': '3600' } }]);
	assert.equal(result.ok, false);
	assert.match(String(result.error.message), /retry budget/i);
	const total = result.waits.reduce((sum, wait) => sum + wait, 0);
	assert.ok(
		total <= 30_000 + TICK_MS,
		`the whole sequence should stay inside the budget, slept ${total}ms`,
	);
});

test('retries a timed out request', async (t) => {
	// Regression: a timeout throws rather than returning a status, so it used to skip
	// the retry loop entirely and fail the item on the first attempt.
	const result = await run(t, [
		{ throws: { code: 'ETIMEDOUT', message: 'socket timeout' } },
		{ status: 200, body: OK_BODY },
	]);
	assert.equal(result.ok, true);
	assert.equal(result.attempts, 2);
});

test('stops retrying a timeout once max retries is reached', async (t) => {
	const result = await run(
		t,
		[{ throws: { code: 'ETIMEDOUT', message: 'socket timeout' } }],
		{ options: { maxRetries: 2 } },
	);
	assert.equal(result.ok, false);
	assert.equal(result.attempts, 3, 'two retries means three attempts in total');
});

test('does not retry a rejection that is not a transport failure', async (t) => {
	const result = await run(t, [{ throws: { message: 'Invalid API key' } }]);
	assert.equal(result.ok, false);
	assert.equal(result.attempts, 1);
});

test('fails when an answer comes back as a different type than the question asked', async (t) => {
	// Regression: dispatching on the type the server declared turned a mismatched
	// response into a silently wrong value, so a downstream numeric comparison on a
	// noul quietly evaluated false against a string.
	const result = await run(t, [
		{
			status: 200,
			body: { ...OK_BODY, answers: { verdict: { type: 'choice', choice: 'wat' } } },
		},
	]);
	assert.equal(result.ok, false);
	assert.match(String(result.error.message), /asked as a noul/i);
});

test('fails when an answer arrives for a question that was not asked', async (t) => {
	const result = await run(t, [
		{
			status: 200,
			body: {
				...OK_BODY,
				answers: { ...OK_BODY.answers, surprise: { type: 'noul', noul: 0.1 } },
			},
		},
	]);
	assert.equal(result.ok, false);
	assert.match(String(result.error.message), /not asked/i);
});

test('retries a timeout raised with axios default code ECONNABORTED', async (t) => {
	// n8n makes requests through axios, which reports a timeout as ECONNABORTED unless
	// clarifyTimeoutError is set. Missing that code, the retry only happened because the
	// message happened to contain the word "timeout".
	const result = await run(t, [
		// No timeout phrase in the message, so only the code can make this retry.
		{ throws: { code: 'ECONNABORTED', message: 'aborted' } },
		{ status: 200, body: OK_BODY },
	]);
	assert.equal(result.ok, true);
	assert.equal(result.attempts, 2);
});

test('retries an axios timeout that carries only its message', async (t) => {
	const result = await run(t, [
		{ throws: { message: 'timeout of 30000ms exceeded' } },
		{ status: 200, body: OK_BODY },
	]);
	assert.equal(result.ok, true);
	assert.equal(result.attempts, 2);
});

// A bare substring match on "network" or "timeout" retried these three times over.
// run() enables fake timers, so each message needs a test of its own.
for (const message of ['Invalid network policy', 'Parameter "timeout" is not allowed']) {
	test(`does not retry a rejection that merely mentions a word: ${message}`, async (t) => {
		const result = await run(t, [{ throws: { message } }]);
		assert.equal(result.ok, false);
		assert.equal(result.attempts, 1, 'should fail fast rather than retry');
	});
}

test('does not retry an execution that was cancelled', async (t) => {
	const result = await run(t, [{ throws: { code: 'ERR_CANCELED', message: 'canceled' } }]);
	assert.equal(result.ok, false);
	assert.equal(result.attempts, 1);
});

test('reports a spent budget without a NaN when there was no retry-after header', async (t) => {
	// With no header the waits come from backoff, and the old message printed the missing
	// header as "retry after NaNs".
	const result = await run(t, [{ status: 529 }], { options: { maxRetries: 10 } });
	assert.equal(result.ok, false);
	const message = String(result.error.message);
	assert.match(message, /retry budget/i);
	assert.doesNotMatch(message, /NaN/);
});

test('does not blame one retry-after when the budget ran out across several', async (t) => {
	// Six waits of 5s spend the 30s budget; no single one exceeded it.
	const result = await run(t, [{ status: 429, headers: { 'retry-after': '5' } }], {
		options: { maxRetries: 10 },
	});
	assert.equal(result.ok, false);
	const message = String(result.error.message);
	assert.match(message, /retry budget/i);
	assert.doesNotMatch(message, /exceeds/i);
	assert.match(message, /last retry-after: 5s/);
});

// Value validation. The type check alone let {"type":"noul","noul":"0.9"} through: the
// right label carrying a string into a downstream numeric comparison, which is the bug in
// #3 reached by a different road. Each case gets its own test because run() enables
// fake timers.

const CHOICE_QUESTIONS = {
	questions: {
		question: [
			{ id: 'verdict', defineAsJson: false, type: 'choice', instructions: 'i', choiceCriteria: 'yes = a\nno = b' },
		],
	},
};
const SCORE_QUESTIONS = {
	questions: {
		question: [
			{ id: 'verdict', defineAsJson: false, type: 'score', instructions: 'i', scoreCriteria: 'Low\nMid\nHigh' },
		],
	},
};
const answering = (verdict) => [{ status: 200, body: { ...OK_BODY, answers: { verdict } } }];

const REJECTED = [
	['a noul with no value', {}, { type: 'noul' }],
	['a noul of null', {}, { type: 'noul', noul: null }],
	['a noul sent as a string', {}, { type: 'noul', noul: '0.9' }],
	['a noul above 1', {}, { type: 'noul', noul: 1.2 }],
	['a choice outside the options asked', CHOICE_QUESTIONS, { type: 'choice', choice: 'maybe' }],
	['a choice that is not a string', CHOICE_QUESTIONS, { type: 'choice', choice: 1 }],
	['a score above the last level', SCORE_QUESTIONS, { type: 'score', score: 3.5 }],
	['a score sent as a string', SCORE_QUESTIONS, { type: 'score', score: '1' }],
];
for (const [label, overrides, verdict] of REJECTED) {
	test(`rejects ${label}`, async (t) => {
		const result = await run(t, answering(verdict), overrides);
		assert.equal(result.ok, false, 'should fail the item rather than emit the value');
		assert.match(String(result.error.message), /without a usable value/);
	});
}

// The other side: validation strict enough to reject good answers would be its own bug.
const ACCEPTED = [
	['a noul of exactly 0', {}, { type: 'noul', noul: 0 }],
	['a noul of exactly 1', {}, { type: 'noul', noul: 1 }],
	['a choice among the options', CHOICE_QUESTIONS, { type: 'choice', choice: 'no', probabilities: {}, confidence: 0.8 }],
	['a score between two levels', SCORE_QUESTIONS, { type: 'score', score: 1.6, legend: {}, probabilities: {}, confidence: 0.7 }],
	['a score on the last level', SCORE_QUESTIONS, { type: 'score', score: 2, legend: {}, probabilities: {}, confidence: 0.9 }],
];
for (const [label, overrides, verdict] of ACCEPTED) {
	test(`accepts ${label}`, async (t) => {
		const result = await run(t, answering(verdict), overrides);
		assert.equal(result.ok, true, result.error && result.error.message);
	});
}
