import fs from "node:fs";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";

interface JxlDecodeRequest {
	wrapperPath: string;
	inputPath: string;
	outputPath: string;
}

interface JxlDecodeResponse {
	error?: string;
}

function isJxlDecodeRequest(value: unknown): value is JxlDecodeRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.wrapperPath === "string" &&
		typeof record.inputPath === "string" &&
		typeof record.outputPath === "string"
	);
}

const port = parentPort;
if (!port) throw new Error("JPEG XL decoder worker requires parentPort");

port.once("message", (message: unknown) => {
	void (async () => {
		try {
			if (!isJxlDecodeRequest(message)) throw new Error("Invalid JPEG XL decoder request");
			process.argv.splice(
				0,
				process.argv.length,
				process.execPath,
				message.wrapperPath,
				message.inputPath,
				message.outputPath,
			);
			(globalThis as Record<string, unknown>).fetch = undefined;
			console.log = () => undefined;
			console.warn = () => undefined;
			console.error = () => undefined;
			process.stdout.write = (() => true) as typeof process.stdout.write;
			process.stderr.write = (() => true) as typeof process.stderr.write;
			const originalWriteSync = fs.writeSync.bind(fs);
			fs.writeSync = ((fileDescriptor: number, value: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
				if (fileDescriptor === 1 || fileDescriptor === 2) {
					if (typeof value === "string") return Buffer.byteLength(value);
					return typeof args[1] === "number" ? args[1] : value.byteLength;
				}
				return (originalWriteSync as (...parameters: unknown[]) => number)(fileDescriptor, value, ...args);
			}) as typeof fs.writeSync;
			await import(pathToFileURL(message.wrapperPath).href);
			for (let attempt = 0; ; attempt++) {
				try {
					await access(message.outputPath);
					break;
				} catch {
					if (attempt >= 599) throw new Error("JPEG XL 解码器没有生成输出文件");
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			}
			port.postMessage({} satisfies JxlDecodeResponse);
		} catch (error) {
			port.postMessage({
				error: error instanceof Error ? error.message : String(error),
			} satisfies JxlDecodeResponse);
		}
	})();
});
