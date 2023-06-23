import { readFile, writeFile } from 'fs/promises';
import {
	type ChatCompletionRequestMessage,
	Configuration,
	type CreateChatCompletionRequest,
	OpenAIApi
} from 'openai';
import { createCondensePrompt, summarizePrompt } from './prompts';
import {
	SlimUtterance,
	TranscribedShow,
	formatAsTranscript,
	formatTime,
	getSlimUtterances
} from '$db/transcripts/utils';
import { encode } from 'gpt-3-encoder';
import { exists } from '$utilities/file_utilities/exists';
import wait from 'waait';
import { Prisma } from '@prisma/client';

export const TOKEN_LIMIT = 16000;
export const COMPLETION_TOKEN_IDEAL = 1500; // how many tokens we should reserve to the completion - otherwise the responses are poor quality
const TOKEN_INPUT_LIMIT = TOKEN_LIMIT - COMPLETION_TOKEN_IDEAL;
export const MODEL = 'gpt-3.5-turbo-16k'; // Was gpt-4 before token limit was increased
export const EMBEDDING_MODEL = 'text-embedding-ada-002';
export const CONDENSE_THRESHOLD = 100;
const configuration = new Configuration({
	apiKey: process.env.OPENAI_API_KEY
});
// import { findSimilarUtterances } from './embeddings';
import { error } from '@sveltejs/kit';
import { AINoteSelect, AIPodcastSummaryResponse } from './queries';
export const openai = new OpenAIApi(configuration);

async function condense(transcript: string, show: TranscribedShow, inputTokensLength: number) {
	console.log(`========== Condensing show ${show.number} ============`);
	// See if we have a condensed transcript already saved to file
	const path = `./deepgram/condensed-healed/${show.number}.json`;
	const localExists = await exists(path);
	// Save existing work to Memory
	let existing: SlimUtterance[] = [];
	if (localExists) {
		const condensedFile = await readFile(path, 'utf-8');
		console.log(`Using local condensed file for ${show.number}`);
		existing = JSON.parse(condensedFile) as SlimUtterance[];
	}

	// Figure out how many hunks we need to split this string into
	const size = encode(transcript).length;
	console.log(`Transcript size: ${size}`);
	console.log(`inputTokensLength size: ${inputTokensLength}`);
	console.log(`Token input limit: ${TOKEN_INPUT_LIMIT}`);
	const factorSmaller = 1 - TOKEN_INPUT_LIMIT / inputTokensLength;
	console.log(`Factor smaller: ${factorSmaller}`);
	// Split the transcript into hunks
	const utteranceFuncs = show.utterances.map((utterance, index) => {
		return async function getCondenseUtterance(): Promise<SlimUtterance> {
			// Check if we already have this utterance condensed
			const existingUtterance = existing.find(
				(eu) => eu.utteranceIndex === utterance.utteranceIndex
			);
			if (existingUtterance) {
				// console.log(utterance.showNumber, utterance.utteranceIndex, `Skipping OpenAI, we already have utterance condensed`);
				return existingUtterance;
			}

			// Wait a random amount of time to avoid rate limiting. Between 0 and 10 seconds
			const waitTime = Math.floor(Math.random() * 10000);
			await wait(waitTime);
			console.time(`Condensing ${index} of ${show.utterances.length}`);
			// If under 50 chars, leave it alone. Return it via a promise
			if (utterance.transcript.length < CONDENSE_THRESHOLD) {
				console.log(`Skipping condensing of ${index} of ${show.utterances.length}`);
				return Promise.resolve(utterance);
			}
			// If it's over 50 chars, condense it via openAI
			const input: CreateChatCompletionRequest = {
				model: MODEL,
				messages: [
					// { "role": "system", "content": `You are a helpful service that condenses text.` },
					{ role: 'system', content: createCondensePrompt(`${Math.floor(factorSmaller * 100)}%`) },
					{ role: 'user', content: utterance.transcript }
				]
				// "max_tokens": size * factorSmaller,
				// "temperature": 0.3
			};
			console.log(`Condensing`, index, `of`, show.utterances.length);
			const completion = await openai.createChatCompletion(input).catch((err) => {
				// Catch the error in transcribing so we can at least save the utterance without the condensed transcript
				console.log(`❗️ Error Condensing`, index, `of`, show.utterances.length);
				console.dir(err.response.data);
				console.dir(err.response.headers);
			});
			const condensed = completion?.data?.choices?.at(0)?.message?.content;
			if (condensed) {
				utterance.condensedTranscript = condensed;
			}
			const smaller = encode(condensed || '').length;
			const original = encode(utterance.transcript).length;
			console.log(
				index,
				'/',
				show.utterances.length,
				`Condensed from ${original} to ${smaller} tokens - ${Math.round(
					(smaller / original) * 100
				)}% of original`
			);
			console.timeEnd(`Condensing ${index} of ${show.utterances.length}`);
			return utterance;
		};
	});
	// Run the functions in parallel
	const utteranceResults = await Promise.allSettled(utteranceFuncs.map((func) => func()));
	console.log('Done condensing');
	// Get the results
	const utterances = utteranceResults
		.filter((result): result is PromiseSettledResult<SlimUtterance> => {
			return result.status === 'fulfilled';
		})
		.map((result) => result.value);

	console.log(`Saving condensed file for ${show.number}`);
	// Write the results to a file
	await writeFile(
		`./deepgram/condensed-healed/${show.number}.json`,
		JSON.stringify(utterances, null, 2)
	);
	return utterances;
}

type GenerateAINotesInput = {
	transcript: Prisma.TranscriptGetPayload<{
		include: {
			utterances: {
				include: {
					transcript: true;
					words: true;
				};
			};
		};
	}>;
	show: Prisma.ShowGetPayload<true>;
};

export async function generate_ai_notes(
	show: Prisma.ShowGetPayload<{
		select: AINoteSelect;
	}>
) {
	const slimUtterance = getSlimUtterances(show.transcript?.utterances || [], show.number);
	const transcript = formatAsTranscript(slimUtterance);
	// See if its over the token limit
	// TODO: move to OpenAI's new functions API
	const input: CreateChatCompletionRequest = {
		model: MODEL,
		messages: [
			{ role: 'system', content: 'You summarize web development podcasts' },
			{
				role: 'user',
				content: 'Syntax is a podcast about web development. Available at https://Syntax.fm'
			},
			{ role: 'user', content: `This episode is #${show.number} entitled ${show.title}` },
			{ role: 'user', content: summarizePrompt },
			{ role: 'user', content: transcript }
		]
	};

	console.log(`Creating AI notes for ${show.number}`);
	const completion = await openai.createChatCompletion(input);
	const maybeJSON = completion.data.choices.at(0)?.message?.content;
	const parsed = JSON.parse(maybeJSON || '') as AIPodcastSummaryResponse;
	return parsed;
}
