/**
 * Windows job objects that hold a command's whole process tree.
 *
 * `taskkill /T` finds a tree by walking the process table, so a process created during the walk, or one whose parent
 * already exited, is missed and keeps running. Every process created inside a job object joins it, detached ones
 * included. These jobs allow no breakaway (Git Bash's runtime leaves any job that allows it), so terminating the job
 * ends all of them at once. There is no kill-on-close: a command that finishes normally leaves its background processes
 * running.
 *
 * koffi (an optional dependency) is loaded on first use. Where it cannot be loaded nothing is contained, and callers
 * keep using taskkill.
 */

import { createRequire } from "node:module";

export interface WindowsProcessJob {
	/** End every process in the job; false when the job could not be terminated. */
	terminate(): boolean;
	/** Release the handle. Processes still in the job keep running. */
	close(): void;
}

type Handle = object | null;

interface Kernel32 {
	createJob(): Handle;
	openProcess(pid: number): Handle;
	assign(job: Handle, process: Handle): boolean;
	terminate(job: Handle, exitCode: number): boolean;
	close(handle: Handle): boolean;
}

/** PROCESS_SET_QUOTA | PROCESS_TERMINATE: the access AssignProcessToJobObject needs. */
const ASSIGN_ACCESS = 0x0101;
/** The exit code `taskkill /F` gives the processes it ends. */
const TERMINATED_EXIT_CODE = 1;

let kernel32: Kernel32 | null | undefined;

function loadKernel32(): Kernel32 | null {
	if (kernel32 !== undefined) return kernel32;
	kernel32 = null;
	if (process.platform !== "win32") return kernel32;
	try {
		const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
		const library = koffi.load("kernel32.dll");
		const createJob = library.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
		const openProcess = library.func("void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
		const assign = library.func("bool __stdcall AssignProcessToJobObject(void *job, void *process)");
		const terminate = library.func("bool __stdcall TerminateJobObject(void *job, uint32 exitCode)");
		const close = library.func("bool __stdcall CloseHandle(void *handle)");
		kernel32 = {
			createJob: () => createJob(null, null),
			openProcess: (pid) => openProcess(ASSIGN_ACCESS, false, pid),
			assign: (job, process) => assign(job, process),
			terminate: (job, exitCode) => terminate(job, exitCode),
			close: (handle) => close(handle),
		};
	} catch {
		// No koffi binary for this platform, or a bundled build without it: callers keep using taskkill.
	}
	return kernel32;
}

/** Put the process `pid` in a new job object of its own; undefined where that is not possible. */
export function createProcessJob(pid: number): WindowsProcessJob | undefined {
	const api = loadKernel32();
	if (!api) return undefined;
	const job = api.createJob();
	if (!job) return undefined;
	const target = api.openProcess(pid);
	const assigned = target !== null && api.assign(job, target);
	if (target) api.close(target);
	if (!assigned) {
		api.close(job);
		return undefined;
	}
	let closed = false;
	return {
		terminate: () => !closed && api.terminate(job, TERMINATED_EXIT_CODE),
		close: () => {
			if (closed) return;
			closed = true;
			api.close(job);
		},
	};
}
