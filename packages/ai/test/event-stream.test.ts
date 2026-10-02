import { expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

it("drains a buffered burst in order and releases consumed slots", async () => {
	const stream = new EventStream<number, number>(
		() => false,
		(n) => n,
	);
	for (let i = 0; i < 10000; i++) stream.push(i);
	stream.end(42);
	let count = 0;
	for await (const event of stream) expect(event).toBe(count++);
	expect(count).toBe(10000);
	expect(await stream.result()).toBe(42);
	expect((stream as unknown as { queue: unknown[] }).queue).toHaveLength(0);
});

it("preserves undefined events and enqueues new events after a partial drain", async () => {
	const stream = new EventStream<number | undefined, string>(
		() => false,
		() => "done",
	);
	stream.push(undefined);
	stream.push(1);
	const iterator = stream[Symbol.asyncIterator]();
	expect(await iterator.next()).toEqual({ value: undefined, done: false });
	stream.push(2);
	stream.end("done");
	expect(await iterator.next()).toEqual({ value: 1, done: false });
	expect(await iterator.next()).toEqual({ value: 2, done: false });
	expect(await iterator.next()).toEqual({ value: undefined, done: true });
});

it("delivers directly to a waiting consumer and keeps the final event", async () => {
	const stream = new EventStream<number>(
		(n) => n === 2,
		(n) => n,
	);
	const iterator = stream[Symbol.asyncIterator]();
	const waiting = iterator.next();
	stream.push(1);
	expect(await waiting).toEqual({ value: 1, done: false });
	stream.push(2);
	stream.push(3);
	expect(await iterator.next()).toEqual({ value: 2, done: false });
	expect(await iterator.next()).toEqual({ value: undefined, done: true });
	expect(await stream.result()).toBe(2);
});

it("failure discards the buffered tail and rejects result", async () => {
	const stream = new EventStream<number>(
		() => false,
		(n) => n,
	);
	stream.push(1);
	stream.push(2);
	const iterator = stream[Symbol.asyncIterator]();
	await iterator.next();
	const error = new Error("producer failed");
	stream.fail(error);
	expect(await iterator.next()).toEqual({ value: undefined, done: true });
	await expect(stream.result()).rejects.toBe(error);
});
