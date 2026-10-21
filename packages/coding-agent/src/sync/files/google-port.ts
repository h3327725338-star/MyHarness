import type { GoogleDriveClient } from "../google.ts";
import type { WorkspaceFilePort, WorkspaceUploadResume } from "./types.ts";

/**
 * The file channel over the existing Drive client: the same account, token refresh and retry rules, a separate
 * `sync-v1/files` folder and streaming transfers for content. The batch channel is untouched.
 */
export class GoogleWorkspaceFilePort implements WorkspaceFilePort {
	private readonly drive: GoogleDriveClient;

	constructor(drive: GoogleDriveClient) {
		this.drive = drive;
	}

	async ensureSpace(): Promise<void> {
		await this.drive.ensureSpace();
	}

	async listManifests(): Promise<{ name: string; size?: number }[]> {
		const files = await this.drive.list("files");
		return files.map((file) => ({
			name: file.name,
			...(file.size !== undefined ? { size: Number(file.size) } : {}),
		}));
	}

	readManifest(name: string): Promise<Uint8Array | undefined> {
		return this.drive.read("files", name);
	}

	async writeManifest(name: string, data: Uint8Array): Promise<void> {
		await this.drive.write("files", name, data);
	}

	objectExists(hash: string): Promise<boolean> {
		return this.drive.objectExists(hash);
	}

	uploadFile(
		hash: string,
		path: string,
		size: number,
		resume: WorkspaceUploadResume | undefined,
		onProgress?: (sent: number, sessionUri: string) => void,
	): Promise<void> {
		return this.drive.uploadObjectFromFile(hash, path, size, resume, onProgress);
	}

	downloadToFile(
		hash: string,
		tempPath: string,
		offset: number,
		onProgress?: (received: number) => void,
	): Promise<void> {
		return this.drive.downloadObjectToFile(hash, tempPath, offset, onProgress);
	}
}
